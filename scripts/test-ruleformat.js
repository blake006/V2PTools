'use strict';

/**
 * 分流规则格式测试
 *
 * 守住历史 bug：上游规则文本是「YAML payload 片段」形态时，
 * 旧解析器把 `payload:` 和 `- '+.x.com'` 整行当成规则值，
 * 生成 12 万条匹配不上的垃圾 —— 表现为「绕过大陆」模式下百度也打不开。
 *
 * 用法: npm run test-ruleformat
 */

const assert = require('assert');
const { parseRuleText, yamlEscape, buildRuleYaml, validatePayload } = require('../electron/lib/ruleFormat');

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

console.log('\n分流规则格式');

/* ---------------- 形态 A：裸规则 ---------------- */

check('裸域名列表逐行解析', () => {
  const t = '+.google.com\n+.github.com\n';
  assert.deepStrictEqual(parseRuleText(t), ['+.google.com', '+.github.com']);
});

check('裸 IP 段列表逐行解析', () => {
  const t = '192.168.0.0/16\n10.0.0.0/8\n';
  assert.deepStrictEqual(parseRuleText(t), ['192.168.0.0/16', '10.0.0.0/8']);
});

check('跳过注释与空行', () => {
  const t = '# 注释\n\n+.a.com\n   \n# 又一行注释\n+.b.com\n';
  assert.deepStrictEqual(parseRuleText(t), ['+.a.com', '+.b.com']);
});

check('剥离 clash 规则前缀', () => {
  const t = 'DOMAIN-SUFFIX,google.com\nIP-CIDR,1.2.3.0/24,no-resolve\nDOMAIN,exact.com\n';
  assert.deepStrictEqual(parseRuleText(t), ['google.com', '1.2.3.0/24', 'exact.com']);
});

/* ---------------- 形态 B：YAML payload 片段（历史 bug）---------------- */

check('【回归】payload 片段：容器行不能变成规则', () => {
  const t = "payload:\n  - '+.000webhost.com'\n  - '+.0rz.tw'\n";
  const r = parseRuleText(t);
  assert.deepStrictEqual(r, ['+.000webhost.com', '+.0rz.tw']);
  assert.ok(!r.includes('payload:'), 'payload: 不应出现在结果里');
});

check('【回归】双重引号包裹能剥干净', () => {
  // 实际文件里长这样：  - '- ''+.000webhost.com'''
  const t = "payload:\n  - '- ''+.000webhost.com'''\n  - '- ''+.0rz.tw'''\n";
  const r = parseRuleText(t);
  assert.deepStrictEqual(r, ['+.000webhost.com', '+.0rz.tw']);
});

check('【回归】解析结果里不能有以 "- " 开头的脏值', () => {
  const t = "payload:\n  - '- ''1.0.1.0/24'''\n  - '- ''1.0.2.0/23'''\n";
  const r = parseRuleText(t);
  assert.strictEqual(r.length, 2);
  for (const v of r) assert.ok(!v.startsWith('- '), `脏值: ${v}`);
});

check('【回归】110k 规模的真实片段抽样', () => {
  const t = [
    '# CN 直连域名 — 来源 xxx',
    '# 生成时间 xxx  条目 3',
    'payload:',
    "  - '- ''2mdn-cn.net'''",
    "  - '- ''2mdn.net'''",
    "  - '- ''a1.mzstatic.com'''",
    '',
  ].join('\n');
  assert.deepStrictEqual(parseRuleText(t), ['2mdn-cn.net', '2mdn.net', 'a1.mzstatic.com']);
});

check('payload 里的注释行也跳过', () => {
  const t = "payload:\n  # 备注\n  - '+.a.com'\n";
  assert.deepStrictEqual(parseRuleText(t), ['+.a.com']);
});

/* ---------------- 去重与保序 ---------------- */

check('去重且保持首次出现顺序', () => {
  const t = "payload:\n  - '+.a.com'\n  - '+.b.com'\n  - '+.a.com'\n";
  assert.deepStrictEqual(parseRuleText(t), ['+.a.com', '+.b.com']);
});

check('同一文件混合两种形态也能处理', () => {
  const t = "payload:\n  - '+.a.com'\n+.b.com\nDOMAIN-SUFFIX,c.com\n";
  assert.deepStrictEqual(parseRuleText(t), ['+.a.com', '+.b.com', 'c.com']);
});

/* ---------------- 边界 ---------------- */

check('空输入返回空数组', () => {
  assert.deepStrictEqual(parseRuleText(''), []);
  assert.deepStrictEqual(parseRuleText(null), []);
  assert.deepStrictEqual(parseRuleText(undefined), []);
});

check('只有 payload: 的单行返回空', () => {
  assert.deepStrictEqual(parseRuleText('payload:'), []);
});

/* ---------------- YAML 序列化 ---------------- */

check('含特殊字符的值加引号', () => {
  // 冒号、井号、逗号这类在 YAML 里有语义，必须加引号
  assert.strictEqual(yamlEscape('a: b'), "'a: b'");
  assert.strictEqual(yamlEscape('a#b'), "'a#b'");
  assert.strictEqual(yamlEscape('a,b'), "'a,b'");
});

check('域名/IP 本体不加多余引号（YAML 里本就安全）', () => {
  assert.strictEqual(yamlEscape('+.google.com'), '+.google.com');
  assert.strictEqual(yamlEscape('google.com'), 'google.com');
  assert.strictEqual(yamlEscape('1.2.3.0/24'), '1.2.3.0/24');
});

check('内部单引号正确翻倍', () => {
  assert.strictEqual(yamlEscape("it's"), "'it''s'");
});

/* ---------------- 生成 → 校验 闭环 ---------------- */

check('生成的 YAML 能被校验器判为干净', () => {
  const items = ['+.a.com', '+.b.com', '1.2.3.0/24'];
  const yamlText = buildRuleYaml(items, { title: 'T', source: 'S' });
  assert.ok(yamlText.includes('payload:'));
  assert.ok(yamlText.includes('  - +.a.com'));
  assert.ok(yamlText.includes('  - 1.2.3.0/24'));
  // 生成的文本重新解析后必须与原列表一致（闭环）
  assert.deepStrictEqual(parseRuleText(yamlText), items);
});

check('校验器能识别脏 payload', () => {
  const dirty = ['payload:', "- '+.a.com'"];
  const v = validatePayload(dirty);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.bad.length, 2);
});

check('校验器通过干净的 payload', () => {
  const v = validatePayload(['+.a.com', '1.2.3.0/24']);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.count, 2);
});

check('校验器对非数组返回失败', () => {
  assert.strictEqual(validatePayload(null).ok, false);
  assert.strictEqual(validatePayload('x').ok, false);
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
