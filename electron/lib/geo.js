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

/* ------------------------------------------------------------------ */
/* IP 类型判定：ASN 名单 + PTR 反查 + 数据源标记，三路信号加权          */
/* ------------------------------------------------------------------ */

/**
 * 常见云厂商 / 机房 ASN。
 * ip-api 的 hosting 字段对很多小机房会漏判，ASN 是更硬的证据。
 */
const CLOUD_ASN = new Set([
  '16509', '14618', '8987', // AWS
  '13335', // Cloudflare
  '15169', '396982', // Google / GCP
  '8075', '8068', // Azure
  '14061', // DigitalOcean
  '63949', '48337', // Linode / Akamai
  '20473', '64515', // Vultr / Choopa
  '16276', // OVH
  '24940', '213230', // Hetzner
  '45102', '37963', // 阿里云
  '132203', '45090', // 腾讯云
  '136907', '55990', // 华为云
  '31898', '14413', // Oracle Cloud
  '51167', '24961', // Contabo
  '12876', // Scaleway
  '202053', // UpCloud
  '53667', // BuyVM / FranTech
  '36352', // RackNerd / ColoCrossing
  '40676', // Psychz
  '62240', // Clouvider
  '9009', // M247
  '60068', // Datacamp
  '209854', // 一些小型 VPS 商
]);

/** ASN 名称里的机房关键字（ip-api 会返回 asname / as 文本） */
const CLOUD_ASNAME = /hosting|cloud|datacenter|data center|server|vps|colo|dedicated|compute|cdn/i;
/** ASN 名称里的住宅/运营商关键字 */
const RESI_ASNAME = /broadband|telecom|communications|unicom|mobile|wireless|cellular|telefonica|orange|vodafone|comcast|verizon|at&t|charter|cox|centurylink|frontier|bt group|sky|virgin|kddi|softbank|ntt|hinet|chinanet|cmnet|ctc/i;

/** 机房 PTR 特征 */
const CLOUD_PTR = [
  /amazonaws\.com/i, /vultr/i, /digitalocean/i, /linode/i, /ovh\./i, /hetzner/i,
  /contabo/i, /colocrossing/i, /psychz/i, /choopa/i, /leaseweb/i, /googleusercontent/i,
  /cloudfront/i, /akamai/i, /azure/i, /aliyun/i, /alibaba/i, /tencent/i, /huawei/i,
  /oraclecloud/i, /scaleway/i, /upcloud/i, /racknerd/i, /hosthatch/i, /bandwagonhost/i,
  /m247/i, /datacamp/i, /vps/i, /dedicated/i, /server/i, /hosting/i, /colo/i, /cloud/i,
];
/** 住宅 / 动态拨号 PTR 特征 */
const RESI_PTR = [
  /dynamic/i, /ppp/i, /dsl/i, /broadband/i, /cable/i, /pool/i, /dhcp/i,
  /hinet-ip/i, /bbtec/i, /ocn\.ne\.jp/i, /bigpond/i, /comcast/i, /verizon/i,
  /charter/i, /cox\.net/i, /163data/i, /ctm/i, /static.*res/i,
];
/** 住宅 ISP 名称特征 */
const RESI_ISP = [
  /电信/, /联通/, /移动/, /广电/, /铁通/, /chinanet/i, /unicom/i, /cmnet/i,
  /comcast/i, /verizon/i, /at&t/i, /charter/i, /cox/i, /centurylink/i, /frontier/i,
  /bt\./i, /sky broadband/i, /virgin media/i, /deutsche telekom/i, /orange/i,
  /vodafone/i, /telstra/i, /optus/i, /ntt/i, /kddi/i, /softbank/i, /hinet/i,
];
/** 移动网络特征 */
const MOBILE_ISP = [/mobile/i, /wireless/i, /cellular/i, /\b4g\b/i, /\b5g\b/i, /\blte\b/i, /移动.*(数据|网络)/];

/**
 * 批量反查 PTR（并发受限）。
 * 住宅 IP 常有 dynamic/ppp/dsl 之类的动态域名，机房则多是 *amazonaws.com 这类。
 */
