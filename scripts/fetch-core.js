'use strict';

/**
 * 下载 mihomo 内核到 vendor/mihomo.exe
 * 用法: npm run fetch-core
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const VERSION = process.env.MIHOMO_VERSION || 'v1.19.33';
const ASSET = `mihomo-windows-amd64-${VERSION}.zip`;
const MIRRORS = [
  `https://ghfast.top/https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/${ASSET}`,
  `https://gh-proxy.com/https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/${ASSET}`,
  `https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/${ASSET}`,
];

const outDir = path.join(__dirname, '..', 'vendor');
const target = path.join(outDir, 'mihomo.exe');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向过多'));
    https
      .get(url, { headers: { 'User-Agent': 'IPHealth-build' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total) process.stdout.write(`\r下载中 ${((got / total) * 100).toFixed(1)}%  ${(got / 1048576).toFixed(1)}MB`);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            process.stdout.write('\n');
            resolve(dest);
          });
        });
      })
      .on('timeout', function onTimeout() {
        this.destroy(new Error('超时'));
      })
      .on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(target) && !process.argv.includes('--force')) {
    console.log('已存在 vendor/mihomo.exe，跳过（加 --force 强制重新下载）');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const tmpZip = path.join(os.tmpdir(), 'mihomo.zip');
  const tmpDir = path.join(os.tmpdir(), 'mihomo-extract');

  let ok = false;
  for (const url of MIRRORS) {
    try {
      console.log('尝试下载:', url);
      // eslint-disable-next-line no-await-in-loop
      await download(url, tmpZip);
      ok = true;
      break;
    } catch (e) {
      console.log('失败:', e.message);
    }
  }
  if (!ok) {
    console.error('内核下载失败，请手动下载后放到 vendor/mihomo.exe');
    process.exit(1);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${tmpDir}' -Force`], {
    stdio: 'inherit',
  });
  // 发行包里的文件名是 mihomo-windows-amd64.exe，不能只匹配 mihomo.exe
  const exe = fs.readdirSync(tmpDir).find((f) => /^mihomo.*\.exe$/i.test(f));
  if (!exe) {
    console.error('压缩包内未找到 mihomo 可执行文件');
    process.exit(1);
  }
  fs.copyFileSync(path.join(tmpDir, exe), target);
  const size = (fs.statSync(target).size / 1048576).toFixed(1);
  console.log(`完成: vendor/mihomo.exe (${size} MB)`);
})();
