'use strict';

/**
 * 系统代理网关测试
 *  - 配置生成（单节点、MATCH 规则、conf 字段不越权覆盖）
 *  - 端口选择（占用时自动顺延）
 *  - 若已下载 vendor/mihomo.exe：真实启动内核 + 校验 mixed 端口可连 + 停止后端口释放
 *
 * 用法: npm run test-gateway
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { Gateway, pickPort } = require('../electron/lib/gateway');
const { isPortFree } = require('../electron/lib/core');

const CORE = path.join(__dirname, '..', 'vendor', 'mihomo.exe');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v2p-gateway-'));

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

function listenDummy() {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.destroy());
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function tcpAlive(port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

(async () => {
  console.log('系统代理网关测试\n');

  const gw = new Gateway({ corePath: CORE, dataDir: TMP_DIR });

  /* ---------------- 1. 配置生成 ---------------- */
  const node = {
    id: 'n1',
    name: '香港 01',
    type: 'vmess',
    server: 'hk.example.com',
    port: 443,
    conf: {
      uuid: '11111111-2222-3333-4444-555555555555',
      alterId: 0,
      cipher: 'auto',
      tls: true,
      servername: 'hk.example.com',
      network: 'ws',
      'ws-opts': { path: '/ray', headers: { Host: 'hk.example.com' } },
      udp: true,
    },
  };

  const cfg = gw.buildConfig(node, 7890, 7891);

  await check('mixed-port 使用指定端口', () => assert.strictEqual(cfg['mixed-port'], 7890));
  await check('只生成一个代理', () => assert.strictEqual(cfg.proxies.length, 1));
  await check('代理名固定为 PROXY', () => assert.strictEqual(cfg.proxies[0].name, 'PROXY'));
  await check('代理字段来自节点模型', () => {
    assert.strictEqual(cfg.proxies[0].type, 'vmess');
    assert.strictEqual(cfg.proxies[0].server, 'hk.example.com');
    assert.strictEqual(cfg.proxies[0].port, 443);
  });
  await check('节点参数完整透传', () => {
    assert.strictEqual(cfg.proxies[0].uuid, node.conf.uuid);
    assert.strictEqual(cfg.proxies[0]['ws-opts'].path, '/ray');
    assert.strictEqual(cfg.proxies[0].udp, true);
  });
  await check('全局走代理', () => assert.deepStrictEqual(cfg.rules, ['MATCH,PROXY']));
  await check('TUN 关闭（只做系统代理，不接管全局流量）', () => assert.strictEqual(cfg.tun.enable, false));
  await check('不允许局域网连接', () => assert.strictEqual(cfg['allow-lan'], false));
  await check('DNS 开启', () => assert.strictEqual(cfg.dns.enable, true));

  /* ---------------- 2. conf 残留字段不越权 ---------------- */
  const dirty = {
    id: 'n2',
    type: 'trojan',
    server: 'real.example.com',
    port: 8443,
    conf: { name: 'hijack', type: 'http', server: '1.2.3.4', port: 1, password: 'pwd' },
  };
  const cfg2 = gw.buildConfig(dirty, 8000, 8001);

  await check('conf 里的 name 不覆盖 PROXY', () => assert.strictEqual(cfg2.proxies[0].name, 'PROXY'));
  await check('conf 里的 type 不覆盖节点协议', () => assert.strictEqual(cfg2.proxies[0].type, 'trojan'));
  await check('conf 里的 server 不覆盖节点地址', () => assert.strictEqual(cfg2.proxies[0].server, 'real.example.com'));
  await check('conf 里的 port 不覆盖节点端口', () => assert.strictEqual(cfg2.proxies[0].port, 8443));
  await check('conf 里其它字段正常保留', () => assert.strictEqual(cfg2.proxies[0].password, 'pwd'));

  /* ---------------- 3. 端口选择 ---------------- */
  await check('pickPort 返回可用端口', async () => {
    const p = await pickPort(17890);
    assert.strictEqual(await isPortFree(p), true);
  });

  await check('端口被占用时自动顺延', async () => {
    const srv = await listenDummy();
    const busy = srv.address().port;
    const p = await pickPort(busy);
    srv.close();
    assert.notStrictEqual(p, busy);
    assert.ok(p > busy && p < busy + 200);
  });

  /* ---------------- 4. 真实内核启动 ---------------- */
  if (!fs.existsSync(CORE)) {
    console.log('\n  skip 真实启动测试（缺少 vendor/mihomo.exe，先执行 npm run fetch-core）');
  } else {
    const dummy = await listenDummy();
    const testNode = {
      id: 't1',
      name: '本地假节点',
      type: 'socks5',
      server: '127.0.0.1',
      port: dummy.address().port,
      conf: { udp: true },
    };

    let started = null;
    let startErr = null;
    try {
      started = await gw.start(testNode, { port: 17900 });
    } catch (err) {
      startErr = err;
    }

    await check('内核启动成功', () => {
      if (startErr) throw startErr;
      assert.ok(started && started.port);
    });

    if (started) {
      await check('mixed 端口可连接', async () => assert.strictEqual(await tcpAlive(gw.port), true));
      await check('状态为运行中', () => assert.strictEqual(gw.status().running, true));
      await check('状态里带当前节点', () => assert.strictEqual(gw.status().node.id, 't1'));
      await check('配置文件已落盘', () => assert.ok(fs.existsSync(gw.configPath)));

      const proxiesOk = await new Promise((resolve) => {
        const http = require('http');
        const req = http.get({ host: '127.0.0.1', port: gw.ctlPort, path: '/proxies', timeout: 3000 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const data = JSON.parse(body).proxies || {};
              resolve(!!data.PROXY && data.PROXY.type === 'Socks5');
            } catch (e) {
              resolve(false);
            }
          });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.on('error', () => resolve(false));
      });
      await check('内核已加载 PROXY 出口', () => assert.strictEqual(proxiesOk, true));

      await gw.stop();
      await check('停止后进程退出', () => assert.strictEqual(gw.status().running, false));
      await check('停止后端口释放', async () => assert.strictEqual(await isPortFree(started.port), true));
    }

    dummy.close();
  }

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常:', err);
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) {}
  process.exit(1);
});
