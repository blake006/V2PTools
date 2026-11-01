'use strict';

/**
 * 安卓配置生成器测试
 *
 * 关键验证点：mihomo 是否接受 `listeners[].proxy` 字段。
 * 安卓端靠它为每个节点开独立端口做并发测速；如果内核不认这个字段，
 * 测速会把所有节点都测成「主出口」的结果 —— 静默错误，必须提前发现。
 *
 * 用法（在桌面项目目录下执行，借用它的 js-yaml 与内核）：
 *   NODE_PATH=../V2PTools/node_modules node scripts/test-config.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const GEN_PATH = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'web', 'vendor', 'configgen.js');
const RULES_DIR = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'rules');
const CORE = process.env.MIHOMO || path.join(__dirname, '..', '..', 'vendor', 'mihomo.exe');

const gen = require(GEN_PATH);

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

const sampleNodes = [
  { id: 'a', name: 'HK-01', type: 'ss', server: '1.2.3.4', port: 443, conf: { cipher: 'aes-128-gcm', password: 'x' } },
  { id: 'b', name: 'JP-02', type: 'trojan', server: '5.6.7.8', port: 443, conf: { password: 'y', sni: 'a.com' } },
  { id: 'c', name: 'HK-01', type: 'ss', server: '9.9.9.9', port: 8443, conf: { cipher: 'aes-256-gcm', password: 'z' } },
];

console.log('安卓配置生成器');

/* ---------- 结构 ---------- */
const built = gen.buildMihomoConfig({
  nodes: sampleNodes,
  routeMode: 'bypass-cn',
  mixedPort: 7890,
  ctlPort: 9090,
  listenerBase: 20000,
});

eq('节点名去重（重名加后缀）', built.names, ['HK-01', 'JP-02', 'HK-01 #2']);
eq('生成 3 个 proxy', built.config.proxies.length, 3);
eq('listeners 数量等于节点数', built.config.listeners.length, 3);
eq('第一个 listener 绑定节点名', built.config.listeners[0].proxy, 'HK-01');
eq('listener 端口连续', built.config.listeners.map((l) => l.port), [20000, 20001, 20002]);
eq('PROXY 分组包含全部节点', built.config['proxy-groups'][0].proxies, built.names);
eq('bypass-cn 规则', built.config.rules, ['RULE-SET,cn-domain,DIRECT', 'RULE-SET,cn-cidr,DIRECT', 'MATCH,PROXY']);
eq('bypass-cn provider', Object.keys(built.config['rule-providers']).sort(), ['cn-cidr', 'cn-domain']);

/* ---------- 三种模式 ---------- */
eq('global 规则', gen.buildMihomoConfig({ nodes: sampleNodes, routeMode: 'global' }).config.rules, ['MATCH,PROXY']);
eq('proxy-list 规则', gen.buildMihomoConfig({ nodes: sampleNodes, routeMode: 'proxy-list' }).config.rules, ['RULE-SET,gfw-domain,PROXY', 'MATCH,DIRECT']);

/* ---------- 边界 ---------- */
try {
  gen.buildMihomoConfig({ nodes: [] });
  bad('空节点应抛错');
} catch (e) {
  ok('空节点抛错');
}

const weird = gen.buildMihomoConfig({
  nodes: [{ id: 'w', name: 'a\nb\tc    d', type: 'ss', server: '1.1.1.1', port: 1, conf: {} }],
});
eq('节点名清洗控制字符', weird.names, ['a b c d']);

/* ---------- 真实内核校验 ---------- */
if (fs.existsSync(CORE)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2p-android-cfg-'));
  const rd = path.join(tmp, 'rules');
  fs.mkdirSync(rd, { recursive: true });
  for (const f of ['cn-domain.yaml', 'cn-cidr.yaml', 'gfw-domain.yaml']) {
    const src = path.join(RULES_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(rd, f));
  }
  const cfgPath = path.join(tmp, 'config.yaml');
  fs.writeFileSync(cfgPath, built.yaml, 'utf8');

  try {
    execFileSync(CORE, ['-t', '-d', tmp, '-f', cfgPath], { stdio: 'pipe', timeout: 60000 });
    ok('mihomo -t 校验通过（含 listeners[].proxy）');
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    bad('mihomo -t 校验失败', out.split('\n').filter(Boolean).slice(-3).join(' | '));
  }

  // 确认 YAML 能被解析回来，字段没被 dump 坏
  const back = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
  eq('回读 listeners[0].proxy', back.listeners[0].proxy, 'HK-01');
  eq('回读 mixed-port', back['mixed-port'], 7890);

  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  - 跳过内核校验（未找到 mihomo：' + CORE + '）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) console.log('失败项: ' + failures.join(' / '));
process.exit(fail ? 1 : 0);
