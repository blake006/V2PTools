'use strict';

/**
 * 生成应用图标：build/icon.svg → build/icon.ico（多尺寸）+ build/icon.png
 *
 * 用 Electron 的 canvas 精确栅格化（离线、无外部依赖），
 * 小尺寸（16/20/24）自动换用简化版图形，避免细节在任务栏里糊成一团。
 *
 * 用法: npx electron scripts/make-icon.js
 *      （本机需 env -u ELECTRON_RUN_AS_NODE）
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FULL_SVG = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');

// 小尺寸简化版：去掉隧道环和虚线，加粗笔画、放大节点
const SMALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#1e2a44"/>
      <stop offset="0.55" stop-color="#131a29"/>
      <stop offset="1" stop-color="#080c13"/>
    </linearGradient>
    <linearGradient id="nd" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6cf2b6"/>
      <stop offset="1" stop-color="#1fae76"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="58" fill="url(#bg)"/>
  <path d="M72 54 L128 186 L184 54" fill="none" stroke="#ffffff" stroke-width="44"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="128" cy="186" r="30" fill="url(#nd)"/>
</svg>`;

const SIZES = [
  { size: 16, svg: 'small' },
  { size: 20, svg: 'small' },
  { size: 24, svg: 'small' },
  { size: 32, svg: 'full' },
  { size: 40, svg: 'full' },
  { size: 48, svg: 'full' },
  { size: 64, svg: 'full' },
  { size: 128, svg: 'full' },
  { size: 256, svg: 'full' },
];

/* ---------------- ICO 打包 ---------------- */

function buildDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 两张位图
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = size - 1 - y; // DIB 自下而上
    for (let x = 0; x < size; x += 1) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size, 0); // 全 0 = 全部不透明，靠 alpha 通道
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  const datas = images.map((img) => buildDib(img.size, img.rgba));
  let offset = 6 + 16 * count;

  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.size >= 256 ? 0 : img.size;
    dir[o + 1] = img.size >= 256 ? 0 : img.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(datas[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += datas[i].length;
  });

  return Buffer.concat([header, dir, ...datas]);
}

/* ---------------- ASCII 预览（无图形界面时肉眼校验） ---------------- */

function asciiPreview(size, rgba, cols = 32) {
  const rows = Math.round(cols / 2);
  const chars = ' .:-=+*#%@';
  const lines = [];
  for (let ry = 0; ry < rows; ry += 1) {
    let line = '';
    for (let rx = 0; rx < cols; rx += 1) {
      const x0 = Math.floor((rx * size) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * size) / cols));
      const y0 = Math.floor((ry * size) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * size) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * size + x) * 4;
          const a = rgba[i + 3] / 255;
          const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
          sum += lum * a;
          n += 1;
        }
      }
      const v = n ? sum / n : 0;
      line += chars[Math.min(chars.length - 1, Math.floor(v * chars.length))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/* ---------------- 主流程 ---------------- */

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<script>
window.renderIcon = async function (svg, size) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  // 每次新建 canvas，避免复用导致后续渲染出空图
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return { rgba: btoa(bin), png: c.toDataURL('image/png') };
};
</script></body></html>`;

app.whenReady().then(async () => {
  const tmp = path.join(os.tmpdir(), 'v2p-icon-render.html');
  fs.writeFileSync(tmp, HTML, 'utf8');

  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  await win.loadFile(tmp);

  const images = [];
  let png256 = null;

  for (const item of SIZES) {
    const svg = item.svg === 'small' ? SMALL_SVG : FULL_SVG;
    // eslint-disable-next-line no-await-in-loop
    const res = await win.webContents.executeJavaScript(
      `window.renderIcon(${JSON.stringify(svg)}, ${item.size})`
    );
    const rgba = Buffer.from(res.rgba, 'base64');
    images.push({ size: item.size, rgba });
    if (item.size === 256) png256 = Buffer.from(res.png.split(',')[1], 'base64');
    const ink = rgba.reduce((a,v,i)=> (i%4===3 && v>0 ? a+1 : a), 0);
    console.log(`  渲染 ${item.size}x${item.size} (${item.svg})  ${rgba.length} 字节  非透明像素 ${ink}`);
  }

  const ico = buildIco(images);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  if (png256) fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png256);

  console.log(`\nbuild/icon.ico  ${ico.length} 字节（${images.length} 个尺寸）`);
  console.log(`build/icon.png  ${png256 ? png256.length : 0} 字节`);

  for (const size of [16, 32, 256]) {
    const img = images.find((i) => i.size === size);
    if (!img) continue;
    console.log(`\n${size}x${size} 预览：`);
    console.log(asciiPreview(size, img.rgba, size === 256 ? 52 : size));
    const ink = img.rgba.reduce((acc, v, i) => (i % 4 === 3 && v > 128 ? acc + 1 : acc), 0);
    console.log(`不透明像素占比: ${((ink / (size * size)) * 100).toFixed(1)}%`);
  }

  win.destroy();
  app.exit(0);
});
