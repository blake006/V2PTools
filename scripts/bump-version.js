'use strict';

/**
 * 版本号递增，项目约定（1.5.0 起生效）：
 *   1.4.0 → 1.4.1 → … → 1.4.9 → 1.5.0 → 1.5.1 …
 * 即 patch 只到 9，跳过 .10，.9 之后直接进位到下一个 minor 的 .0。
 * 历史版本 1.4.10 是旧规则（patch 到 10 才进位）留下的，保留不回退。
 *
 * 用法: npm run bump            （按上面的规则自动进位）
 *       npm run bump -- 1.5.0   （显式指定版本）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const nsiPath = path.join(ROOT, 'build', 'portable.nsi');

function syncNsi(version) {
  let nsi = fs.readFileSync(nsiPath, 'utf8');
  const before = nsi;
  nsi = nsi.replace(/(!define\s+VERSION\s+")[^"]*(")/, `$1${version}$2`);
  if (nsi !== before) {
    fs.writeFileSync(nsiPath, nsi, 'utf8');
    return true;
  }
  return false;
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const prev = pkg.version;
const arg = process.argv[2];
let next;

if (arg) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error('版本号格式应为 x.y.z，例如 1.0.2');
    process.exit(1);
  }
  next = arg;
} else {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  // patch 到 9 就进位，跳过 .10：1.4.9 → 1.5.0；1.4.10（历史遗留）→ 1.5.0
  next = patch >= 9 ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
const synced = syncNsi(next);

console.log(`版本号: ${prev} → ${next}${arg ? '（显式指定）' : ''}`);
console.log(`package.json → ${next}`);
console.log(synced ? `build/portable.nsi → ${next}` : 'build/portable.nsi 未找到 !define VERSION，跳过');
console.log('\n下一步: npm run dist && npm run dist:exe');
