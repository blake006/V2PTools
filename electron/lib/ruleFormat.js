'use strict';

/**
 * 规则文本 → rule-provider payload 的转换
 *
 * 上游 Loyalsoldier/clash-rules 的 .txt 有两种可能形态：
 *   A) 裸规则，每行一条：          +.google.com
 *                                1.2.3.0/24
 *                                DOMAIN-SUFFIX,google.com
 *   B) 已是 YAML payload 片段：    payload:
 *                                   - '+.google.com'
 *                                   - '- ''+.x.com'''
 *
 * 历史 bug：早期只按 A 处理，把 B 形态原样塞进列表，结果 `payload:` 本身成了
 * 一条规则、`- '+.x.com'` 整行成了另一条规则 —— 生成的 12 万条规则全部匹配不上，
 * 「绕过大陆 / 仅名单」两种分流方式形同虚设（表现为百度等国内站点也打不开）。
 *
 * 这个模块同时被 scripts/fetch-rules.js（生成规则）和
 * electron/lib/gateway.js（加载时自检）使用，保证两边判断一致。
 */

/** 剥掉 YAML 列表前缀 "- " */
function stripListMark(line) {
  return line.replace(/^-\s+/, '').trim();
}

/**
 * 剥掉 YAML 标量外层的引号。
 *
 * 上游文件里出现过这些形态（逐层套娃）：
 *   '+.a.com'
 *   '- ''+.a.com'''      ← 整行被当成字符串，里面是 "- '+.a.com'"
 *
 * 单引号 YAML 的转义规则是 '' → '，所以不能简单地用正则配对，
 * 用一个小状态机逐字符扫描：只有引号完全闭合、且闭合后无残留时才剥离。
 */
function stripQuotes(s) {
  let v = s;
  for (let round = 0; round < 4; round += 1) {
    const first = v[0];
    if (first !== "'" && first !== '"') break;
    if (v.length < 2) break;

    let out = '';
    let i = 1;
    let closed = false;
    if (first === "'") {
      while (i < v.length) {
        if (v[i] === "'") {
          if (v[i + 1] === "'") {
            out += "'"; // '' 转义成单个 '
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        out += v[i];
        i += 1;
      }
    } else {
      while (i < v.length) {
        if (v[i] === '\\' && i + 1 < v.length) {
          out += v[i + 1];
          i += 2;
          continue;
        }
        if (v[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        out += v[i];
        i += 1;
      }
    }
    // 引号没闭合，或后面还有残留内容 → 不是纯引号包裹，停止剥壳
    if (!closed || v.slice(i).trim() !== '') break;
    v = out.trim();
  }
  return v;
}

/** 结合 list mark + 引号剥离，反复剥到稳定（处理 - '- ''x''' 这种嵌套） */
function stripShell(line) {
  let v = line.trim();
  for (let i = 0; i < 4; i += 1) {
    const before = v;
    v = stripListMark(v);
    v = stripQuotes(v);
    v = v.trim();
    if (v === before) break;
  }
  return v;
}

/** 剥掉 clash 规则类型前缀，只留值 */
function stripRulePrefix(v) {
  if (!/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR6?|GEOIP|PROCESS-NAME),/i.test(v)) return v;
  let out = v.split(',').slice(1).join(',').trim();
  out = out.replace(/,\s*no-resolve\s*$/i, '').trim();
  return out;
}

/**
 * @param {string} text 规则文件全文
 * @returns {string[]} 纯值列表（去重、去空、保序）
 */
function parseRuleText(text) {
  const seen = new Set();
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    // payload / rules 容器声明行
    if (/^(payload|rules)\s*:\s*$/i.test(t)) continue;

    let v = stripShell(t);
    if (!v || v.startsWith('#')) continue;
    v = stripRulePrefix(v);
    if (!v) continue;
    // 剥壳后仍以 "- " 开头 → 异常行，丢弃而不是污染规则
    if (v.startsWith('- ')) continue;
    // 跳过仍是容器名的漏网之鱼
    if (/^(payload|rules)\s*:\s*$/i.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    items.push(v);
  }
  return items;
}

/** 值的 YAML 安全序列化 */
function yamlEscape(s) {
  if (s === '') return "''";
  return /[:#\-{}\[\],&*?|<>=!%@`"']/.test(s) || /^\s|\s$/.test(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

/** 生成 mihomo rule-provider 的 YAML 全文 */
function buildRuleYaml(items, { title, source } = {}) {
  const head = [];
  if (title) head.push(`# ${title}`);
  if (source) head.push(`# 来源 ${source}`);
  head.push(`# 生成时间 ${new Date().toISOString()}  条目 ${items.length}`);
  return [...head, 'payload:', ...items.map((v) => `  - ${yamlEscape(v)}`), ''].join('\n');
}

/**
 * 校验一份 rule-provider YAML 的 payload 是否干净。
 * 用于启动自检：发现历史格式的脏数据时给出明确报错，而不是静默失效。
 * @returns {{ ok: boolean, count: number, bad: string[] }}
 */
function validatePayload(payload) {
  const bad = [];
  if (!Array.isArray(payload)) return { ok: false, count: 0, bad: ['payload 不是数组'] };
  for (const v of payload) {
    if (typeof v !== 'string') {
      bad.push(String(v));
      continue;
    }
    if (v.startsWith('- ') || /^(payload|rules)\s*:\s*$/i.test(v)) bad.push(v);
  }
  return { ok: bad.length === 0, count: payload.length, bad: bad.slice(0, 5) };
}

module.exports = {
  parseRuleText,
  yamlEscape,
  buildRuleYaml,
  validatePayload,
  stripShell,
  stripQuotes,
  stripRulePrefix,
};
