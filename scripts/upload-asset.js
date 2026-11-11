'use strict';

/**
 * 流式上传 release 附件。
 *
 * 为什么不用 readFileSync：zip 有 127MB，一次性读进内存会报
 * "Array buffer allocation failed"（尤其磁盘/内存紧张时）。
 * 这里用 createReadStream + duplex:'half' 边读边传。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/upload-asset.js v1.4.9 dist/xxx.zip dist/xxx.exe
 */

const fs = require('fs');
const path = require('path');

const REPO = process.env.V2P_REPO || 'blake006/V2PTools';
const TAG = process.argv[2];
const files = process.argv.slice(3);
const TOKEN = process.env.GH_TOKEN;

if (!TAG || !files.length) {
  console.error('用法: GH_TOKEN=xxx node scripts/upload-asset.js <tag> <file...>');
  process.exit(1);
}
if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const API = `https://api.github.com/repos/${REPO}`;
const UPLOADS = `https://uploads.github.com/repos/${REPO}`;
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'v2ptools-uploader',
  Accept: 'application/vnd.github+json',
};

async function main() {
  const relRes = await fetch(`${API}/releases/tags/${TAG}`, { headers });
  if (!relRes.ok) throw new Error(`取 release ${TAG} 失败: ${relRes.status}`);
  const rel = await relRes.json();
  const have = new Set((rel.assets || []).map((a) => a.name));
  console.log(`release ${rel.id} 已有附件: ${[...have].join(', ') || '无'}`);

  for (const file of files) {
    const name = path.basename(file);
    if (have.has(name)) {
      console.log(`  ${name} 已存在，跳过`);
      continue;
    }
    if (!fs.existsSync(file)) {
      console.log(`  ${name} 本地不存在，跳过`);
      continue;
    }
    const size = fs.statSync(file).size;
    console.log(`  上传 ${name} (${(size / 1048576).toFixed(1)}MB)…`);

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${UPLOADS}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(size),
          },
          body: fs.createReadStream(file),
          duplex: 'half',
        });
        if (res.ok) {
          const j = await res.json();
          console.log(`    ✓ 成功 (${Math.round(j.size / 1048576)}MB)`);
          ok = true;
        } else {
          const t = await res.text().catch(() => '');
          console.log(`    第 ${attempt} 次失败 ${res.status} ${t.slice(0, 120)}`);
        }
      } catch (e) {
        console.log(`    第 ${attempt} 次异常: ${e.message}`);
      }
      if (!ok) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!ok) console.log(`    ✗ 放弃 ${name}`);
  }

  const after = await (await fetch(`${API}/releases/tags/${TAG}`, { headers })).json();
  console.log(
    '最终附件:',
    (after.assets || []).map((a) => `${a.name} ${Math.round(a.size / 1048576)}MB`).join(' | ') || '无'
  );
}

main().catch((e) => {
  console.error('出错:', e.message);
  process.exit(1);
});
