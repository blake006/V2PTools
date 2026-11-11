'use strict';

/**
 * Windows 完整打包流水线（离线可控，不依赖 electron-builder 的 rcedit 步骤）
 *
 * 1) electron-builder --win --dir   → dist/win-unpacked/
 * 2) rcedit 写入图标 + 产品名/版本信息（否则任务管理器显示 "Electron" + 原子图标）
 * 3) 7z 压缩 → dist/V2PTools-<版本>-win-x64.zip
 * 4) makensis  → dist/V2PTools-<版本>-win-x64-portable.exe
 *
 * 用法: npm run dist
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * 只保留最近 N 个版本的产物。
 * 每个版本 zip 127MB + exe 95MB，攒几版就能把磁盘吃干净
 * （曾经攒到 1.6GB，导致 electron-builder 报 Array buffer allocation failed）。
 */
function pruneOldArtifacts(keep = 2) {
  const DIST = path.join(ROOT, 'dist');
  if (!fs.existsSync(DIST)) return;
  const files = fs.readdirSync(DIST).filter((f) => /^V2PTools-[\d.]+-win-x64\.(zip|exe)$/.test(f));
  const versions = [...new Set(files.map((f) => (f.match(/^V2PTools-([\d.]+)-/) || [])[1]).filter(Boolean))];
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  versions.sort((a, b) => cmp(b, a)); // 新的在前
  const drop = versions.slice(keep);
  let freed = 0;
  for (const v of drop) {
    for (const f of files.filter((x) => x.startsWith(`V2PTools-${v}-`))) {
      const p = path.join(DIST, f);
      try {
        freed += fs.statSync(p).size;
        fs.unlinkSync(p);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
  if (drop.length) {
    console.log(`  清理旧版本 ${drop.join(', ')}，释放 ${Math.round(freed / 1048576)}MB`);
  }
}

pruneOldArtifacts(2);
const VERSION = pkg.version;
const APP = pkg.build.productName || 'V2PTools';
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const EXE = path.join(UNPACKED, `${APP}.exe`);

function log(msg) {
  console.log(`\n▸ ${msg}`);
}

const found = {};

function findInCache(pattern) {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache'),
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache'),
  ].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!pattern.test(dir)) continue;
      const base = path.join(root, dir);
      for (const name of ['rcedit-x64.exe', 'bin/makensis.exe', 'makensis.exe', 'Bin/makensis.exe']) {
        const p = path.join(base, name);
        if (!fs.existsSync(p)) continue;
        if (/rcedit/.test(name)) found.rcedit = found.rcedit || p;
        else found.makensis = found.makensis || p;
      }
    }
  }
}

/* ---------------- 1. 打包目录 ---------------- */
log('electron-builder 打包目录');
// 直接跑 CLI 入口，避免 Node 22 下 spawnSync('npx.cmd') 的 EINVAL
const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
execFileSync(process.execPath, [builderCli, '--win', '--dir'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (!fs.existsSync(EXE)) {
  console.error(`未找到 ${EXE}`);
  process.exit(1);
}

/* ---------------- 2. rcedit ---------------- */
log('写入图标与版本信息');
findInCache(/^winCodeSign/i);
const rcedit = found && found.rcedit;
if (!rcedit) {
  console.error('未找到 rcedit-x64.exe（通常在 electron-builder 缓存 winCodeSign-* 目录）');
  process.exit(1);
}
execFileSync(
  rcedit,
  [
    EXE,
    '--set-icon', path.join(ROOT, 'build', 'icon.ico'),
    '--set-version-string', 'ProductName', APP,
    '--set-version-string', 'FileDescription', pkg.description || APP,
    '--set-version-string', 'CompanyName', APP,
    '--set-version-string', 'LegalCopyright', pkg.build.copyright || `Copyright © 2026 ${APP}`,
    '--set-version-string', 'InternalName', APP,
    '--set-version-string', 'OriginalFilename', `${APP}.exe`,
    '--set-file-version', `${VERSION}.0`,
    '--set-product-version', VERSION,
  ],
  { stdio: 'inherit' }
);
console.log(`  ProductName=${APP}  FileVersion=${VERSION}.0`);

/* ---------------- 3. zip ---------------- */
log('压缩 zip');
const zipPath = path.join(DIST, `${APP}-${VERSION}-win-x64.zip`);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const sevenZip = [
  'C:/Program Files/7-Zip/7z.exe',
  'C:/Program Files (x86)/7-Zip/7z.exe',
].find((p) => fs.existsSync(p));

if (sevenZip) {
  execFileSync(sevenZip, ['a', '-tzip', '-mx5', zipPath, '*'], { cwd: UNPACKED, stdio: 'inherit' });
} else {
  console.log('  未找到 7z，改用 PowerShell Compress-Archive（较慢）');
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${UNPACKED}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit' }
  );
}
console.log(`  ${path.basename(zipPath)}  ${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);

/* ---------------- 4. 便携版 exe ---------------- */
log('编译单文件便携版');
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-portable.js')], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (r.status !== 0) process.exit(r.status || 1);

log('全部完成');
for (const f of fs.readdirSync(DIST).filter((f) => /^V2PTools-.*\.(exe|zip)$/.test(f))) {
  const st = fs.statSync(path.join(DIST, f));
  console.log(`  ${f}  ${(st.size / 1048576).toFixed(1)} MB  ${st.mtime.toLocaleString('zh-CN')}`);
}
