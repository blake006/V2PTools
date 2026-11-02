'use strict';

/**
 * 订阅拉取回归测试（在 Electron 主进程里跑，才能用到 net 模块）
 *
 * 覆盖：
 *  1) 直连能拿到内容
 *  2) 指定代理时确实走了代理（本地起一个记录命中的 HTTP 代理）
 *  3) 目标不可达时报错包含「超时」，且提示尝试过代理
 *  4) normalizeProxy 的几种写法
 *
 * 注意：Chromium 会强制绕过 127.0.0.1 的代理，所以用 host-resolver-rules
 * 把 sub.test 映射到 127.0.0.1，模拟一个「真实域名」的订阅站。
 *
 * 运行：electron scripts/test-subscribe.js
 */

const http = require('http');
const { app } = require('electron');
const { fetchSubscription, fetchWithNet, normalizeProxy, detectLocalProxy } = require('../electron/lib/subscribe');

app.commandLine.appendSwitch('host-resolver-rules', 'MAP sub.test 127.0.0.1');

const PAYLOAD = `proxies:
  - name: 测试节点
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: test
`;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function main() {
  // 目标站
  const target = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    res.end(PAYLOAD);
  });
  const targetPort = target.port;

  // 极简正向代理：Chromium 对 http 目标会发 absolute-URI 请求
  let proxyHits = 0;
  const proxy = await listen((req, res) => {
    proxyHits += 1;
    const raw = req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`;
    const u = new URL(raw);
    const up = http.request(
      {
        host: '127.0.0.1', // 测试环境：sub.test 只在 Chromium 里被映射，Node 侧直接连回本机
        port: u.port || targetPort,
        path: u.pathname + u.search,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });

  const url = `http://sub.test:${targetPort}/sub`;

  console.log('订阅拉取');

  // 1) 直连
  const direct = await fetchSubscription(url, { timeout: 8000 });
  ok('直连返回内容', direct.includes('测试节点'));

  // 2) 走代理
  proxyHits = 0;
  const proxied = await fetchWithNet(url, 8000, `127.0.0.1:${proxy.port}`);
  ok('代理传输可用（代理被命中）', proxied.includes('测试节点') && proxyHits > 0, `hits=${proxyHits}`);

  // 竞速入口也要能拿到内容
  const viaProxy = await fetchSubscription(url, { proxy: `127.0.0.1:${proxy.port}`, timeout: 8000 });
  ok('fetchSubscription 带代理返回内容', viaProxy.includes('测试节点'));

  // 3) 超时：起一个只接连接、永不响应的服务，稳定复现「拉取超时」
  const hang = await listen(() => {
    /* 故意不响应 */
  });
  let timeoutErr = null;
  try {
    await fetchWithNet(`http://sub.test:${hang.port}/hang`, 1500, `127.0.0.1:${proxy.port}`);
  } catch (e) {
    timeoutErr = e;
  }
  ok('无响应时报超时', !!timeoutErr && /超时/.test(timeoutErr.message), timeoutErr && timeoutErr.message);

  // 4) 全部失败时错误信息要说明尝试过代理（用会立刻被拒的端口，避免测试久等）
  let err = null;
  try {
    await fetchSubscription(`http://sub.test:1/sub`, { proxy: `127.0.0.1:${proxy.port}`, timeout: 3000 });
  } catch (e) {
    err = e;
  }
  ok('不可达时抛错', !!err);
  ok('错误信息说明尝试过代理', !!err && /已尝试代理/.test(err.message), err && err.message);

  // 5) 代理地址规范化
  ok('端口简写补 127.0.0.1', normalizeProxy('7890') === '127.0.0.1:7890');
  ok('带 scheme 去掉', normalizeProxy('http://127.0.0.1:7890') === '127.0.0.1:7890');
  ok('空值保持空', normalizeProxy('  ') === '');

  // 6) 本机代理端口探测（首次使用自动借用）
  ok('detectLocalProxy 能发现监听端口', (await detectLocalProxy([target.port])) === target.port);
  ok('detectLocalProxy 无监听返回 0', (await detectLocalProxy([1])) === 0);

  // 7) 直连失败时，提示检测到的本机代理端口
  let hintErr = null;
  try {
    await fetchSubscription('http://sub.test:1/sub', { timeout: 2000, proxyCandidates: [proxy.port] });
  } catch (e) {
    hintErr = e;
  }
  ok(
    '失败时提示检测到的本机端口',
    !!hintErr && new RegExp(`127\\.0\\.0\\.1:${proxy.port} 有代理在监听`).test(hintErr.message),
    hintErr && hintErr.message
  );

  target.srv.close();
  hang.srv.closeAllConnections();
  hang.srv.close();
  proxy.srv.close();

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('测试异常：', e);
    app.exit(1);
  })
);
