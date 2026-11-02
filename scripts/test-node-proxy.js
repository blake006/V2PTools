'use strict';

/**
 * 「借道可用节点拉订阅」链路验证
 *
 * 用一个假的 SOCKS5 服务冒充代理节点，让 mihomo 起一个本地端口，
 * 再像主进程那样用 127.0.0.1:<节点端口> 当代理去拉订阅。
 * 验证的是：节点端口确实能当订阅拉取的出口用（订阅站被墙时的最后一条兜底）。
 *
 * 运行：npx electron scripts/test-node-proxy.js
 * （必须在 Electron 主进程跑：fetchSubscription 优先走 net 模块，Node 环境下拿不到）
 */

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const { CoreManager } = require('../electron/lib/core');
const { fetchSubscription } = require('../electron/lib/subscribe');

const BODY = 'proxies:\n  - name: A\n    type: ss\n    server: 1.1.1.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: x\n';

let pass = 0;
let fail = 0;
function check(ok, label, extra) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${extra ? '  ' + extra : ''}`);
}

/* ---------- 订阅服务（HTTP） ---------- */
function startSubServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(BODY);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------- 假 SOCKS5 代理 ---------- */
function startSocks5(targetHost, targetPort) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          buf = buf.subarray(2 + n);
          sock.write(Buffer.from([0x05, 0x00])); // 无需认证
          stage = 1;
          return;
        }
        if (stage === 1) {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let need = 4;
          if (atyp === 1) need = 4 + 4 + 2;
          else if (atyp === 3) need = 4 + 1 + buf[4] + 2;
          else if (atyp === 4) need = 4 + 16 + 2;
          if (buf.length < need) return;
          buf = buf.subarray(need);
          stage = 2;
          const upstream = net.connect(targetPort, targetHost, () => {
            sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (buf.length) upstream.write(buf);
            sock.pipe(upstream);
            upstream.pipe(sock);
          });
          upstream.on('error', () => sock.destroy());
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  console.log('借道可用节点拉订阅');

  const subSrv = await startSubServer();
  const subPort = subSrv.address().port;
  const socks = await startSocks5('127.0.0.1', subPort);
  const socksPort = socks.address().port;

  const coreExe = path.join(__dirname, '..', 'vendor', 'mihomo.exe');
  if (!fs.existsSync(coreExe)) {
    console.log('  … 跳过：未找到 vendor/mihomo.exe');
    app.exit(0);
    return;
  }

  const tmp = path.join(os.tmpdir(), 'v2p-nodeproxy');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const core = new CoreManager({ corePath: coreExe, dataDir: tmp });
  const node = { id: 'test-node', type: 'socks5', server: '127.0.0.1', port: socksPort, conf: { udp: true } };

  try {
    await core.start([node]);
    const port = core.portOf('test-node');
    check(!!port, `内核为节点分配了本地端口 ${port}`);

    const text = await fetchSubscription(`http://127.0.0.1:${subPort}/sub`, {
      proxy: `127.0.0.1:${port}`,
      timeout: 15000,
    });
    check(text.includes('name: A'), '经节点端口成功拉取订阅内容');
  } catch (e) {
    check(false, '经节点端口拉取订阅', e && e.message);
  } finally {
    await core.stop();
    subSrv.close();
    socks.close();
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('测试异常：', e);
    app.exit(1);
  })
);
