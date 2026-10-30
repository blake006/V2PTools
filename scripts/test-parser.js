'use strict';

const parser = require('../electron/lib/parser');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

const samples = {
  vmess: 'vmess://' + b64(JSON.stringify({
    v: '2', ps: 'HK-01', add: 'hk1.example.com', port: 443, id: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    aid: 0, scy: 'auto', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ws', tls: 'tls', sni: 'cdn.example.com',
  })),
  vless_reality: 'vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:8443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0&sid=1a2b&type=grpc&serviceName=grpcsvc&flow=xtls-rprx-vision#JP-Reality',
  trojan_ws: 'trojan://pass123@tr.example.com:443?sni=tr.example.com&type=ws&path=%2Fpath&host=tr.example.com&allowInsecure=1#US-Trojan',
  ss_sip002: 'ss://' + b64('aes-256-gcm:pass123') + '@5.6.7.8:8388#SS-SIP002',
  ss_legacy: 'ss://' + b64('chacha20-ietf-poly1305:pwd@9.9.9.9:8443') + '#SS-Legacy',
  ss_plugin: 'ss://' + b64('aes-128-gcm:pw') + '@1.1.1.1:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dbing.com#SS-Obfs',
  ssr: 'ssr://' + b64u('8.8.4.4:8989:auth_aes128_md5:aes-256-cfb:tls1.2_ticket_auth:' + b64u('ssrpass') + '/?remarks=' + b64u('SSR-Node') + '&obfsparam=' + b64u('a.com') + '&protoparam=' + b64u('123456')),
  hysteria2: 'hysteria2://authpass@hy.example.com:443?sni=hy.example.com&insecure=1&obfs=salamander&obfs-password=ob#HY2-Node',
  tuic: 'tuic://uuid-1111-2222:pass@tuic.example.com:443?congestion_control=bbr&alpn=h3&sni=tuic.example.com&allow_insecure=1#TUIC-Node',
  anytls: 'anytls://anypass@at.example.com:8443?sni=at.example.com&insecure=1#AnyTLS-Node',
  socks5: 'socks5://user1:pwd1@10.0.0.1:1080#SOCKS-Node',
  http: 'http://u:p@10.0.0.2:8080#HTTP-Node',
  plain: '10.0.0.3:3128:admin:secret',
  plain2: '10.0.0.4:1080',
};

const clashYaml = `
mixed-port: 7890
allow-lan: false
mode: rule
proxies:
  - name: "Clash-SS"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: "pw"
    udp: true
  - name: "Clash-VMess"
    type: vmess
    server: vm.example.com
    port: 443
    uuid: b831381d-6324-4d53-ad4f-8cda48b30811
    alterId: 0
    cipher: auto
    tls: true
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: vm.example.com
  - name: "Clash-Trojan"
    type: trojan
    server: tr.example.com
    port: 443
    password: pw
    sni: tr.example.com
    skip-cert-verify: true
  - name: "Clash-Hy2"
    type: hysteria2
    server: hy.example.com
    port: 443
    password: pw
    sni: hy.example.com
proxy-groups:
  - name: PROXY
    type: select
    proxies: ["Clash-SS"]
rules:
  - MATCH,PROXY
`;

const surge = `[Proxy]
DIRECT = direct
HK-SS = ss, 1.2.3.4, 8388, encrypt-method=aes-128-gcm, password=pw, obfs=http, obfs-host=bing.com
JP-VMess = vmess, vm.example.com, 443, username=b831381d-6324-4d53-ad4f-8cda48b30811, tls=true, ws=true, ws-path=/ws, ws-headers=Host:vm.example.com, sni=vm.example.com
US-Trojan = trojan, tr.example.com, 443, password=pw, sni=tr.example.com, skip-cert-verify=true
SG-SOCKS = socks5, 10.0.0.5, 1080, user1, pwd1
`;

const qx = `shadowsocks=1.2.3.4:8388, method=aes-256-gcm, password=pw, tag=QX-SS
vmess=vm.example.com:443, method=chacha20-poly1305, password=b831381d-6324-4d53-ad4f-8cda48b30811, obfs=wss, obfs-uri=/ws, obfs-host=vm.example.com, tag=QX-VMess
trojan=tr.example.com:443, password=pw, over-tls=true, tls-host=tr.example.com, tls-verification=false, tag=QX-Trojan
`;

const singbox = JSON.stringify({
  outbounds: [
    { type: 'shadowsocks', tag: 'sb-ss', server: '1.2.3.4', server_port: 8388, method: 'aes-256-gcm', password: 'pw' },
    {
      type: 'vless', tag: 'sb-vless', server: 'v.example.com', server_port: 443, uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      tls: { enabled: true, server_name: 'v.example.com', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0', short_id: 'ab12' } },
      transport: { type: 'ws', path: '/ws', headers: { Host: 'v.example.com' } },
    },
    { type: 'hysteria2', tag: 'sb-hy2', server: 'hy.example.com', server_port: 443, password: 'pw', tls: { enabled: true, server_name: 'hy.example.com' } },
    { type: 'direct', tag: 'direct' },
  ],
});

const sip008 = JSON.stringify({
  version: 1,
  servers: [{ id: 'x', remarks: 'SIP-Node', server: '1.2.3.4', server_port: 8388, method: 'aes-256-gcm', password: 'pw' }],
});

const base64sub = b64([samples.vmess, samples.ss_sip002, samples.trojan_ws].join('\n'));

const cases = [
  ['单条 vmess', samples.vmess],
  ['vless + reality + grpc', samples.vless_reality],
  ['trojan + ws', samples.trojan_ws],
  ['ss SIP002', samples.ss_sip002],
  ['ss 旧版整体 base64', samples.ss_legacy],
  ['ss + obfs 插件', samples.ss_plugin],
  ['ssr', samples.ssr],
  ['hysteria2', samples.hysteria2],
  ['tuic', samples.tuic],
  ['anytls', samples.anytls],
  ['socks5', samples.socks5],
  ['http 代理', samples.http],
  ['纯文本 host:port:user:pass', samples.plain],
  ['纯文本 host:port', samples.plain2],
  ['Clash YAML', clashYaml],
  ['Surge 配置', surge],
  ['Quantumult X', qx],
  ['sing-box JSON', singbox],
  ['SIP008 JSON', sip008],
  ['Base64 订阅', base64sub],
  ['混合多行', [samples.vmess, samples.socks5, samples.plain2].join('\n')],
];

if (require.main === module) {
let pass = 0;
let fail = 0;
for (const [label, text] of cases) {
  const r = parser.parseText(text, { plainType: 'socks5', allowHttpProxy: true });
  const ok = r.nodes.length > 0;
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✔' : '✘'} ${label.padEnd(24)} format=${String(r.format).padEnd(20)} nodes=${r.nodes.length}`);
  for (const n of r.nodes.slice(0, 4)) {
    console.log(`    - [${n.type}] ${n.name || '(无名)'} ${n.server}:${n.port}  ${JSON.stringify(n.conf).slice(0, 150)}`);
  }
  if (!ok && r.errors.length) console.log('    ! ' + JSON.stringify(r.errors.slice(0, 2)));
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
}

module.exports = { cases };
