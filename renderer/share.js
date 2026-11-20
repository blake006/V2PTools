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

  function firstVal(v) {
    return Array.isArray(v) ? v[0] : v;
  }

  function hostOf(headers) {
    if (!headers) return undefined;
    return firstVal(headers.Host || headers.host);
  }

  function alpnOf(c) {
    if (!c.alpn) return undefined;
    return Array.isArray(c.alpn) ? c.alpn.join(',') : c.alpn;
  }

  /**
   * 把 Clash 的传输层配置翻成分享链接参数。
   *
   * 这里是「复制出去在别的客户端导入不了」的多发区：只写 type=xxx、把 path / host /
   * serviceName / mode 丢掉，链接看着完整，其实缺了定位传输端点的关键参数。
   * 所以每种传输都必须把对应的 opts 一起带出去。
   */
  function transportParams(c) {
    var net = String(c.network || 'tcp').toLowerCase();
    var ws = c['ws-opts'] || {};
    var grpc = c['grpc-opts'] || {};
    var httpOpts = c['http-opts'] || {};
    var xhttp = c['xhttp-opts'] || {};
    var kcp = c['kcp-opts'] || {};
    var quic = c['quic-opts'] || {};
    var out = {};

    if (net === 'ws') {
      out.type = 'ws';
      out.path = ws.path;
      out.host = hostOf(ws.headers);
      if (ws['max-early-data']) out.ed = ws['max-early-data'];
      if (ws['early-data-header-name']) out.eh = ws['early-data-header-name'];
    } else if (net === 'grpc') {
      out.type = 'grpc';
      out.serviceName = grpc['grpc-service-name'];
      out.mode = grpc.mode;
    } else if (net === 'http' || net === 'h2') {
      // Clash 的 http / h2 对应 Xray 的 HTTP/2 传输，分享链接里统一写 type=http。
      // 注意两套字段：URI 导入的节点存 h2-opts，Clash YAML 导入的存 http-opts，两边都要认。
      var h2 = c['h2-opts'] || {};
      out.type = 'http';
      out.path = firstVal(h2.path) || firstVal(httpOpts.path);
      out.host = firstVal(h2.host) || firstVal(httpOpts.host) || hostOf(httpOpts.headers);
    } else if (net === 'xhttp' || net === 'splithttp') {
      out.type = 'xhttp';
      out.path = xhttp.path;
      out.host = firstVal(xhttp.host) || hostOf(xhttp.headers);
      out.mode = xhttp.mode;
      // extra 是 XHTTP 的调优参数（xPaddingBytes / xmux 等），有就必须带出去
      if (xhttp.extra) out.extra = typeof xhttp.extra === 'string' ? xhttp.extra : JSON.stringify(xhttp.extra);
    } else if (net === 'kcp') {
      out.type = 'kcp';
      out.headerType = kcp.header && kcp.header.type;
      out.seed = kcp.seed;
    } else if (net === 'quic') {
      out.type = 'quic';
      out.quicSecurity = quic.security;
      out.key = quic.key;
      out.headerType = quic.header && quic.header.type;
    } else {
      out.type = 'tcp';
      // TCP + HTTP 伪装：Clash 用 http-opts 描述，分享链接写 headerType=http
      if (httpOpts.path || httpOpts.method || httpOpts.host) {
        out.headerType = 'http';
        out.path = firstVal(httpOpts.path) || '/';
        out.host = firstVal(httpOpts.host) || hostOf(httpOpts.headers);
      }
    }
    return out;
  }

  function withTransport(c, extra) {
    var tp = transportParams(c);
    var keys = Object.keys(tp);
    keys.forEach(function (k) {
      if (tp[k] !== undefined && tp[k] !== null && tp[k] !== '') extra[k] = tp[k];
    });
    return extra;
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
        var reality = c['reality-opts'] || {};
        return 'vless://' + (c.uuid || '') + '@' + host + ':' + port + qs(withTransport(c, {
          encryption: 'none',
          security: c.tls ? (reality['public-key'] ? 'reality' : 'tls') : 'none',
          sni: sni,
          fp: c['client-fingerprint'],
          pbk: reality['public-key'],
          sid: reality['short-id'],
          flow: c.flow,
          alpn: alpnOf(c),
          insecure: insecure,
        })) + tag;
      }

      case 'vmess': {
        var vtp = transportParams(c);
        var obj = {
          v: '2',
          ps: n.name || host + ':' + port,
          add: host,
          port: String(port),
          id: c.uuid || '',
          aid: String(c.alterId || 0),
          scy: c.cipher || 'auto',
          net: vtp.type === 'http' ? 'h2' : vtp.type,
          type: vtp.headerType || 'none',
          host: vtp.host || '',
          path: vtp.path || '',
          tls: c.tls ? 'tls' : '',
          sni: sni || '',
        };
        if (vtp.serviceName) obj.path = vtp.serviceName;
        return 'vmess://' + b64(JSON.stringify(obj));
      }

      case 'trojan':
        return 'trojan://' + enc(c.password || '') + '@' + host + ':' + port + qs(withTransport(c, {
          security: 'tls',
          sni: sni,
          alpn: alpnOf(c),
          insecure: insecure,
        })) + tag;

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

  return { toShareLink: toShareLink, preview: preview, transportParams: transportParams };
});
