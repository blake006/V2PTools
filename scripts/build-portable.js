'use strict';

/**
 * 编译单文件便携版 exe
 * 1) 把 package.json 的版本号同步进 build/portable.nsi
 * 2) 自动定位 makensis（PATH 或 electron-builder 缓存），无需手工装 NSIS
 * 3) 调用 makensis 编译 dist/V2PTools-<版本>-win-x64-portable.exe
 *
 * 用法: npm run dist:exe   （需先 npm run dist 生成 dist/win-unpacked）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const nsiPath = path.join(ROOT, 'build', 'portable.nsi');
const unpacked = path.join(ROOT, 'dist', 'win-unpacked');

/* 1. 同步版本号 */
let nsi = fs.readFileSync(nsiPath, 'utf8');
const updated = nsi.replace(/(!define\s+VERSION\s+")[^"]*(")/, `$1${version}$2`);
if (updated !== nsi) {
  fs.writeFileSync(nsiPath, updated, 'utf8');
  console.log(`已同步版本号 ${version} 到 build/portable.nsi`);
}
nsi = updated;

/* 2. 检查打包目录 */
if (!fs.existsSync(path.join(unpacked, 'V2PTools.exe'))) {
  console.error('缺少 dist/win-unpacked，请先执行 npm run dist');
  process.exit(1);
}

/* 3. 定位 makensis */
function findMakensis() {
  const candidates = [];
  if (process.env.MAKENSIS) candidates.push(process.env.MAKENSIS);
  candidates.push('makensis', 'makensis.exe');

  // electron-builder 缓存的 NSIS
  const cacheRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache'),
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache'),
  ].filter(Boolean);
  for (const root of cacheRoots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!/^nsis/i.test(dir)) continue;
      const base = path.join(root, dir);
      // 缓存可能是 Cache/nsis-3.0.4.1/makensis.exe，
      // 也可能是 Cache/nsis-3.0.4.1/nsis-3.0.4.1-xxxx/Bin/makensis.exe（多一层）
      const levels = [base];
      try {
        for (const s of fs.readdirSync(base)) {
          const p = path.join(base, s);
          if (fs.statSync(p).isDirectory()) levels.push(p);
        }
      } catch (e) {}
      for (const level of levels) {
        for (const sub of ['bin/makensis.exe', 'makensis.exe', 'Bin/makensis.exe']) {
          const p = path.join(level, sub);
          if (fs.existsSync(p)) candidates.push(p);
        }
      }
    }
  }
  // 常规安装位置
  candidates.push('C:/Program Files (x86)/NSIS/makensis.exe', 'C:/Program Files/NSIS/makensis.exe');

  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
    } else {
      try {
        execSync(`${c} /VERSION`, { stdio: 'ignore', windowsHide: true });
        return c;
      } catch (e) {
        /* 继续找 */
      }
    }
  }
  return null;
}

const makensis = findMakensis();
if (!makensis) {
  console.error('未找到 makensis。请安装 NSIS，或用 MAKENSIS 环境变量指定路径，');
  console.error('也可先执行一次 npx electron-builder --win zip（会自动下载 NSIS 到缓存）。');
  process.exit(1);
}
console.log(`使用 makensis: ${makensis}`);

/* 4. 编译 */
const outName = `V2PTools-${version}-win-x64-portable.exe`;
console.log(`开始编译 ${outName}（LZMA 固实压缩，约 2-3 分钟）…`);
execFileSync(makensis, ['-V2', nsiPath], { cwd: ROOT, stdio: 'inherit' });

const out = path.join(ROOT, 'dist', outName);
if (!fs.existsSync(out)) {
  console.error('编译结束但未找到产物: ' + out);
  process.exit(1);
}
const mb = (fs.statSync(out).size / 1048576).toFixed(1);
console.log(`\n完成: dist/${outName} (${mb} MB)`);
