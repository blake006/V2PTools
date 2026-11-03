'use strict';

/**
 * 导出为 sing-box 配置
 *
 * 只做常见协议（vmess / vless / trojan / ss / hysteria2 / tuic / socks / http），
 * 其它类型跳过并在结果里说明 —— 宁可少导一个，也不要生成跑不起来的配置。
 */

function tlsBlock(conf, opts = {}) {
  const c = conf || {};
  const sni = c.servername || c.sni || '';
  const reality = c['reality-opts'] || null;
  const tls = {
    enabled: true,
    server_name: sni || undefined,
    insecure: !!c['skip-cert-verify'],
  };
  if (c.alpn && c.alpn.length) tls.alpn = c.alpn;
  if (c['client-fingerprint']) {
    tls.utls = { enabled: true, fingerprint: c['client-fingerprint'] };
  }
  if (reality && reality['public-key']) {
    tls.reality = {
      enabled: true,
      public_key: reality['public-key'],
      short_id: reality['short-id'] || '',
    };
  }
  if (opts.forceOff) return { enabled: false };
  return tls;
}

function transportBlock(conf) {
  const c = conf || {};
  const net = c.network || 'tcp';
  if (net === 'ws') {
    const ws = c['ws-opts'] || {};
    return {
      type: 'ws',
      path: ws.path || '/',
      headers: ws.headers && ws.headers.Host ? { Host: ws.headers.Host } : undefined,
    };
  }
  if (net === 'grpc') {
    const g = c['grpc-opts'] || {};
    return { type: 'grpc', service_name: g['grpc-service-name'] || '' };
  }
  if (net === 'http') {
    const h = c['http-opts'] || {};
    return { type: 'http', path: h.path && h.path[0] ? h.path[0] : '/' };
  }
  return null;
}

function toOutbound(n) {
  const c = n.conf || {};
  const base = { tag: n.name || `${n.server}:${n.port}`, server: n.server, server_port: Number(n.port) };

  switch (n.type) {
    case 'vmess': {
      const o = {
        type: 'vmess',
        ...base,
        uuid: c.uuid,
        security: c.cipher || 'auto',
        alter_id: Number(c.alterId || 0),
      };
      if (c.tls) o.tls = tlsBlock(c);
      const t = transportBlock(c);
      if (t) o.transport = t;
      return o;
    }
    case 'vless': {
      const o = { type: 'vless', ...base, uuid: c.uuid };
      if (c.flow) o.flow = c.flow;
      if (c.tls) o.tls = tlsBlock(c);
      const t = transportBlock(c);
      if (t) o.transport = t;
      return o;
    }
    case 'trojan': {
      const o = { type: 'trojan', ...base, password: c.password, tls: tlsBlock(c) };
      const t = transportBlock(c);
      if (t) o.transport = t;
      return o;
    }
    case 'ss':
      return {
        type: 'shadowsocks',
        ...base,
        method: c.cipher,
        password: c.password,
      };
    case 'hysteria2': {
      const o = {
        type: 'hysteria2',
        ...base,
        password: c.password || c.auth || '',
        tls: tlsBlock(c),
      };
      if (c.obfs) o.obfs = { type: c.obfs, password: c['obfs-password'] || '' };
      return o;
    }
    case 'tuic':
      return {
        type: 'tuic',
        ...base,
        uuid: c.uuid,
        password: c.password,
        tls: tlsBlock(c),
      };
    case 'socks5':
      return {
        type: 'socks',
        ...base,
        version: '5',
        username: c.username || undefined,
        password: c.password || undefined,
      };
    case 'http':
      return {
        type: 'http',
        ...base,
        username: c.username || undefined,
        password: c.password || undefined,
      };
    default:
      return null;
  }
}

/**
 * @param {Array} nodes
 * @returns {{ config: object, count: number, skipped: string[] }}
 */
function buildSingBox(nodes) {
  const outbounds = [];
  const skipped = [];

  for (const n of nodes || []) {
    const o = toOutbound(n);
    if (!o) {
      skipped.push(n.type || 'unknown');
      continue;
    }
    // 同名 tag 会导致 sing-box 启动报错
    let tag = o.tag;
    let i = 2;
    while (outbounds.some((x) => x.tag === tag)) {
      tag = `${o.tag} (${i})`;
      i += 1;
    }
    o.tag = tag;
    outbounds.push(o);
  }

  const tags = outbounds.map((o) => o.tag);
  const config = {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 7890,
      },
    ],
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: tags.length ? tags : ['direct'], default: tags[0] || 'direct' },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
    ],
    route: { rules: [], final: 'proxy' },
  };

  return { config, count: outbounds.length, skipped: [...new Set(skipped)] };
}

module.exports = { buildSingBox, toOutbound };
