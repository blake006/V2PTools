'use strict';

/**
 * 系统代理状态机测试
 *  覆盖 6 种状态，重点是以前会被误判成「已关闭」的异常态。
 *
 * 用法: npm run test-proxystate
 */

const assert = require('assert');
const { deriveProxyState, pickRouteMode, STATE_TEXT } = require('../electron/lib/proxyState');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

/** 造一份 gateway.status() */
function gw(opts = {}) {
  return {
    running: !!opts.running,
    port: opts.port === undefined ? 7890 : opts.port,
    node: opts.node || (opts.running ? { id: 'n1', name: 'HK-01', type: 'ss', server: '1.2.3.4', port: 443 } : null),
    routeMode: 'global',
    aliveFlag: opts.aliveFlag,
  };
}

/** 造一份 sysproxy.status() */
function sys(opts = {}) {
  const server = opts.server === undefined ? '' : opts.server;
  return {
    supported: true,
    active: !!opts.active,
    server,
    proxyEnable: opts.proxyEnable === undefined ? (server ? 1 : 0) : opts.proxyEnable,
    backup: opts.backup === undefined ? { createdAt: 1, target: '127.0.0.1:7890' } : opts.backup,
  };
}

console.log('\n系统代理状态机');

/* ---------------- 健康态 ---------------- */

check('内核在跑 + 系统代理指向它 → on', () => {
  assert.strictEqual(deriveProxyState(gw({ running: true }), sys({ server: '127.0.0.1:7890' })), 'on');
});

check('on 状态下 aliveFlag=true 仍是 on', () => {
  assert.strictEqual(deriveProxyState(gw({ running: true, aliveFlag: true }), sys({ server: '127.0.0.1:7890' })), 'on');
});

check('非默认端口也算 on', () => {
  assert.strictEqual(deriveProxyState(gw({ running: true, port: 7897 }), sys({ server: '127.0.0.1:7897' })), 'on');
});

/* ---------------- 关闭态 ---------------- */

check('内核没跑 + 系统代理没开 → off', () => {
  assert.strictEqual(deriveProxyState(gw({ running: false }), sys({ server: '' })), 'off');
});

check('内核没跑 + ProxyEnable=0 → off', () => {
  assert.strictEqual(deriveProxyState(gw({ running: false }), sys({ server: '127.0.0.1:7890', proxyEnable: 0 })), 'off');
});

/* ---------------- 失联（最危险） ---------------- */

check('内核死了但系统代理还指着 7890 → orphan', () => {
  assert.strictEqual(deriveProxyState(gw({ running: false }), sys({ server: '127.0.0.1:7890' })), 'orphan');
});

check('orphan 优先于 foreign（有备份记录时）', () => {
  const st = deriveProxyState(gw({ running: false }), sys({ server: '127.0.0.1:7890', backup: { target: '127.0.0.1:7890' } }));
  assert.strictEqual(st, 'orphan');
});

check('没有备份记录的指向本端口 → foreign（不是我们写的）', () => {
  const st = deriveProxyState(gw({ running: false }), sys({ server: '127.0.0.1:7890', backup: null }));
  assert.strictEqual(st, 'foreign');
});

/* ---------------- 被劫持 ---------------- */

check('内核在跑但系统代理被关掉 → hijacked', () => {
  assert.strictEqual(deriveProxyState(gw({ running: true }), sys({ server: '', proxyEnable: 0 })), 'hijacked');
});

check('内核在跑但系统代理被别人改成别的端口 → hijacked', () => {
  assert.strictEqual(deriveProxyState(gw({ running: true }), sys({ server: '127.0.0.1:8080' })), 'hijacked');
});

check('内核在跑但系统代理指向 PAC 脚本地址 → hijacked', () => {
  assert.strictEqual(deriveProxyState(gw({ running: true }), sys({ server: '127.0.0.1:10809' })), 'hijacked');
});

/* ---------------- 其它程序占用 ---------------- */

check('内核没跑 + 系统代理指向其它地址 → foreign', () => {
  assert.strictEqual(deriveProxyState(gw({ running: false }), sys({ server: '127.0.0.1:8080' })), 'foreign');
});

check('内核没跑 + 指向局域网代理 → foreign', () => {
  assert.strictEqual(deriveProxyState(gw({ running: false }), sys({ server: '192.168.1.10:3128' })), 'foreign');
});

/* ---------------- 启动中 / 无响应 ---------------- */

check('内核在跑、代理指着它，但存活自检失败 → starting', () => {
  const st = deriveProxyState(gw({ running: true, aliveFlag: false }), sys({ server: '127.0.0.1:7890' }));
  assert.strictEqual(st, 'starting');
});

check('aliveFlag 未探测（undefined）时不误判 → on', () => {
  const st = deriveProxyState(gw({ running: true, aliveFlag: undefined }), sys({ server: '127.0.0.1:7890' }));
  assert.strictEqual(st, 'on');
});

/* ---------------- 边界：空对象 ---------------- */

check('null / 空对象不抛异常', () => {
  assert.strictEqual(deriveProxyState(null, null), 'off');
  assert.strictEqual(deriveProxyState({}, {}), 'off');
  assert.strictEqual(deriveProxyState(gw({ running: false }), null), 'off');
});

check('端口为 0 时不把空 server 当成「指向自己」', () => {
  assert.strictEqual(deriveProxyState(gw({ running: false, port: 0 }), sys({ server: '' })), 'off');
});

/* ---------------- 分流方式优先级 ---------------- */

console.log('\n分流方式取值');

check('内核在跑：以内核为准', () => {
  assert.strictEqual(pickRouteMode({ running: true, routeMode: 'proxy-list' }, { routeMode: 'global' }), 'proxy-list');
});

check('【回归】内核没跑：以设置为准，忽略残留值', () => {
  // 关闭代理（内核停了，routeMode 残留 global）后用户改成 bypass-cn
  assert.strictEqual(pickRouteMode({ running: false, routeMode: 'global' }, { routeMode: 'bypass-cn' }), 'bypass-cn');
});

check('【回归】内核没跑且设置为空：退回残留值', () => {
  assert.strictEqual(pickRouteMode({ running: false, routeMode: 'proxy-list' }, {}), 'proxy-list');
});

check('两边都没有 → global', () => {
  assert.strictEqual(pickRouteMode({ running: false }, {}), 'global');
  assert.strictEqual(pickRouteMode(null, null), 'global');
});

check('非法值被忽略，取另一个合法值', () => {
  assert.strictEqual(pickRouteMode({ running: true, routeMode: 'nonsense' }, { routeMode: 'bypass-cn' }), 'bypass-cn');
  assert.strictEqual(pickRouteMode({ running: false, routeMode: 'global' }, { routeMode: 'bad' }), 'global');
});

check('两边都非法 → global', () => {
  assert.strictEqual(pickRouteMode({ running: true, routeMode: 'x' }, { routeMode: 'y' }), 'global');
});

/* ---------------- 文案 ---------------- */

check('6 种状态都有中文文案', () => {
  for (const k of ['off', 'on', 'starting', 'hijacked', 'orphan', 'foreign']) {
    assert.ok(STATE_TEXT[k], `缺少状态文案: ${k}`);
    assert.ok(/系统代理/.test(STATE_TEXT[k]), `${k} 文案不含「系统代理」`);
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
