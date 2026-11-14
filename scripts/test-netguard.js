'use strict';

/**
 * 网络安全护栏测试（离线，不碰真实注册表）
 *
 * 覆盖：孤儿系统代理 / 归属标记 / 备份还原 / 回环劫持 / 失效 PAC /
 * WinHTTP 残留 / 归属标记清理 / 保护其它代理软件 / 内核错误分级。
 *
 * 用法: npm run test-netguard
 */

const assert = require('assert');
const path = require('path');

const guard = require('../electron/lib/netGuard');
const { scanLog, sanitizeConfig } = require('../electron/lib/coreCompat');
const { sanitizeBypass, DEFAULT_BYPASS } = require('../electron/lib/sysproxy');

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

const VAL = {
  ProxyEnable: 'proxyEnable',
  ProxyServer: 'proxyServer',
  ProxyOverride: 'proxyOverride',
  AutoConfigURL: 'autoConfigUrl',
  AutoDetect: 'autoDetect',
};

/** 假的 SystemProxy：状态存内存，不写注册表 */
class FakeSys {
  constructor(init = {}) {
    this.v = {
      proxyEnable: 0,
      proxyServer: '',
      proxyOverride: 'localhost;127.*;<local>',
      autoConfigUrl: '',
      autoDetect: 1,
      ...init,
    };
    this.owner = null;
    this.backup = null;
    this.calls = [];
  }
  async read() {
    return { ...this.v };
  }
  readBackup() {
    return this.backup;
  }
  async readOwner() {
    return this.owner;
  }
  async status() {
    const cur = await this.read();
    const target = (this.backup && this.backup.target) || (this.owner && this.owner.target) || '';
    return {
      proxyEnable: cur.proxyEnable,
      server: cur.proxyServer,
      active: !!(cur.proxyEnable === 1 && target && cur.proxyServer === target),
      backup: this.backup ? { target: this.backup.target } : null,
      owner: this.owner,
    };
  }
  async setValue(name, type, value) {
    const key = VAL[name];
    if (key) this.v[key] = name === 'ProxyEnable' || name === 'AutoDetect' ? Number(value) : String(value);
    this.calls.push(['set', name, value]);
  }
  async deleteValue(name) {
    const key = VAL[name];
    if (key) this.v[key] = '';
    this.calls.push(['delete', name]);
  }
  async clearOwner() {
    this.owner = null;
    this.calls.push(['clearOwner']);
    return true;
  }
  async refresh() {
    this.calls.push(['refresh']);
    return true;
  }
  async restore() {
    if (this.backup && this.backup.values) Object.assign(this.v, this.backup.values);
    this.v.proxyEnable = 0;
    this.backup = null;
    this.owner = null;
    this.calls.push(['restore']);
    return { ok: true };
  }
  async forceDirect() {
    this.v.proxyEnable = 0;
    if (/^127\.0\.0\.1:789\d$/.test(this.v.proxyServer)) this.v.proxyServer = '';
    this.v.proxyOverride = sanitizeBypass(this.v.proxyOverride);
    this.owner = null;
    this.calls.push(['forceDirect']);
    return true;
  }
}

/** 假的外部命令执行器 */
function makeRunner(opts = {}) {
  const listening = opts.listening || [];
  const winhttp = opts.winhttp || '直接访问(没有代理服务器)。';
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'netstat') {
      const lines = listening.map((p) => `  TCP    127.0.0.1:${p}    0.0.0.0:0    LISTENING    1234`);
      return { ok: true, stdout: lines.join('\r\n'), stderr: '', error: '' };
    }
    if (file === 'netsh') {
      if (args.includes('show')) return { ok: true, stdout: winhttp, stderr: '', error: '' };
      return { ok: true, stdout: '', stderr: '', error: '' };
    }
    return { ok: true, stdout: '', stderr: '', error: '' };
  };
  return { run, calls };
}

const OPT = { preferredPort: 7890, probe: false };

