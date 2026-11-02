'use strict';

/**
 * 创建 GitHub Release 并上传构建产物。
 *
 * 为什么走 Release 而不是提交进仓库：
 *   dist/ 里的 zip 有 126MB，超过 GitHub 单文件 100MB 硬限制，git 根本推不上去；
 *   二进制产物本来也不该进 git 历史。Release 附件支持最大 2GB，是正确位置。
 *
 * 用法: GH_TOKEN=xxx node scripts/_make-release.js
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const REPO = 'blake006/V2PTools';
const TAG = 'v1.0.6';
const ROOT = path.join(__dirname, '..');
const API = `https://api.github.com/repos/${REPO}`;

if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const BODY = `## 1.0.6 — 订阅拉取修复

### 修复：订阅拉取超时，被墙的订阅站拉不下来

两层原因叠加：

1. 拉取模块虽然已经支持「走代理」，但主进程调用时**没把代理参数传进去**，实际永远直连；
2. 这类订阅站的域名普遍被 DNS 污染（例如 \`www.101ghost.pw\` 被解析到 \`93.46.8.90\`，典型 GFW 注入地址），直连 100% 超时。

现在：

- 设置 → 订阅拉取，可以填本机代理端口（\`7890\` 或 \`127.0.0.1:7890\`）；
- 留空时**自动借用已开启的本机代理内核端口**，不用再手填；
- 代理与直连**并发竞速**，谁先成功用谁，不再「先干等 30 秒再报超时」；
- 失败时带上 DNS 诊断，能直接区分「被污染 / 解析不到 / 服务端不可达」。

### 其它

- 新增 9 项订阅拉取回归测试（本地起目标站 + 记录命中的 HTTP 代理，覆盖代理命中、超时、错误文案）；
- 界面自检覆盖新增的设置字段。

---

**下载说明**

- \`portable.exe\`：单文件免安装，双击即用（推荐）
- \`.zip\`：解压版
- \`.apk\`：安卓版（debug 签名，需允许未知来源安装；要求 Android 8.0+、arm64）
`;

function fmt(b) {
  return (b / 1048576).toFixed(1) + ' MB';
}

/** 按扩展名给出正确的 Content-Type（不设的话 GitHub 一律记成 octet-stream） */
const CONTENT_TYPES = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.dmg': 'application/x-apple-diskimage',
};

function contentTypeOf(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'v2p-release',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** 上传单个附件（走 uploads.github.com，可超过 100MB） */
async function uploadAsset(releaseId, file) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;

  process.stdout.write(`  上传 ${name} (${fmt(size)}) …`);

  // 已存在同名附件则先删掉，方便重跑
  const existing = await api(`${API}/releases/${releaseId}/assets`).catch(() => []);
  for (const a of existing || []) {
    if (a.name === name) {
      await api(`${API}/releases/assets/${a.id}`, 'DELETE');
    }
  }

  const buf = fs.readFileSync(file);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': contentTypeOf(file),
      'Content-Length': String(buf.length),
      'User-Agent': 'v2p-release',
    },
    body: buf,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  console.log(` 完成（${fmt(data.size)}）`);
  return data;
}

(async () => {
  const assets = [
    path.join(ROOT, 'dist', 'V2PTools-1.0.6-win-x64-portable.exe'),
    path.join(ROOT, 'dist', 'V2PTools-1.0.6-win-x64.zip'),
    path.join(ROOT, 'dist', 'V2PTools-android-1.0.0-debug.apk'),
  ];

  for (const f of assets) {
    if (!fs.existsSync(f)) throw new Error('缺少产物: ' + f);
  }

  console.log('创建 Release', TAG, '…');
  let rel;
  try {
    rel = await api(`${API}/releases/tags/${TAG}`);
    console.log('  已存在，复用 id=' + rel.id);
  } catch (e) {
    rel = await api(`${API}/releases`, 'POST', {
      tag_name: TAG,
      target_commitish: 'main',
      name: `V2PTools ${TAG}`,
      body: BODY,
      draft: false,
      prerelease: false,
    });
    console.log('  已创建 id=' + rel.id);
  }

  console.log('上传附件：');
  for (const f of assets) {
    // eslint-disable-next-line no-await-in-loop
    await uploadAsset(rel.id, f);
  }

  const done = await api(`${API}/releases/tags/${TAG}`);
  console.log('\n完成。附件列表：');
  for (const a of done.assets) {
    console.log(`  ${a.name}  ${fmt(a.size)}`);
    console.log(`    ${a.browser_download_url}`);
  }
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
