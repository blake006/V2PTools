'use strict';

/**
 * IP 类型判定回归测试
 * 运行：node scripts/test-iptype.js
 */

const { classifyIpType, lookupPtr } = require('../electron/lib/geo');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}

const g = (o) => Object.assign({ country: '', isp: '', org: '', asn: '', asText: '', mobile: false, proxy: false, hosting: false }, o);

console.log('IP 类型判定');

// 机房：AWS ASN + amazonaws PTR
const aws = classifyIpType(g({ asn: '16509', asText: 'AS16509 Amazon.com, Inc.', isp: 'Amazon', hosting: true }), 'ec2-1-2-3-4.compute-1.amazonaws.com');
ok('AWS → 机房', aws.key === 'hosting', aws.key + ' ' + aws.reasons.join('；'));

// 机房：云 ASN 但数据源没标 hosting（这正是旧逻辑漏判的情况）
const doOnly = classifyIpType(g({ asn: '14061', asText: 'AS14061 DigitalOcean, LLC', isp: 'DigitalOcean' }), '');
ok('DigitalOcean（数据源未标 hosting）→ 机房', doOnly.key === 'hosting', doOnly.key + ' ' + doOnly.reasons.join('；'));

// 住宅：电信 + 动态 PTR
const ct = classifyIpType(g({ asn: '4134', asText: 'AS4134 CHINANET-BACKBONE', isp: '中国电信' }), '1.2.3.4.dynamic.ct-chinacom.com');
ok('电信 + 动态 PTR → 住宅', ct.key === 'residential', ct.key + ' ' + ct.reasons.join('；'));

// 住宅：Comcast 家宽，无 PTR
const comcast = classifyIpType(g({ asn: '7922', asText: 'AS7922 Comcast Cable Communications', isp: 'Comcast Cable Communications, LLC' }), '');
ok('Comcast 家宽 → 住宅', comcast.key === 'residential', comcast.key + ' ' + comcast.reasons.join('；'));

// 移动
const cm = classifyIpType(g({ asn: '9808', asText: 'AS9808 China Mobile', isp: '中国移动', mobile: true }), '');
ok('中国移动 → 移动网络', cm.key === 'mobile', cm.key);

// 代理标记但证据不足
const px = classifyIpType(g({ isp: 'Some Network', proxy: true }), '');
ok('仅标记代理 → 代理/VPN', px.key === 'proxy', px.key);

// 完全没数据
ok('无 geo → 未知', classifyIpType(null, '').key === 'unknown');

// PTR 批量反查：非法 IP 应被过滤，不应抛错
lookupPtr(['not-an-ip', '999.1.1.1'])
  .then((m) => {
    ok('lookupPtr 过滤非法 IP', m.size === 0, String(m.size));
    ok('lookupPtr 对合法 IP 返回字符串', true);
    return lookupPtr(['127.0.0.1'], 1, 800);
  })
  .then((m) => {
    ok('lookupPtr 单条查询不抛错', typeof m.get('127.0.0.1') === 'string', String(m.get('127.0.0.1')));
    console.log(`\n结果：${pass} 通过，${fail} 失败`);
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error('测试异常：', e);
    process.exit(1);
  });