(async () => {
  console.log('网络安全护栏测试\n');

  /* ---------------- 解析工具 ---------------- */
  await check('parseServer 识别本地地址', () => {
    assert.strictEqual(guard.parseServer('127.0.0.1:7890').port, 7890);
    assert.strictEqual(guard.parseServer('127.0.0.1:7890').local, true);
    assert.strictEqual(guard.parseServer('http=127.0.0.1:7890').port, 7890);
    assert.strictEqual(guard.parseServer('proxy.example.com:8080').local, false);
  });
  await check('parseWinhttp 识别中英文输出', () => {
    assert.strictEqual(guard.parseWinhttp('直接访问(没有代理服务器)。').enabled, false);
    assert.strictEqual(guard.parseWinhttp('Direct access (no proxy server).').enabled, false);
    assert.strictEqual(guard.parseWinhttp('当前的 WinHTTP 代理服务器设置:\n    代理服务器 : 127.0.0.1:7890').server, '127.0.0.1:7890');
  });

  /* ---------------- 健康态 ---------------- */
  await check('系统代理关闭且无标记 → 无告警', async () => {
    const sys = new FakeSys();
    const { run } = makeRunner();
    const r = await guard.inspect(sys, { ...OPT, run });
    assert.strictEqual(r.findings.length, 0, r.summary);
  });
  await check('内核在跑、代理指向活端口 → 无告警', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:7890' });
    sys.owner = { target: '127.0.0.1:7890' };
    const { run } = makeRunner({ listening: [7890, 7891] });
    const r = await guard.inspect(sys, { ...OPT, run, gatewayRunning: true, gatewayPort: 7890 });
    assert.ok(!r.findings.some((f) => f.id === 'orphan-wininet'), r.summary);
  });

  /* ---------------- ⑥ 断网机制：核心场景 ---------------- */
  await check('孤儿系统代理（备份已丢，仅剩归属标记）→ 判定 critical', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:7890' });
    sys.owner = { target: '127.0.0.1:7890' };
    const { run } = makeRunner();
    const r = await guard.inspect(sys, { ...OPT, run });
    assert.ok(r.findings.some((f) => f.id === 'orphan-wininet' && f.level === 'critical'));
  });
  await check('无备份的孤儿代理 → 修复走 forceDirect 并清标记', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:7890' });
    sys.owner = { target: '127.0.0.1:7890' };
    const { run } = makeRunner();
    const r = await guard.repair(sys, { ...OPT, run });
    assert.ok(sys.calls.some((c) => c[0] === 'forceDirect'), '没有走 forceDirect');
    assert.strictEqual(sys.v.proxyEnable, 0);
    assert.strictEqual(sys.owner, null);
    assert.ok(r.ok, r.summary);
  });
  await check('有备份的孤儿代理 → 修复完整还原原始设置', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:7890' });
    sys.backup = { target: '127.0.0.1:7890', values: { proxyEnable: 0, proxyServer: '10.0.0.1:3128', proxyOverride: 'x' } };
    const { run } = makeRunner();
    const r = await guard.repair(sys, { ...OPT, run });
    assert.ok(sys.calls.some((c) => c[0] === 'restore'), '没有走 restore');
    assert.strictEqual(sys.v.proxyServer, '10.0.0.1:3128');
    assert.ok(r.ok, r.summary);
  });
  await check('其它代理软件的死端口不被误伤（非本工具地址）', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:45809' });
    const { run } = makeRunner();
    const r = await guard.inspect(sys, { ...OPT, run });
    assert.ok(!r.findings.some((f) => f.id === 'orphan-wininet'), '误判了别的代理工具');
  });
  await check('端口仍有程序监听时不判孤儿', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:7890' });
    sys.owner = { target: '127.0.0.1:7890' };
    const { run } = makeRunner({ listening: [7890] });
    const r = await guard.inspect(sys, { ...OPT, run });
    assert.ok(!r.findings.some((f) => f.id === 'orphan-wininet'));
  });

  /* ---------------- ⑤ 兼容情况 / ② 代理逻辑 ---------------- */
  await check('<-loopback> 被判为回环劫持并自动清洗', async () => {
    const sys = new FakeSys({ proxyOverride: 'localhost;<-loopback>;127.*' });
    const { run } = makeRunner();
    const before = await guard.inspect(sys, { ...OPT, run });
    assert.ok(before.findings.some((f) => f.id === 'loopback-hijack'));
    const r = await guard.repair(sys, { ...OPT, run });
    assert.ok(!/<-loopback>/i.test(sys.v.proxyOverride));
    assert.ok(sys.v.proxyOverride.includes('127.*'), '清洗时把用户原有条目弄丢了');
    assert.ok(r.ok);
  });
  await check('失效的本地 PAC 被识别并清除', async () => {
    const sys = new FakeSys({ autoConfigUrl: 'http://127.0.0.1:7890/pac' });
    const { run } = makeRunner();
    const before = await guard.inspect(sys, { ...OPT, run });
    assert.ok(before.findings.some((f) => f.id === 'stale-pac'));
    await guard.repair(sys, { ...OPT, run });
    assert.strictEqual(sys.v.autoConfigUrl, '');
  });
  await check('用户自己的本地 PAC 不被误删', async () => {
    const sys = new FakeSys({ autoConfigUrl: 'http://127.0.0.1:18080/company.pac' });
    const { run } = makeRunner();
    const before = await guard.inspect(sys, { ...OPT, run });
    assert.ok(!before.findings.some((f) => f.id === 'stale-pac'), '把别人的 PAC 当成残留了');
    await guard.repair(sys, { ...OPT, run });
    assert.strictEqual(sys.v.autoConfigUrl, 'http://127.0.0.1:18080/company.pac');
  });
  await check('WinHTTP 残留指向死端口 → 复位', async () => {
    const sys = new FakeSys({ proxyEnable: 1, proxyServer: '127.0.0.1:7890' });
    sys.owner = { target: '127.0.0.1:7890', winhttp: true };
    const { run, calls } = makeRunner({ winhttp: '当前的 WinHTTP 代理服务器设置:\n    代理服务器 : 127.0.0.1:7890' });
    const before = await guard.inspect(sys, { ...OPT, run });
    assert.ok(before.findings.some((f) => f.id === 'orphan-winhttp'));
    await guard.repair(sys, { ...OPT, run });
    assert.ok(calls.some((c) => c[1] === 'winhttp' && c[2] === 'reset'), '没有执行 netsh winhttp reset');
  });
  await check('归属标记与现状不符 → 清理', async () => {
    const sys = new FakeSys();
    sys.owner = { target: '127.0.0.1:7890' };
    const { run } = makeRunner();
    const before = await guard.inspect(sys, { ...OPT, run });
    assert.ok(before.findings.some((f) => f.id === 'stale-owner'));
    await guard.repair(sys, { ...OPT, run });
    assert.strictEqual(sys.owner, null);
  });
  await check('修复后刷新 DNS 缓存', async () => {
    const sys = new FakeSys({ proxyOverride: 'localhost;<-loopback>' });
    const { run, calls } = makeRunner();
    await guard.repair(sys, { ...OPT, run });
    assert.ok(calls.some((c) => c[0] === 'ipconfig' && c[1] === '/flushdns'));
  });

  /* ---------------- ① 联网逻辑 / ⑦ 自检机制 ---------------- */
  await check('体检报告含当前设置与诊断字段', async () => {
    const sys = new FakeSys();
    const { run } = makeRunner({ listening: [7890] });
    const r = await guard.inspect(sys, { ...OPT, run });
    assert.ok(Array.isArray(r.findings));
    assert.ok(Array.isArray(r.listening));
    assert.ok('direct' in r && 'loopbackOk' in r && 'winhttp' in r);
    assert.ok(typeof r.summary === 'string' && r.summary.length);
  });

  /* ---------------- 内核兼容层 ---------------- */
  await check('废弃字段提示不算致命错误', () => {
    const r = scanLog(
      'level=error msg="The `global-client-fingerprint` configuration is removed, please set `client-fingerprint` directly on the proxy instead"\n' +
        'level=info msg="RESTful API listening at: 127.0.0.1:7891"'
    );
    assert.strictEqual(r.fatal.length, 0);
    assert.strictEqual(r.harmless.length, 1);
    assert.strictEqual(r.listening.length, 1);
  });
  await check('真正的配置解析错误被判为致命', () => {
    const r = scanLog('level=error msg="yaml: unmarshal errors: cannot unmarshal !!str into int"');
    assert.strictEqual(r.fatal.length, 1);
  });
  await check('sanitizeConfig 只删顶层废弃字段', () => {
    const cfg = { 'global-client-fingerprint': 'chrome', proxies: [{ name: 'p', 'client-fingerprint': 'chrome' }] };
    const r = sanitizeConfig(cfg);
    assert.ok(!('global-client-fingerprint' in r.config));
    assert.strictEqual(r.config.proxies[0]['client-fingerprint'], 'chrome');
    assert.deepStrictEqual(r.removed, ['global-client-fingerprint']);
  });
  await check('默认绕过列表不含 <-loopback> 且含 IPv6 回环', () => {
    assert.ok(!/<-loopback>/i.test(DEFAULT_BYPASS));
    assert.ok(DEFAULT_BYPASS.includes('[::1]'));
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})();
