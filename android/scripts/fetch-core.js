'use strict';

/**
 * 下载 mihomo 安卓内核，放到 jniLibs 下并命名为 libmihomo.so。
 *
 * 为什么叫 .so：Android 只会把 jniLibs 里的 .so 解压到 nativeLibraryDir，
 * 而那个目录里的文件带可执行权限，可以直接 exec。放 assets 则要自己 chmod，
 * 且部分机型会因 noexec 挂载而失败。
 *
 * 用法:
 *   node scripts/fetch-core.js                 # 只下 arm64-v8a
 *   node scripts/fetch-core.js --all-abi       # 同时下 armeabi-v7a
 *   node scripts/fetch-core.js --version 1.19.33
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const JNI = path.join(ROOT, 'app', 'src', 'main', 'jniLibs');

const ABI_MAP = {
  'arm64-v8a': /android-arm64/i,
  'armeabi-v7a': /android-arm(?!64)/i,
};

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向过多'));
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'v2ptools-android-fetch',
          Accept: 'application/vnd.github+json',
        },
        timeout: 60000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(get(res.headers.location, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode + ' ' + url));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { allAbi: false, version: '' };
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--all-abi') out.allAbi = true;
    if (a[i] === '--version') out.version = a[++i] || '';
  }
  return out;
}

(async () => {
  const args = parseArgs();
  const abis = args.allAbi ? Object.keys(ABI_MAP) : ['arm64-v8a'];

  console.log('查询 mihomo 版本…');
  let tag = args.version;
  let assets = [];

  if (!tag) {
    const body = await get('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest');
    const rel = JSON.parse(body.toString('utf8'));
    tag = rel.tag_name;
    assets = rel.assets || [];
  } else {
    const body = await get(`https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${tag}`);
    const rel = JSON.parse(body.toString('utf8'));
    assets = rel.assets || [];
  }
  console.log('版本:', tag, ' 资源数:', assets.length);

  for (const abi of abis) {
    const re = ABI_MAP[abi];
    const asset = assets.find((x) => re.test(x.name) && /\.gz$/i.test(x.name));
    if (!asset) {
      console.log(`  跳过 ${abi}：未找到匹配的 gz 资源`);
      continue;
    }
    process.stdout.write(`  ${abi} ← ${asset.name} …`);
    // eslint-disable-next-line no-await-in-loop
    const gz = await get(asset.browser_download_url);
    const bin = zlib.gunzipSync(gz);

    const dir = path.join(JNI, abi);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'libmihomo.so');
    fs.writeFileSync(target, bin);
    console.log(` ${(bin.length / 1048576).toFixed(1)} MB → jniLibs/${abi}/libmihomo.so`);
  }

  console.log('\n完成。重新构建 APK 即可把内核打进去。');
  console.log('提示：内核较大（约 15-20MB），只保留需要的 ABI 可减小体积。');
})().catch((err) => {
  console.error('下载失败:', err.message);
  console.error('可以手动下载：https://github.com/MetaCubeX/mihomo/releases');
  console.error('解压后放到 app/src/main/jniLibs/arm64-v8a/libmihomo.so');
  process.exit(1);
});
