'use strict';
/** 表格列结构自检：index.html 表头 / rowHtml 单元格 / CSS 宽度三者必须一一对应。 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || '.';
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'style.css'), 'utf8');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

const headBlock = html.match(/<thead>[\s\S]*?<\/thead>/);
check(!!headBlock, '找不到 thead');
const ths = [...headBlock[0].matchAll(/<th class="([^"]+)"/g)].map((m) => ({ classes: m[1].split(/\s+/) }));
console.log(`表头列数：${ths.length}`);

const rowFn = js.match(/function rowHtml\(n\)[\s\S]*?return `([\s\S]*?)`;\s*\}/);
check(!!rowFn, '找不到 rowHtml 模板');
const tds = [...rowFn[1].matchAll(/<td[^>]*class="([^"]+)"/g)].map((m) => ({ classes: m[1].split(/\s+/) }));
const cols = [...rowFn[1].matchAll(/data-col="(\w+)"/g)].map((m) => m[1]);
console.log(`数据行单元格数：${tds.length}，data-col：${cols.join(', ')}`);

check(tds.length === ths.length, `单元格数 ${tds.length} 与表头数 ${ths.length} 不一致`);
check(cols.join('|') === ths.map((_, i) => 'c' + i).join('|'), `data-col 序列应为 c0..c${ths.length - 1}`);

ths.forEach((th, i) => {
  const thCls = th.classes.find((c) => c.startsWith('col-'));
  const tdCls = tds[i] && tds[i].classes.find((c) => c.startsWith('col-'));
  check(thCls === tdCls, `第 ${i} 列 class 不一致：表头 ${thCls} / 单元格 ${tdCls}`);
});

const widths = [...css.matchAll(/\.(col-[a-z-]+)\s*\{[^}]*width/g)].map((m) => m[1]);
const need = ths.map((t) => t.classes.find((c) => c.startsWith('col-'))).filter(Boolean);
const missing = need.filter((c) => !widths.includes(c));
check(missing.length === 0, `缺少宽度规则：${missing.join(', ')}`);

const sortKeys = [...headBlock[0].matchAll(/data-sort="(\w+)"/g)].map((m) => m[1]);
const fake = { name: '', type: 'ss', server: '', port: 1, group: '', latency: 1, speed: 1, ip: '', country: '', health: 1 };
const badKeys = sortKeys.filter((k) => !(k in fake));
check(badKeys.length === 0, `排序键不在节点模型里：${badKeys.join(', ')}`);

if (failures.length) {
  console.log('\n✘ 发现不一致：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n✔ 列结构一致（表头 / 单元格 / 宽度 / 排序键）');
