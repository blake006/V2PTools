/* 节点分享链接生成
 *
 * 优先返回导入时保留的原始链接（参数最全，reality/ws/grpc 细节不会丢）；
 * 从 Clash YAML 等来源导入、没有 raw 时，按协议拼标准 URI。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IPHShare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var enc = encodeURIComponent;

  function b64(s) {
    try {
      return Buffer.from(String(s), 'utf8').toString('base64');
    } catch (e) {
      return btoa(unescape(encodeURIComponent(String(s))));
    }
  }

  /** 拼查询串：跳过空值，布尔转 1/0 */
  function qs(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(k + '=' + (typeof v === 'boolean' ? (v ? 1 : 0) : enc(String(v))));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function toShareLink(n) {
    if (!n) return '';
    if (n.raw && /^[a-z0-9+.-]+:\/\//i.test(String(n.raw))) return String(n.raw);

    var c = n.conf || {};
    var host = n.server;
    var port = n.port;
    var tag = '#' + enc(n.name || host + ':' + port);
    var insecure = c['skip-cert-verify'] ? 1 : undefined;
    var sni = c.servername || c.sni;

    switch (n.type) {
      case 'anytls':
        return 'anytls://' + enc(c.password || '') + '@' + host + ':' + port +
          qs({ insecure: insecure, security: 'tls', sni: sni, type: 'tcp', headerType: 'none', fp: c['client-fingerprint'] }) + tag;

      case 'vless': {
        var ws = c['ws-opts'] || {};
        var grpc = c['grpc-opts'] || {};
        var reality = c['reality-opts'] || {};
        return 'vless://' + (c.uuid || '') + '@' + host + ':' + port + qs({
          encryption: 'none',
          security: c.tls ? (reality['public-key'] ? 'reality' : 'tls') : 'none',
          sni: sni,
          fp: c['client-fingerprint'],
          pbk: reality['public-key'],
          sid: reality['short-id'],
          flow: c.flow,
          type: c.network || 'tcp',
          host: ws.headers && ws.headers.Host,
          path: ws.path,
          serviceName: grpc['grpc-service-name'],
          insecure: insecure,
        }) + tag;
      }

      case 'vmess': {
        var vws = c['ws-opts'] || {};
        var obj = {
          v: '2',
          ps: n.name || host + ':' + port,
          add: host,
          port: String(port),
          id: c.uuid || '',
          aid: String(c.alterId || 0),
          scy: c.cipher || 'auto',
          net: c.network || 'tcp',
          type: 'none',
          host: vws.headers ? vws.headers.Host : '',
          path: vws.path || '',
          tls: c.tls ? 'tls' : '',
          sni: sni || '',
        };
        return 'vmess://' + b64(JSON.stringify(obj));
      }

      case 'trojan':
        return 'trojan://' + enc(c.password || '') + '@' + host + ':' + port + qs({
          security: 'tls',
          sni: sni,
          type: c.network || 'tcp',
          insecure: insecure,
        }) + tag;

      case 'ss': {
        var userinfo = b64((c.cipher || 'aes-128-gcm') + ':' + (c.password || ''));
        return 'ss://' + userinfo + '@' + host + ':' + port + tag;
      }

      case 'ssr':
        // SSR 格式复杂且各客户端不一致，没有原始链接时不硬造
        return '';

      case 'hysteria2':
        return 'hysteria2://' + enc(c.password || c.auth || '') + '@' + host + ':' + port + qs({
          sni: sni,
          insecure: insecure,
          obfs: c.obfs,
          'obfs-password': c['obfs-password'],
        }) + tag;

      case 'hysteria':
        return 'hysteria://' + host + ':' + port + qs({
          protocol: 'udp',
          auth: c.auth || c.password,
          peer: sni,
          insecure: insecure,
          upmbps: c.up,
          downmbps: c.down,
          alpn: c.alpn && c.alpn.join(','),
        }) + tag;

      case 'tuic': {
        var auth = (c.uuid || '') + (c.password ? ':' + c.password : '');
        return 'tuic://' + auth + '@' + host + ':' + port + qs({
          sni: sni,
          alpn: c.alpn && c.alpn.join(','),
          congestion_control: c['congestion-controller'],
          udp_relay_mode: c['udp-relay-mode'],
          allow_insecure: insecure,
        }) + tag;
      }

      case 'socks5':
        return 'socks5://' + (c.username ? enc(c.username) + (c.password ? ':' + enc(c.password) : '') + '@' : '') +
          host + ':' + port + tag;

      case 'http':
        return 'http://' + (c.username ? enc(c.username) + (c.password ? ':' + enc(c.password) : '') + '@' : '') +
          host + ':' + port + tag;

      default:
        return '';
    }
  }

  /** 给用户看的可读形式（太长时截断） */
  function preview(link, max) {
    var s = String(link || '');
    var n = max || 120;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  return { toShareLink: toShareLink, preview: preview };
});
