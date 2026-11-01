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
const TAG = 'v1.0.5';
const ROOT = path.join(__dirname, '..');
const API = `https://api.github.com/repos/${REPO}`;

if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const BODY = `## 1.0.3 → 1.0.5

### 修复：分流规则全部失效（重要）

「绕过大陆」模式下百度等国内站点打不开。根因是上游规则文本其实是 YAML payload 片段
（\`payload:\` + \`- '+.x.com'\`），而解析脚本按「每行一条裸规则」处理，结果：

- \`payload:\` 这一行本身被当成一条规则
- \`- '+.x.com'\` 整行被当成一条规则

生成的 12.4 万条规则**格式全部错误，一条都匹配不上**。mihomo 会静默接受这种文件
（ruleCount 显示 11 万，看起来正常），但流量全落到 \`MATCH\` 兜底。

现在有三道防线：统一的解析模块、生成后自检、启动时再校验；并等所有 rule-provider
加载完才宣告就绪（11 万条域名解析比 IP 段慢，不等会让刚开启的流量走错）。

### 修复：关闭代理后改分流方式界面不更新

\`gateway.stop()\` 不会重置 \`routeMode\`，而状态组装又优先读它，导致
「关闭代理 → 把模式从全局改成绕过大陆 → 界面仍显示全局」。已改为：内核在跑以内核为准，
没跑以保存的设置为准。

### 新增：代理状态细分（6 态）

以前异常态全被显示成「已关闭」，用户不知道电脑处在什么情况。现在拆成：

| 状态 | 含义 |
|---|---|
| 已开启 | 内核在跑 + 系统代理指向本机网关 |
| **已失联** | 系统代理还指着网关，但内核已死 → **可能正在断网**，启动时主动告警并自动还原 |
| **被外部修改** | 内核在跑，但系统代理被别的程序改掉/关掉，点一下即可抢回 |
| 指向其它地址 | 系统代理开着但不是本工具写的 |
| 启动中 | 内核在跑但存活自检没过 |
| 已关闭 | 系统代理未开启 |

后台每 5 秒自检内核存活与系统代理归属，每 30 秒做一次真实出口探测；绿灯会带上
探测到的出口 IP，探测失败显示「链路异常」，不再出现「绿灯但连不上」。

### 同步自 IPHealth 1.0.3

- 订阅拉取改用 Chromium 网络栈（自动跟随系统代理、支持 HTTP/2）
- 补充 DNS 污染识别与可读诊断（被污染时直接告诉你该开代理）
- 新增「导出 Clash 配置」，可直接给内核用
- 检测菜单增加「仅测未测项 / 重测失败项」

### 安卓版

同仓库 \`android/\` 目录，功能对齐：导入、体检、筛选、三种分流、导出。
代理方式为 mixed 端口 + Wi-Fi 手动代理；VPN 模式需自行编译 libcore.aar。

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
    path.join(ROOT, 'dist', 'V2PTools-1.0.5-win-x64-portable.exe'),
    path.join(ROOT, 'dist', 'V2PTools-1.0.5-win-x64.zip'),
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
