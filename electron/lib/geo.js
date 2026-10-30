'use strict';

/**
 * IP 归属地 / 类型 / 黑名单 / 健康度评分
 */

const http = require('http');
const dns = require('dns');

const GEO_FIELDS =
  'status,message,country,countryCode,regionName,city,isp,org,as,asname,mobile,proxy,hosting,query';

function httpPostJson(host, path, payload, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        host,
        path,
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'User-Agent': 'IPHealth/1.0',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end(body);
  });
}

function httpGetJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'IPHealth/1.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('响应解析失败'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/** 批量查询归属地（ip-api 批量接口，一次最多 100 个） */
async function lookupBatch(ips) {
  const unique = [...new Set(ips.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)))];
  const result = new Map();
  if (!unique.length) return result;

  const chunks = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));

  for (const chunk of chunks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const list = await httpPostJson('ip-api.com', `/batch?fields=${GEO_FIELDS}&lang=zh-CN`, chunk);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.query && item.status === 'success') {
            result.set(item.query, {
              country: item.country || '',
              countryCode: item.countryCode || '',
              region: item.regionName || '',
              city: item.city || '',
              isp: item.isp || '',
              org: item.org || '',
              asn: (item.as || '').split(' ')[0] || '',
              asText: item.as || '',
              mobile: !!item.mobile,
              proxy: !!item.proxy,
              hosting: !!item.hosting,
            });
          }
        }
      }
    } catch (e) {
      /* 批量失败，走单条兜底 */
    }
  }

  // 兜底：ipinfo.io
  const missing = unique.filter((ip) => !result.has(ip));
  for (const ip of missing.slice(0, 60)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const d = await httpGetJson(`https://ipinfo.io/${ip}/json`, 6000);
      if (d && d.ip) {
        result.set(ip, {
          country: d.country || '',
          countryCode: d.country || '',
          region: d.region || '',
          city: d.city || '',
          isp: d.org || '',
          org: d.org || '',
          asn: (d.org || '').split(' ')[0] || '',
          asText: d.org || '',
          mobile: false,
          proxy: false,
          hosting: false,
        });
      }
    } catch (e) {}
  }
  return result;
}

const DNSBL_ZONES = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus' },
  { zone: 'bl.spamcop.net', name: 'SpamCop' },
  { zone: 'all.s5h.net', name: 's5h.net' },
  { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT' },
];

function resolve4WithTimeout(name, timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve([]);
      }
    }, timeout);
    dns.resolve4(name, (err, addrs) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(err ? [] : addrs || []);
    });
  });
}

/** DNSBL 黑名单查询 */
async function checkDnsbl(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { listed: [], checked: 0 };
  const rev = ip.split('.').reverse().join('.');
  const results = await Promise.all(
    DNSBL_ZONES.map(async (z) => {
      const addrs = await resolve4WithTimeout(`${rev}.${z.zone}`, 2500);
      const hit = addrs.find((a) => a.startsWith('127.') && !a.startsWith('127.255.255'));
      return hit ? z.name : null;
    })
  );
  return { listed: results.filter(Boolean), checked: DNSBL_ZONES.length };
}

/** IP 类型标签 */
function ipTypeLabel(geo) {
  if (!geo) return '未知';
  if (geo.mobile) return '移动网络';
  if (geo.proxy && geo.hosting) return '机房/代理';
  if (geo.hosting) return '机房 IDC';
  if (geo.proxy) return '代理/VPN';
  if (/comcast|verizon|at&t|charter|cox|电信|联通|移动|broadband|telecom|unicom/i.test(geo.isp || '')) {
    return '住宅宽带';
  }
  return '普通 IP';
}

/**
 * 健康度评分 0-100
 * 维度：代理特征 / 机房特征 / 黑名单 / 延迟 / 速度
 */
function scoreHealth({ geo, dnsbl, latency, speed }) {
  let score = 100;
  const reasons = [];

  if (geo) {
    if (geo.proxy && geo.hosting) {
      score -= 45;
      reasons.push('检测为代理且为机房 IP');
    } else if (geo.proxy) {
      score -= 32;
      reasons.push('检测为代理/VPN');
    } else if (geo.hosting) {
      score -= 22;
      reasons.push('机房/IDC IP');
    }
    if (geo.mobile) {
      score += 2;
      reasons.push('移动网络出口');
    }
  } else {
    score -= 10;
    reasons.push('归属地未知');
  }

  if (dnsbl && dnsbl.listed && dnsbl.listed.length) {
    const pen = Math.min(30, dnsbl.listed.length * 12);
    score -= pen;
    reasons.push(`黑名单命中 ${dnsbl.listed.join('/')}`);
  }

  if (typeof latency === 'number' && latency > 0) {
    if (latency > 2000) score -= 18;
    else if (latency > 1000) score -= 10;
    else if (latency > 500) score -= 5;
  }

  if (typeof speed === 'number' && speed > 0) {
    if (speed < 0.5) score -= 14;
    else if (speed < 2) score -= 8;
    else if (speed < 8) score -= 3;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}

function healthLevel(score) {
  if (score == null) return { key: 'unknown', text: '未检测' };
  if (score >= 85) return { key: 'excellent', text: '优秀' };
  if (score >= 70) return { key: 'good', text: '良好' };
  if (score >= 50) return { key: 'fair', text: '一般' };
  return { key: 'bad', text: '较差' };
}

module.exports = { lookupBatch, checkDnsbl, ipTypeLabel, scoreHealth, healthLevel, DNSBL_ZONES };
