'use strict';

/**
 * 验证 listeners[].proxy 是否真的生效
 *
 * 为什么必须验证：安卓端靠「每个节点一个 listener 端口」做并发测速。
 * 如果 mihomo 忽略 proxy 字段、让 listener 走全局规则，那么所有节点都会
 * 测出主出口的结果 —— 看起来全绿，实际全是错的。这是最危险的静默错误。
 *
 * 判定方法：
 *   节点 A = direct（能通）
 *   节点 B = socks5 指向死端口（必不通）
 *   listener-0 绑 A → 请求应成功
 *   listener-1 绑 B → 请求应失败
 * 若 proxy 被忽略，两者都会走规则 MATCH,A 而全部成功 → 判定失败。
 *
 * 用法：NODE_PATH=../V2PTools/node_modules node scripts/verify-listeners.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

const CORE = process.env.MIHOMO || path.join(__dirname, '..', '..', 'vendor', 'mihomo.exe');

let pass = 0;
let fail = 0;
function ok(l, d) { pass += 1; console.log(`  ✔ ${l}${d ? '  ' + d : ''}`); }
function bad(l, d) { fail += 1; console.log(`  ✘ ${l}${d ? '  ' + d : ''}`); }

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
}

function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

function requestThrough(proxyPort, url, timeout = 6000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: url,
        timeout,
        headers: { Host: u.host, 'User-Agent': 'v2p-probe' }
      },
      (res) => {
        let n = 0;
        res.on('data', (c) => (n += c.length));
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, bytes: n }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

(async () => {
  if (!fs.existsSync(CORE)) {
    console.error('未找到 mihomo：' + CORE);
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2p-listeners-'));

  // 本地 HTTP 服务器：用局域网 IP 访问，避免 127.0.0.1 被特殊处理
  const webPort = await freePort();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello-from-local-server');
  });
  await new Promise((r) => server.listen(webPort, '0.0.0.0', r));
  const ip = lanIp();
  const target = `http://${ip}:${webPort}/`;

  const mixedPort = await freePort();
  const ctlPort = await freePort();
  const p0 = await freePort();
  const p1 = await freePort();
  const deadPort = await freePort(); // 无人监听

  const cfg = {
    'mixed-port': mixedPort,
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': `127.0.0.1:${ctlPort}`,
    'geodata-mode': false,
    tun: { enable: false },
    proxies: [
      { name: 'A-DIRECT', type: 'direct' },
      { name: 'B-DEAD', type: 'socks5', server: '127.0.0.1', port: deadPort }
    ],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['A-DIRECT', 'B-DEAD'] }],
    listeners: [
      { name: 'probe-0', type: 'mixed', port: p0, listen: '127.0.0.1', proxy: 'A-DIRECT' },
      { name: 'probe-1', type: 'mixed', port: p1, listen: '127.0.0.1', proxy: 'B-DEAD' }
    ],
    rules: ['MATCH,PROXY'] // 主出口固定走分组第一个（A-DIRECT）
  };

  fs.writeFileSync(path.join(tmp, 'config.yaml'), yaml.dump(cfg, { lineWidth: 4096 }), 'utf8');
  const out = fs.openSync(path.join(tmp, 'out.log'), 'w');
  const proc = spawn(CORE, ['-d', tmp, '-f', path.join(tmp, 'config.yaml')], { stdio: ['ignore', out, out] });
  fs.closeSync(out);

  console.log('listeners[].proxy 生效性验证');
  console.log(`  目标: ${target}`);

  // 等端口就绪
  await new Promise((r) => setTimeout(r, 2500));

  const r0 = await requestThrough(p0, target);
  const r1 = await requestThrough(p1, target);

  if (r0.ok) ok('listener-0（绑 direct）请求成功', `${r0.bytes}B`);
  else bad('listener-0（绑 direct）请求失败', JSON.stringify(r0));

  if (!r1.ok) ok('listener-1（绑死节点）请求失败', r1.error || 'HTTP ' + r1.status);
  else bad('listener-1（绑死节点）竟然成功 —— proxy 字段可能被忽略', JSON.stringify(r1));

  // 结论
  if (r0.ok && !r1.ok) {
    ok('结论：listeners[].proxy 真实生效，可安全用于并发测速');
  } else {
    bad('结论：listeners[].proxy 未按预期工作，安卓测速需改用 selector 切换');
  }

  proc.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e.message);
  process.exit(1);
});
