'use strict';
/** 重复声明扫描：同名函数在一个文件里定义两次，后一个会静默覆盖前一个。 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || '.';
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js') && !name.endsWith('.min.js')) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const defs = new Map();
  const re = /^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split('\n').length;
    if (!defs.has(m[1])) defs.set(m[1], []);
    defs.get(m[1]).push(line);
  }
  for (const [name, lines] of defs) {
    if (lines.length > 1) {
      bad += 1;
      console.log(`${path.relative(root, f)}  ${name} 重复定义：第 ${lines.join('、')} 行`);
    }
  }
}
console.log(bad ? `\n共 ${bad} 处重复定义` : '✔ 未发现重复函数定义');
process.exitCode = bad ? 1 : 0;
