'use strict';

/**
 * 下载分流规则并转换为 mihomo rule-provider 格式
 *
 * 数据源: Loyalsoldier/clash-rules (release 分支)
 *   direct.txt  → CN 直连域名（绕过大陆模式用）
 *   cncidr.txt  → CN IP 段（绕过大陆模式用）
 *   gfw.txt     → 被墙域名（仅名单模式用）
 *
 * 走 GitHub Git Data API（api.github.com 可直连，raw.githubusercontent.com 常被拦）
 * 输出: assets/rules/*.yaml （payload 格式，随包分发，运行时不需要联网）
 *
 * 用法: npm run fetch-rules
 */

const fs = require('fs');
const path = require('path');

const OWNER = 'Loyalsoldier';
const REPO = 'clash-rules';
const REF = 'release';
const OUT_DIR = path.join(__dirname, '..', 'assets', 'rules');

const FILES = [
  { src: 'direct.txt', out: 'cn-domain.yaml', behavior: 'domain', desc: 'CN 直连域名' },
  { src: 'cncidr.txt', out: 'cn-cidr.yaml', behavior: 'ipcidr', desc: 'CN IP 段' },
  { src: 'gfw.txt', out: 'gfw-domain.yaml', behavior: 'domain', desc: '被墙域名' },
];

async function api(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'V2PTools-fetch-rules',
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** 把每行一条的规则文本转成 mihomo rule-provider 的 YAML */
function toPayload(text) {
  const seen = new Set();
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    // 只保留域名/IP 本体，去掉 clash 规则前缀
    let v = line;
    if (/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6),/i.test(v)) {
      v = v.split(',').slice(1).join(',').trim();
    }
    if (!v || seen.has(v)) continue;
    seen.add(v);
    items.push(v);
  }
  return items;
}

function yamlEscape(s) {
  return /[:#\-{}\[\],&*?|<>=!%@`"']/.test(s) || /^\s|\s$/.test(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

(async () => {
  console.log(`拉取规则: ${OWNER}/${REPO}@${REF}`);
  const tree = await api(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${REF}?recursive=1`);
  const blobs = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const item of FILES) {
    const sha = blobs.get(item.src);
    if (!sha) {
      console.log(`  跳过 ${item.src}（仓库里没有）`);
      continue;
    }
    process.stdout.write(`  ${item.desc} (${item.src})…`);
    const blob = await api(`https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${sha}`);
    const text = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    const items = toPayload(text);

    const out = [
      `# ${item.desc} — 来源 ${OWNER}/${REPO}@${REF}/${item.src}`,
      `# 生成时间 ${new Date().toISOString()}  条目 ${items.length}`,
      'payload:',
      ...items.map((v) => `  - ${yamlEscape(v)}`),
      '',
    ].join('\n');

    const target = path.join(OUT_DIR, item.out);
    fs.writeFileSync(target, out, 'utf8');
    console.log(` ${items.length} 条 → ${item.out} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
  }

  console.log('\n完成。这些文件随包分发，运行时不联网。');
})().catch((err) => {
  console.error('拉取失败:', err.message);
  process.exit(1);
});
