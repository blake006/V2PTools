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

  const names = ['rcedit-x64.exe', 'bin/makensis.exe', 'makensis.exe', 'Bin/makensis.exe'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!pattern.test(dir)) continue;
      const base = path.join(root, dir);
      // 缓存目录可能是 Cache/winCodeSign/rcedit-x64.exe，
      // 也可能是 Cache/winCodeSign/winCodeSign-2.6.0-w1/rcedit-x64.exe（解压后多一层）。
      // 两层都要找，否则「工具明明在却报未找到」。
      const candidates = [base];
      try {
        for (const sub of fs.readdirSync(base)) {
          const p = path.join(base, sub);
          if (fs.statSync(p).isDirectory()) candidates.push(p);
        }
      } catch (e) {}
      for (const c of candidates) {
        for (const name of names) {
          const p = path.join(c, name);
          if (!fs.existsSync(p)) continue;
          if (/rcedit/.test(name)) found.rcedit = found.rcedit || p;
          else found.makensis = found.makensis || p;
        }
      }
    }
  }
}

/* ---------------- 1. 打包目录 ---------------- */
log('electron-builder 打包目录');
// 直接跑 CLI 入口，避免 Node 22 下 spawnSync('npx.cmd') 的 EINVAL
const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

/**
 * electron-builder 缺本地 Electron 运行时缓存时会去 GitHub 下载，
 * 而 GitHub Releases 经常 502 / 被代理掐断（1.5.0 构建就撞上过）。
 * 首次失败后自动改用国内镜像重试一次，避免「代码没问题但包出不来」。
 */
function runBuilder(env, extraArgs = []) {
  return spawnSync(process.execPath, [builderCli, '--win', '--dir', ...extraArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
}

/**
 * 离线优先：node_modules/electron/dist 里已有完整 Electron 运行时
 * （含 electron.exe / locales / *.pak / resources）时，直接让 electron-builder
 * 复制它，完全不联网。GitHub Releases 的 502 / 大文件下载中断就不会再卡住构建。
 * 只有本地运行时缺失时才走下载，并带一次国内镜像重试。
 */
const localDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
const hasLocalDist = fs.existsSync(path.join(localDist, 'electron.exe'));
let built;

if (hasLocalDist) {
  log('使用本地 Electron 运行时（离线构建，不下载）');
  built = runBuilder(process.env, [`-c.electronDist=${localDist}`]);
  if (built.status !== 0) {
    console.log('  离线构建失败，回退到在线下载…\n');
    built = null;
  }
}

if (!built) {
  built = runBuilder(process.env);
}
if (built.status !== 0) {
  // app-builder 的下载器认这几个环境变量（不在 Node 侧，所以必须注入 env）。
  // npmmirror 的目录没有 v 前缀，必须用 ELECTRON_CUSTOM_DIR 显式指定。
  const ver = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
    } catch (e) {
      return '32.3.3';
    }
  })();
  const mirror = 'https://npmmirror.com/mirrors/electron/';
  console.log(`\n  打包失败，改用镜像 ${mirror} 重试…\n`);
  built = runBuilder({
    ...process.env,
    ELECTRON_MIRROR: mirror,
    ELECTRON_CUSTOM_DIR: ver,
    ELECTRON_CUSTOM_FILENAME: `electron-v${ver}-win32-x64.zip`,
  });
}
if (built.status !== 0) {
  console.error('electron-builder 打包失败');
  process.exit(built.status || 1);
}
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

/* ---------------- 2.5 应急修复脚本 ---------------- */
log('放入独立应急修复脚本');
// 开机后若整机断网、连 V2PTools 界面都进不去，应用内的「一键修复网络」就用不上了。
// 把纯 cmd 脚本放在包根目录，双击即可复位系统代理（不需要启动本程序）。
const repairSrc = path.join(ROOT, 'scripts', 'repair-network.cmd');
if (fs.existsSync(repairSrc)) {
  fs.copyFileSync(repairSrc, path.join(UNPACKED, 'repair-network.cmd'));
  console.log('  repair-network.cmd 已放入包根目录');
} else {
  console.log('  警告：缺少 scripts/repair-network.cmd，包内将没有应急修复脚本');
}

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

log('校验产物完整性');
// 产物生成后再验一遍资源，防止「包能生成但漏了内核/驱动/规则」这种只在运行时才暴露的问题
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-package.js')], {
  cwd: ROOT,
  stdio: 'inherit',
});

log('全部完成');
for (const f of fs.readdirSync(DIST).filter((f) => /^V2PTools-.*\.(exe|zip)$/.test(f))) {
  const st = fs.statSync(path.join(DIST, f));
  console.log(`  ${f}  ${(st.size / 1048576).toFixed(1)} MB  ${st.mtime.toLocaleString('zh-CN')}`);
}
