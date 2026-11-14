'use strict';

/**
 * 分流模式切换验证（走应用自己的 Gateway 类，不是裸内核）
 *
 * 覆盖用户在界面上会触发的所有路径：
 *   - 三种模式的配置生成（rules / rule-providers 是否对）
 *   - 已开启时切换模式：端口必须不变（系统代理才不用改注册表）
 *   - 切换后新规则是否真的生效（ruleCount 要跟着变）
 *   - 切到 global 后 provider 必须被移除，不能残留
 *   - 来回切换多次仍然正确
 *   - 非法模式要被拒绝
 *
 * 用法: node scripts/verify-route-switch.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { Gateway, ROUTE_MODES, SELF_CHECK_RULES } = require('../electron/lib/gateway');

const CORE = path.join(__dirname, '..', 'vendor', 'mihomo.exe');
const RULES = path.join(__dirname, '..', 'assets', 'rules');

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, detail) {
  pass += 1;
  console.log(`  ✔ ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label, detail) {
  fail += 1;
  failures.push(label);
  console.log(`  ✘ ${label}${detail ? '  ' + detail : ''}`);
}
function eq(label, actual, wanted) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(wanted);
  if (a === w) ok(label, a);
  else bad(label, `期望 ${w}，实际 ${a}`);
}

function httpGet(port, p, timeout = 3000) {
  return new Promise((res) => {
    const q = http.get({ host: '127.0.0.1', port, path: p, timeout }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => res(b));
    });
    q.on('timeout', () => { q.destroy(); res(''); });
    q.on('error', () => res(''));
  });
}

async function providerCounts(ctlPort) {
  const raw = await httpGet(ctlPort, '/providers/rules', 3000);
  try {
    const p = JSON.parse(raw).providers || {};
    const out = {};
    for (const [k, v] of Object.entries(p)) out[k] = Number(v.ruleCount) || 0;
    return out;
  } catch (e) {
    return {};
  }
}

const node = {
  id: 'n1', name: 'TEST-NODE', type: 'socks5', server: '127.0.0.1', port: 9, conf: {},
};

(async () => {
  if (!fs.existsSync(CORE)) {
    console.error('缺少内核 vendor/mihomo.exe');
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2p-switch-'));
  const gw = new Gateway({ corePath: CORE, rulesDir: RULES, dataDir: tmp });

  console.log('分流模式切换验证（应用层 Gateway）');

  /* ---------- 1. 纯配置生成，不启内核 ---------- */
  console.log('\n【配置生成】');

  const cfgGlobal = gw.buildConfig(node, 7890, 7891, { routeMode: 'global' });
  eq('global 规则只有 MATCH,PROXY', cfgGlobal.rules, ['MATCH,PROXY']);
  eq('global 不带 rule-providers', cfgGlobal['rule-providers'], undefined);

  const cfgCn = gw.buildConfig(node, 7890, 7891, { routeMode: 'bypass-cn' });
  eq('bypass-cn 规则顺序', cfgCn.rules, [
    ...SELF_CHECK_RULES,
    'RULE-SET,cn-domain,DIRECT',
    'RULE-SET,cn-cidr,DIRECT',
    'MATCH,PROXY',
  ]);
  eq('bypass-cn 两个 provider', Object.keys(cfgCn['rule-providers'] || {}).sort(), ['cn-cidr', 'cn-domain']);
  eq('cn-domain 行为为 domain', cfgCn['rule-providers']['cn-domain'].behavior, 'domain');
  eq('cn-cidr 行为为 ipcidr', cfgCn['rule-providers']['cn-cidr'].behavior, 'ipcidr');

  const cfgList = gw.buildConfig(node, 7890, 7891, { routeMode: 'proxy-list' });
  eq('proxy-list 规则顺序', cfgList.rules, [...SELF_CHECK_RULES, 'RULE-SET,gfw-domain,PROXY', 'MATCH,DIRECT']);
  eq('proxy-list 只有一个 provider', Object.keys(cfgList['rule-providers'] || {}), ['gfw-domain']);

  const cfgBad = gw.buildConfig(node, 7890, 7891, { routeMode: 'nonsense' });
  eq('未知模式回退到 global', cfgBad.rules, ['MATCH,PROXY']);

  /* ---------- 2. 真启内核，逐模式切换 ---------- */
  console.log('\n【真实切换（端口不变 + 规则热更新）】');

  const started = await gw.start(node, { port: 17890, routeMode: 'bypass-cn' });
  ok('以 bypass-cn 启动', `port=${started.port}`);
  const basePort = started.port;

  const c1 = await providerCounts(gw.ctlPort);
  if (c1['cn-domain'] > 100000 && c1['cn-cidr'] > 9000) ok('bypass-cn provider 就绪', `cn-domain=${c1['cn-domain']} cn-cidr=${c1['cn-cidr']}`);
  else bad('bypass-cn provider 未就绪', JSON.stringify(c1));
  if (gw.rulesReady) ok('rulesReady 标记为真');
  else bad('rulesReady 未置位');

  // → global
  const r1 = await gw.setRouteMode('global');
  if (r1.port === basePort) ok('切到 global 端口不变', `${r1.port}`);
  else bad('切到 global 端口变了', `${basePort} → ${r1.port}`);
  eq('status 反映 global', gw.status().routeMode, 'global');
  eq('global 路由标签', gw.status().routeLabel, ROUTE_MODES.global.label);
  const c2 = await providerCounts(gw.ctlPort);
  eq('global 下没有残留 provider', Object.keys(c2), []);

  // → proxy-list
  const r2 = await gw.setRouteMode('proxy-list');
  if (r2.port === basePort) ok('切到 proxy-list 端口不变', `${r2.port}`);
  else bad('切到 proxy-list 端口变了', `${basePort} → ${r2.port}`);
  const c3 = await providerCounts(gw.ctlPort);
  if (c3['gfw-domain'] > 4000) ok('proxy-list provider 就绪', `gfw-domain=${c3['gfw-domain']}`);
  else bad('proxy-list provider 未就绪', JSON.stringify(c3));
  eq('proxy-list 下不应有 cn-domain', c3['cn-domain'], undefined);

  // → 回到 bypass-cn
  const r3 = await gw.setRouteMode('bypass-cn');
  if (r3.port === basePort) ok('切回 bypass-cn 端口不变', `${r3.port}`);
  else bad('切回 bypass-cn 端口变了', `${basePort} → ${r3.port}`);
  const c4 = await providerCounts(gw.ctlPort);
  if (c4['cn-domain'] > 100000) ok('切回后 cn-domain 重新加载', `${c4['cn-domain']}`);
  else bad('切回后 cn-domain 未加载', JSON.stringify(c4));

  // 幂等：同模式再切一次不应出错
  const r4 = await gw.setRouteMode('bypass-cn');
  if (r4.port === basePort) ok('同模式重复切换无副作用');
  else bad('同模式重复切换导致端口变化');

  // 非法模式
  let rejected = false;
  try {
    await gw.setRouteMode('not-a-mode');
  } catch (e) {
    rejected = true;
  }
  if (rejected) ok('非法模式被拒绝');
  else bad('非法模式未被拒绝');

  // 连续快速切换（模拟用户连点）
  try {
    for (const m of ['global', 'proxy-list', 'bypass-cn', 'global', 'bypass-cn']) {
      // eslint-disable-next-line no-await-in-loop
      await gw.setRouteMode(m);
    }
    const c5 = await providerCounts(gw.ctlPort);
    if (gw.status().routeMode === 'bypass-cn' && c5['cn-domain'] > 100000) ok('连续切换 5 次后状态正确');
    else bad('连续切换后状态异常', JSON.stringify({ mode: gw.status().routeMode, c5 }));
  } catch (e) {
    bad('连续切换抛错', e.message);
  }

  /* ---------- 3. 换节点保持端口 ---------- */
  console.log('\n【换节点】');
  const node2 = { ...node, id: 'n2', name: 'TEST-NODE-2' };
  await gw.switchNode(node2);
  if (gw.port === basePort) ok('换节点后端口不变', `${gw.port}`);
  else bad('换节点后端口变了', `${basePort} → ${gw.port}`);
  eq('换节点后出口更新', gw.status().node.id, 'n2');
  eq('换节点后模式保持', gw.status().routeMode, 'bypass-cn');

  await gw.stop();
  await new Promise((r) => setTimeout(r, 300));

  // 端口释放
  const freed = await new Promise((r) => {
    const s = net.connect({ host: '127.0.0.1', port: basePort });
    s.on('connect', () => { s.destroy(); r(false); });
    s.on('error', () => r(true));
    s.setTimeout(1200, () => { s.destroy(); r(true); });
  });
  if (freed) ok('停止后端口释放');
  else bad('停止后端口仍被占用');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log('失败项: ' + failures.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验证异常:', e.message);
  process.exit(1);
});
