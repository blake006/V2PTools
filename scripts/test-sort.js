'use strict';
/**
 * 排序回归：直接抽出 renderer/app.js 里的 sortedNodes() 原文在无 DOM 环境里跑，
 * 保证「类型列按业务顺序排」这件事是真的生效，而不是只在注释里。
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const m = src.match(/function sortedNodes\(\)[\s\S]*?return arr;\s*\}/);
if (!m) {
  console.log('✘ 找不到 sortedNodes() 函数原文');
  process.exit(1);
}
const sortedNodes = new Function('state', `${m[0]}\nreturn sortedNodes();`);

let fail = 0;
const t = (name, fn) => {
  try {
    fn();
  } catch (e) {
    fail += 1;
    console.log(`✘ ${name}\n   ${e.message}`);
    return;
  }
  console.log(`✔ ${name}`);
};
const mk = (id, extra) => Object.assign({ id, latency: null, speed: null, health: null, favorite: false }, extra);
const ids = (list) => list.map((n) => n.id).join('>');

t('类型列按「住宅 > 移动 > 机房 > 代理 > 未知」排，不按字母序', () => {
  const nodes = [
    mk('u', { ipTypeKey: 'unknown' }),
    mk('p', { ipTypeKey: 'proxy' }),
    mk('h', { ipTypeKey: 'hosting' }),
    mk('m', { ipTypeKey: 'mobile' }),
    mk('r', { ipTypeKey: 'residential' }),
    mk('none', {}),
  ];
  const out = ids(sortedNodes({ nodes, sort: { key: 'ipTypeKey', dir: 1 } }));
  if (out !== 'r>m>h>p>u>none') throw new Error(`实际顺序 ${out}，期望 r>m>h>p>u>none`);
});

t('类型列再点一次（降序）顺序反转', () => {
  const nodes = [mk('r', { ipTypeKey: 'residential' }), mk('u', { ipTypeKey: 'unknown' })];
  const out = ids(sortedNodes({ nodes, sort: { key: 'ipTypeKey', dir: -1 } }));
  if (out !== 'u>r') throw new Error(`实际顺序 ${out}，期望 u>r`);
});

t('未知类型（字段缺失）排在未知之后，且不会乱序', () => {
  const nodes = [mk('a', {}), mk('b', { ipTypeKey: 'nonsense' }), mk('c', { ipTypeKey: 'proxy' })];
  const out = ids(sortedNodes({ nodes, sort: { key: 'ipTypeKey', dir: 1 } }));
  if (out !== 'c>a>b' && out !== 'c>b>a') throw new Error(`实际顺序 ${out}`);
});

t('收藏节点始终置顶，不受类型排序影响', () => {
  const nodes = [mk('r', { ipTypeKey: 'residential' }), mk('u', { ipTypeKey: 'unknown', favorite: true })];
  const out = ids(sortedNodes({ nodes, sort: { key: 'ipTypeKey', dir: 1 } }));
  if (out !== 'u>r') throw new Error(`实际顺序 ${out}，期望 u>r`);
});

t('原有数值列排序没被改坏：延迟升序，未测的排最后', () => {
  const nodes = [mk('n', { latency: null }), mk('a', { latency: 180 }), mk('b', { latency: 60 })];
  const out = ids(sortedNodes({ nodes, sort: { key: 'latency', dir: 1 } }));
  if (out !== 'b>a>n') throw new Error(`实际顺序 ${out}，期望 b>a>n`);
});

console.log(fail ? `\n✘ 失败 ${fail} 项` : '\n✔ 排序回归全部通过');
process.exit(fail ? 1 : 0);
