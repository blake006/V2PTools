'use strict';

/**
 * Clash 配置导出测试
 * 1) 多协议节点 → YAML，节点名唯一、分组引用完整
 * 2) 空列表必须报错
 * 3) 生成结果交给 mihomo -t 校验（配置能被内核接受）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const parser = require('../electron/lib/parser');
const { buildClashConfig, buildClashYaml, GROUP_MAIN, GROUP_AUTO } = require('../electron/lib/clash');
const { cases } = require('./test-parser');

let pass = 0;
let fail = 0;
function check(ok, label, extra) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`);
}

/* ---------- 准备节点 ---------- */
const nodes = [];
for (const [, text] of cases) {
  const r = parser.parseText(text, { plainType: 'socks5', allowHttpProxy: true });
  nodes.push(...r.nodes);
}
const uniq = parser.dedupe(nodes);
// 人为制造重名与地区信息，验证去重与地区分组
uniq[0].name = '同 名节点';
uniq[1].name = '同 名节点';
uniq[0].country = '中国香港';
uniq[0].countryCode = 'HK';
uniq[1].country = '日本';
uniq[1].countryCode = 'JP';

const { config, count } = buildClashConfig(uniq);
check(count === uniq.length, `节点全部导出（${count} 个）`);
check(new Set(config.proxies.map((p) => p.name)).size === config.proxies.length, '节点名唯一');
check(config.proxies.some((p) => p.name === '同 名节点 #2'), '重名节点自动加后缀');

const main = config['proxy-groups'].find((g) => g.name === GROUP_MAIN);
check(!!main && main.type === 'select', '存在主选择分组');
const auto = config['proxy-groups'].find((g) => g.name === GROUP_AUTO);
check(!!auto && auto.type === 'url-test', '存在自动测速分组');

const allNames = new Set(config.proxies.map((p) => p.name));
const groupNames = new Set(config['proxy-groups'].map((g) => g.name));
const missing = config['proxy-groups'].flatMap((g) => g.proxies).filter((n) => !allNames.has(n) && !groupNames.has(n));
check(missing.length === 0, '分组引用全部有效', missing.length ? JSON.stringify(missing.slice(0, 3)) : '');

const regionGroups = config['proxy-groups'].filter((g) => g.type === 'select' && g.name !== GROUP_MAIN);
check(regionGroups.length >= 2, `按地区生成分组（${regionGroups.length} 个）`);

check(
  config.rules[config.rules.length - 1] === `MATCH,${GROUP_MAIN}`,
  '最后一条规则指向主分组'
);
check(config.proxies.every((p) => p.server && p.port && p.type), '每个节点都有 type/server/port');

/* ---------- 空列表 ---------- */
let threw = false;
try {
  buildClashConfig([]);
} catch (e) {
  threw = /没有可导出的节点/.test(e.message);
}
check(threw, '空列表导出时报错');

/* ---------- 关闭地区分组 ---------- */
const plainCfg = buildClashConfig(uniq, { regionGroups: false, autoGroup: false }).config;
check(plainCfg['proxy-groups'].length === 1, '可关闭地区/自动分组');

/* ---------- 内核校验 ---------- */
const { text } = buildClashYaml(uniq);
const tmp = path.join(os.tmpdir(), 'iph-clashtest');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const cfgPath = path.join(tmp, 'config.yaml');
fs.writeFileSync(cfgPath, text, 'utf8');

const coreExe = path.join(__dirname, '..', 'vendor', 'mihomo.exe');
if (fs.existsSync(coreExe)) {
  try {
    const out = execFileSync(coreExe, ['-t', '-d', tmp, '-f', cfgPath], { encoding: 'utf8', timeout: 30000 });
    check(/configuration file .* test is successful|test is successful/i.test(out), 'mihomo -t 校验通过', out.trim().split('\n').pop());
  } catch (e) {
    check(false, 'mihomo -t 校验通过', (e.stdout || e.message || '').split('\n').slice(-6).join(' | '));
  }
} else {
  console.log('… 跳过 mihomo 校验（未找到 vendor/mihomo.exe）');
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
