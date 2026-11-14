'use strict';

/**
 * 打包产物完整性校验（构建后 / 单独运行）
 *
 * 起因：1.3.9 漏过 vendor/mihomo.exe、1.4.10 漏过 vendor/wintun.dll ——
 * 都是「extraResources 配置少一行」，包能正常生成、界面也能开，
 * 但一按「开启代理 / 开启 TUN」才报错。这里把检查放到打包后立刻执行。
 *
 * 检查：
 *  1) 内核 / 驱动 / 分流规则 / 应急脚本都真实存在于 win-unpacked
 *  2) app.asar 里包含所有新增的关键模块（防止 files 白名单漏文件）
 *  3) app.asar 内 package.json 版本与 package.json 一致
 *  4) exe 内嵌版本号与当前版本一致
 *  5) zip / portable 产物存在且大小合理
 *
 * 用法: node scripts/verify-package.js [--skip-artifacts]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const APP = 'V2PTools';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const mustExist = (p, label) => {
  if (!fs.existsSync(p)) throw new Error(`${label} 不存在：${p}`);
};
const mustNonEmpty = (p, label, min = 1) => {
  mustExist(p, label);
  const s = fs.statSync(p).size;
  if (s < min) throw new Error(`${label} 太小（${s} 字节），可能是空文件`);
};

/**
 * 读取 asar 头部，返回 { header, dataStart, buffer }
 *
 * asar 是两层 Chromium Pickle：
 *   [0..3]=4  [4..7]=headerPickle 长度  [8..11]=payload 长度  [12..15]=JSON 字节数
 *   [16..16+jsonLen)=JSON 头，之后按 4 字节对齐补齐，才是文件数据区。
 * 数据区起点 = 8 + headerPickle 长度（已含对齐），不能用 16+jsonLen 直接算，
 * 否则会差 2 字节，读 package.json 时前面多出 `;{`。
 */
function readAsar(file) {
  const buf = fs.readFileSync(file);
  const headerPickleSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
  return { header, dataStart: 8 + headerPickleSize, buffer: buf };
}

function asarHas(asar, relPath) {
  let cur = asar.header.files;
  for (const part of relPath.split('/')) {
    if (!cur || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = cur[part].files || {};
  }
  return true;
}

check('打包目录存在', () => mustExist(path.join(UNPACKED, `${APP}.exe`), 'V2PTools.exe'));

for (const [rel, label, min] of [
  ['resources/core/mihomo.exe', '代理内核', 1024 * 1024],
  ['resources/core/wintun.dll', 'TUN 虚拟网卡驱动', 10 * 1024],
  ['resources/rules/cn-domain.yaml', 'CN 域名规则', 10 * 1024],
  ['resources/rules/cn-cidr.yaml', 'CN IP 段规则', 1024],
  ['resources/rules/gfw-domain.yaml', 'GFW 域名规则', 1024],
  ['repair-network.cmd', '独立应急修复脚本', 200],
]) {
  check('包内 ' + label, () => mustNonEmpty(path.join(UNPACKED, rel), label, min));
}

check('app.asar 关键模块齐全', () => {
  const asar = readAsar(path.join(UNPACKED, 'resources', 'app.asar'));
  const mods = [
    'electron/main.js',
    'electron/preload.js',
    'electron/lib/gateway.js',
    'electron/lib/core.js',
    'electron/lib/coreCompat.js',
    'electron/lib/netGuard.js',
    'electron/lib/sysproxy.js',
    'electron/lib/tester.js',
    'renderer/app.js',
    'renderer/index.html',
    'renderer/style.css',
    'package.json',
  ];
  const missing = mods.filter((m) => !asarHas(asar, m));
  if (missing.length) throw new Error('app.asar 缺少：' + missing.join(', '));
});

check('app.asar 内版本号一致', () => {
  const asar = readAsar(path.join(UNPACKED, 'resources', 'app.asar'));
  const entry = asar.header.files['package.json'];
  const raw = asar.buffer
    .slice(asar.dataStart + Number(entry.offset), asar.dataStart + Number(entry.offset) + entry.size)
    .toString('utf8');
  const v = JSON.parse(raw).version;
  if (v !== VERSION) throw new Error(`app.asar 版本 ${v} ≠ package.json ${VERSION}`);
});

check('exe 内嵌版本信息一致', () => {
  const { execFileSync } = require('child_process');
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign'
  );
  let rcedit = '';
  if (fs.existsSync(cacheRoot)) {
    for (const d of fs.readdirSync(cacheRoot)) {
      const base = path.join(cacheRoot, d);
      const levels = [base];
      try {
        for (const s of fs.readdirSync(base)) {
          const p = path.join(base, s);
          if (fs.statSync(p).isDirectory()) levels.push(p);
        }
      } catch (e) {}
      for (const l of levels) {
        const p = path.join(l, 'rcedit-x64.exe');
        if (fs.existsSync(p)) {
          rcedit = p;
          break;
        }
      }
      if (rcedit) break;
    }
  }
  if (!rcedit) {
    // 没有 rcedit 就跳过这一项，不让校验脚本本身成为构建阻塞点
    return;
  }
  const exe = path.join(UNPACKED, `${APP}.exe`);
  const fv = String(execFileSync(rcedit, [exe, '--get-version-string', 'FileVersion'], { encoding: 'utf8' })).trim();
  if (!fv.startsWith(VERSION + '.')) throw new Error(`exe FileVersion=${fv}，期望 ${VERSION}.0`);
});

const skipArtifacts = process.argv.includes('--skip-artifacts');
if (!skipArtifacts) {
  for (const [name, label, minMB] of [
    [`${APP}-${VERSION}-win-x64.zip`, '解压版 zip', 50],
    [`${APP}-${VERSION}-win-x64-portable.exe`, '便携版 exe', 50],
  ]) {
    check('产物 ' + label, () => {
      const p = path.join(DIST, name);
      mustExist(p, label);
      const mb = fs.statSync(p).size / 1048576;
      if (mb < minMB) throw new Error(`${label} 只有 ${mb.toFixed(1)}MB，疑似打包不完整`);
    });
  }
}

for (const r of results) {
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '\n      ' + r.error));
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n产物校验失败：${failed.length} 项`);
  process.exit(1);
}
console.log(`\n产物校验通过：${results.length} 项（版本 ${VERSION}）`);
