'use strict';

/**
 * 把桌面端（V2PTools）里可复用的纯逻辑同步到安卓 assets。
 *
 * 复用清单：
 *   renderer/filter.js       分面筛选（已是 UMD，直接用）
 *   renderer/merge.js        节点合并去重（已是 UMD，直接用）
 *   electron/lib/parser.js   订阅/链接解析（CommonJS，需包装）
 *   electron/lib/ruleFormat.js 规则文本解析（CommonJS，需包装）
 *   electron/lib/clash.js    Clash 配置导出（CommonJS + js-yaml，需包装）
 *   node_modules/js-yaml/dist/js-yaml.min.js  浏览器版 YAML
 *
 * 包装方式：套一层 IIFE 提供 module/exports/require，跑完挂到 window.V2P.*
 * 这样桌面端改动只需重跑本脚本，不用手工维护两份代码。
 *
 * 用法: node scripts/sync-web.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 安卓工程现在位于 V2PTools/android，桌面端在上一层
const DESKTOP = process.env.DESKTOP_DIR || path.join(ROOT, '..');
const OUT = path.join(ROOT, 'app', 'src', 'main', 'assets', 'web', 'vendor');

const COPY_UMD = [
  { src: 'renderer/filter.js', out: 'filter.js' },
  { src: 'renderer/merge.js', out: 'merge.js' },
];

const WRAP_CJS = [
  { src: 'electron/lib/parser.js', out: 'parser.js', global: 'parser' },
  { src: 'electron/lib/ruleFormat.js', out: 'ruleFormat.js', global: 'ruleFormat' },
  { src: 'electron/lib/clash.js', out: 'clash.js', global: 'clash' },
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  ensureDir(OUT);

  if (!fs.existsSync(DESKTOP)) {
    console.error('找不到桌面项目：' + DESKTOP);
    process.exit(1);
  }

  // 1. UMD 文件直接复制
  for (const item of COPY_UMD) {
    const src = path.join(DESKTOP, item.src);
    const dst = path.join(OUT, item.out);
    fs.copyFileSync(src, dst);
    console.log(`  复制 ${item.src} → vendor/${item.out}`);
  }

  // 2. CommonJS 文件包装
  for (const item of WRAP_CJS) {
    const src = path.join(DESKTOP, item.src);
    const code = fs.readFileSync(src, 'utf8');
    const wrapped =
      '/* 由 scripts/sync-web.js 自动生成，请勿手改（源：' + item.src + '） */\n' +
      ';(function () {\n' +
      '  var module = { exports: {} };\n' +
      '  var exports = module.exports;\n' +
      '  var require = window.__require;\n' +
      code +
      '\n  window.V2P = window.V2P || {};\n' +
      '  window.V2P.' + item.global + ' = module.exports;\n' +
      '})();\n';
    fs.writeFileSync(path.join(OUT, item.out), wrapped, 'utf8');
    console.log(`  包装 ${item.src} → vendor/${item.out}`);
  }

  // 3. js-yaml 浏览器版
  const yamlSrc = path.join(DESKTOP, 'node_modules', 'js-yaml', 'dist', 'js-yaml.min.js');
  if (fs.existsSync(yamlSrc)) {
    fs.copyFileSync(yamlSrc, path.join(OUT, 'js-yaml.min.js'));
    console.log('  复制 js-yaml.min.js');
  } else {
    console.warn('  ! 未找到 js-yaml.min.js，请先在桌面项目执行 npm install');
  }

  // 4. 规则文件
  const rulesOut = path.join(ROOT, 'app', 'src', 'main', 'assets', 'rules');
  ensureDir(rulesOut);
  for (const f of ['cn-domain.yaml', 'cn-cidr.yaml', 'gfw-domain.yaml']) {
    const src = path.join(DESKTOP, 'assets', 'rules', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(rulesOut, f));
      console.log(`  复制规则 ${f}`);
    }
  }

  console.log('\n完成。');
}

main();