function lookupPtr(ips, concurrency = 8, timeout = 2500) {
  const out = new Map();
  const valid = (ip) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
    return !!m && m.slice(1).every((x) => Number(x) <= 255);
  };
  const list = [...new Set(ips.filter(valid))];
  let cursor = 0;

  const worker = () =>
    new Promise((resolve) => {
      const step = () => {
        if (cursor >= list.length) return resolve();
        const ip = list[cursor];
        cursor += 1;
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          out.set(ip, '');
          step();
        }, timeout);
        const finish = (name) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          out.set(ip, name || '');
          step();
        };
        try {
          dns.reverse(ip, (err, names) => finish(!err && names && names.length ? String(names[0]) : ''));
        } catch (e) {
          // 非法地址（如 999.1.1.1）会同步抛 EINVAL，别让整个批次挂掉
          finish('');
        }
      };
      step();
    });

  return Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker)).then(() => out);
}

/**
 * 综合判定 IP 类型。
 * 三路信号加权：ASN 名单/名称、PTR 反查、数据源标记（hosting/proxy/mobile）。
 * 宁可判「未知」也不要把机房 IP 说成住宅——用户拿这个筛住宅代理，误判代价更高。
 */
function classifyIpType(geo, ptr) {
  if (!geo) return { key: 'unknown', label: '未知', confidence: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  const asn = String(geo.asn || '').replace(/[^0-9]/g, '');
  const asText = `${geo.asText || ''} ${geo.org || ''}`;

  if (asn && CLOUD_ASN.has(asn)) {
    score -= 5;
    reasons.push(`AS${asn} 属云/机房`);
  }
  if (asText && CLOUD_ASNAME.test(asText)) {
    score -= 3;
    reasons.push('ASN 名称含机房关键词');
  }
  if (asText && RESI_ASNAME.test(asText)) {
    score += 2;
    reasons.push('ASN 名称像运营商');
  }
  if (geo.hosting) {
    score -= 3;
    reasons.push('数据源标记为机房');
  }
  if (geo.proxy) {
    score -= 2;
    reasons.push('数据源标记为代理');
  }
  if (geo.mobile) {
    score += 2;
    reasons.push('数据源标记为移动网络');
  }

  if (ptr) {
    if (CLOUD_PTR.some((r) => r.test(ptr))) {
      score -= 4;
      reasons.push(`PTR「${ptr}」像机房`);
    } else if (RESI_PTR.some((r) => r.test(ptr))) {
      score += 4;
      reasons.push(`PTR「${ptr}」像动态宽带`);
    }
  } else {
    reasons.push('无 PTR 记录');
  }

  if (RESI_ISP.some((r) => r.test(geo.isp || ''))) {
    score += 3;
    reasons.push(`ISP「${geo.isp}」像家庭宽带`);
  }

  const isMobile = geo.mobile || MOBILE_ISP.some((r) => r.test(geo.isp || ''));
  if (isMobile && score > -3) {
    return { key: 'mobile', label: '移动网络', confidence: Math.min(95, 55 + score * 6), reasons };
  }
  if (score <= -3) {
    return { key: 'hosting', label: '机房 IDC', confidence: Math.min(95, 55 + -score * 6), reasons };
  }
  if (score >= 3) {
    return { key: 'residential', label: '住宅宽带', confidence: Math.min(95, 55 + score * 6), reasons };
  }
  // 证据不足时，代理标记优先于「普通 IP」
  if (geo.proxy) return { key: 'proxy', label: '代理/VPN', confidence: 45, reasons };
  return { key: 'unknown', label: '普通 IP', confidence: 30, reasons };
}

/**
 * 健康度评分 0-100
 * 维度：代理特征 / 机房特征 / 黑名单 / 延迟 / 速度
 */
function scoreHealth({ geo, dnsbl, latency, speed, ipTypeKey }) {
  let score = 100;
  const reasons = [];

  if (geo) {
    // 优先用分类结论（ASN 名单 + PTR），比只看 hosting 字段准
    if (ipTypeKey === 'hosting') {
      score -= 22;
      reasons.push('机房/IDC IP');
    } else if (ipTypeKey === 'proxy') {
      score -= 32;
      reasons.push('代理/VPN 特征');
    } else if (ipTypeKey === 'residential') {
      score += 4;
      reasons.push('住宅宽带出口');
    } else if (ipTypeKey === 'mobile') {
      score += 2;
      reasons.push('移动网络出口');
    } else if (geo.proxy && geo.hosting) {
      score -= 45;
      reasons.push('检测为代理且为机房 IP');
    } else if (geo.proxy) {
      score -= 32;
      reasons.push('检测为代理/VPN');
    } else if (geo.hosting) {
      score -= 22;
      reasons.push('机房/IDC IP');
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

module.exports = {
  lookupBatch,
  lookupPtr,
  classifyIpType,
  checkDnsbl,
  ipTypeLabel,
  scoreHealth,
  healthLevel,
  DNSBL_ZONES,
  CLOUD_ASN,
};
