'use strict';

/**
 * 分享链接生成测试
 * 运行：node scripts/test-share.js
 */

const { toShareLink } = require('../renderer/share');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  }
}

console.log('分享链接生成');

// 用户给的 anytls 例子
const anytls = {
  id: 'n1',
  type: 'anytls',
  server: 'gho107.icuvdproduction.org',
  port: 18443,
  name: '[anytls]香港7-v6-移动联通优化',
  conf: {
    password: '6cfbc3ea-f5ba-43b7-a25a-5bd2bb76a4a0',
    sni: 'd1--ov-gotcha07.bilivideo.com',
    'skip-cert-verify': true,
  },
};
const a = toShareLink(anytls);
ok('anytls 前缀正确', a.startsWith('anytls://6cfbc3ea-f5ba-43b7-a25a-5bd2bb76a4a0@gho107.icuvdproduction.org:18443?'), a);
ok('anytls 带 insecure=1', /[?&]insecure=1/.test(a), a);
ok('anytls 带 sni', /[?&]sni=d1--ov-gotcha07\.bilivideo\.com/.test(a), a);
ok('anytls 带 security=tls', /security=tls/.test(a), a);
ok('anytls 带 type=tcp&headerType=none', /type=tcp/.test(a) && /headerType=none/.test(a), a);
ok('anytls 名称做了 URL 编码', a.includes('#%5Banytls%5D'), a.split('#').pop());

// 有原始链接时原样返回
const rawNode = Object.assign({}, anytls, { raw: 'anytls://x@1.2.3.4:443?sni=a.com#原样' });
ok('有 raw 时原样返回', toShareLink(rawNode) === rawNode.raw);

// vless
const vless = {
  type: 'vless',
  server: 'a.example.com',
  port: 443,
  name: 'HK',
  conf: { uuid: '11111111-2222-3333-4444-555555555555', tls: true, sni: 'a.example.com', network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'a.example.com' } } },
};
const v = toShareLink(vless);
ok('vless 前缀正确', v.startsWith('vless://11111111-2222-3333-4444-555555555555@a.example.com:443?'), v);
ok('vless 带 type=ws 与 path', /type=ws/.test(v) && /path=%2Fws/.test(v), v);
ok('vless 带 security=tls', /security=tls/.test(v), v);

// vmess 是 base64 JSON
const vmess = {
  type: 'vmess',
  server: 'b.example.com',
  port: 8443,
  name: 'JP',
  conf: { uuid: 'u-1', alterId: 0, network: 'tcp', tls: true },
};
const m = toShareLink(vmess);
ok('vmess 是 base64', /^vmess:\/\/[A-Za-z0-9+/=]+$/.test(m), m);
const decoded = JSON.parse(Buffer.from(m.slice(8), 'base64').toString('utf8'));
ok('vmess 解出的字段正确', decoded.add === 'b.example.com' && decoded.port === '8443' && decoded.id === 'u-1', JSON.stringify(decoded));

// ss
const ss = { type: 'ss', server: 'c.example.com', port: 8388, name: 'SG', conf: { cipher: 'aes-128-gcm', password: 'pw' } };
const s = toShareLink(ss);
ok('ss 使用 SIP002', /^ss:\/\/[A-Za-z0-9+/=]+@c\.example\.com:8388#/.test(s), s);
ok('ss userinfo 可解码', Buffer.from(s.slice(5).split('@')[0], 'base64').toString() === 'aes-128-gcm:pw', s);

// 不支持的协议返回空串（UI 会提示）
ok('ssr 无 raw 时返回空', toShareLink({ type: 'ssr', server: 'x', port: 1, conf: {} }) === '');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
