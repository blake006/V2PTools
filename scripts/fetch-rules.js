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
 * 文本 → payload 的转换统一放在 electron/lib/ruleFormat.js，
 * 与运行时的格式自检共用一套逻辑（历史上这里出过「规则全部失效」的 bug）。
 *
 * 用法: npm run fetch-rules
 */

const fs = require('fs');
const path = require('path');
const { parseRuleText, buildRuleYaml, validatePayload } = require('../electron/lib/ruleFormat');

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

(async () => {
  console.log(`拉取规则: ${OWNER}/${REPO}@${REF}`);
  const tree = await api(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${REF}?recursive=1`);
  const blobs = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let allOk = true;
  for (const item of FILES) {
    const sha = blobs.get(item.src);
    if (!sha) {
      console.log(`  跳过 ${item.src}（仓库里没有）`);
      continue;
    }
    process.stdout.write(`  ${item.desc} (${item.src})…`);
    const blob = await api(`https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${sha}`);
    const text = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');

    const items = parseRuleText(text);
    if (!items.length) {
      console.log(' 失败：解析出 0 条规则');
      allOk = false;
      continue;
    }

    // 自检：生成的结果必须是干净的值列表
    const v = validatePayload(items);
    if (!v.ok) {
      console.log(` 失败：解析结果仍含脏数据 ${JSON.stringify(v.bad)}`);
      allOk = false;
      continue;
    }

    const out = buildRuleYaml(items, {
      title: item.desc,
      source: `${OWNER}/${REPO}@${REF}/${item.src}`,
    });

    const target = path.join(OUT_DIR, item.out);
    fs.writeFileSync(target, out, 'utf8');
    console.log(` ${items.length} 条 → ${item.out} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
  }

  if (!allOk) {
    console.error('\n有规则文件生成失败，请检查上游格式是否变化。');
    process.exit(1);
  }

  console.log('\n完成。这些文件随包分发，运行时不联网。');
})().catch((err) => {
  console.error('拉取失败:', err.message);
  process.exit(1);
});
