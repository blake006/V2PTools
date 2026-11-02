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
const TAG = 'v1.0.7';
const ROOT = path.join(__dirname, '..');
const API = `https://api.github.com/repos/${REPO}`;

if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const BODY = `## 1.0.7 — 同步 IPHealth 1.0.10

### 订阅拉取：四条路，能通一条就够

被墙的订阅站，现在按顺序自动尝试：

1. 设置里填的「订阅拉取代理」；
2. 本机代理内核（自动借用它的 mixed 端口）；
3. 本机其它客户端 —— 自动探测 \`7890 / 7897 / 7891 / 10808 / 10809 / 1080 / 2080\` 谁在监听；
4. **借道已检测可用的节点**：用内核把延迟最低的前 3 个节点起成本地端口，订阅从节点出去拉，
   内核保留 60 秒供同一批同步复用。导入结果里会写明「经节点「HK-01」拉取」。

失败时也不再只说「拉取失败」：

- \`401/403/404\` → 订阅链接无效或已过期（不是网络问题）；
- \`5xx\` → 订阅服务端异常；
- 真连不上 → DNS 诊断 + 「本机 127.0.0.1:7897 有代理在监听，可在设置里填该端口」。

### 修复：双击打不开 / 窗口不显示

- 加**单实例锁**：多开会抢 7890 端口和系统代理，第二次启动直接把已有窗口叫到前面
  （最小化会还原、隐藏会显示、并闪烁任务栏）；
- 首帧 8 秒还没就绪也强制显示窗口，避免「进程活着但没窗口」；
- \`window-all-closed\` 改为同步退出，内核在 \`before-quit\` 里关 —— 之前窗口关了进程还赖着，
  占住单实例锁，下次双击就没反应。

### 其它

- 窗口标题带版本号，任务栏悬停 / Alt+Tab 直接能看到；
- 空列表加了「第一次用」引导：本机有客户端 / 手机能打开订阅 / 只有一条链接，三种情况分别怎么做；
- 新增 12 项订阅拉取测试（含本机端口探测与提示文案）+ 2 项「借道节点」链路测试（假 SOCKS5 + 真内核）。

---

**下载说明**

- \`portable.exe\`：单文件免安装，双击即用（推荐）
- \`.zip\`：解压版
- \`.apk\`：安卓版 1.0.6（debug 签名，需允许未知来源安装；要求 Android 8.0+、arm64）
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
    path.join(ROOT, 'dist', 'V2PTools-1.0.7-win-x64-portable.exe'),
    path.join(ROOT, 'dist', 'V2PTools-1.0.7-win-x64.zip'),
    path.join(ROOT, 'dist', 'V2PTools-android-1.0.6-debug.apk'),
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
