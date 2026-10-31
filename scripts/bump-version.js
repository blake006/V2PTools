'use strict';

/**
 * 版本号递增：1.0.0 → 1.0.1 → 1.0.2 …（只动 patch 位，按项目约定顺次递增）
 * 用法: npm run bump
 *       npm run bump -- 1.0.5   （显式指定版本）
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
  next = `${major}.${minor}.${patch + 1}`;
}

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
const synced = syncNsi(next);

console.log(`版本号: ${pkg.version === next ? next : '?'}（原 ${arg ? '指定' : next.replace(/\d+$/, (m) => String(Number(m) - 1))}）`);
console.log(`package.json → ${next}`);
console.log(synced ? `build/portable.nsi → ${next}` : 'build/portable.nsi 未找到 !define VERSION，跳过');
console.log('\n下一步: npm run dist && npm run dist:exe');
