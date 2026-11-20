/**
 * 分享链接完整性测试。
 *
 * 背景：之前只按 `c.network` 写一个 `type=xxx`，把 path / host / mode / serviceName
 * 全丢了。xhttp 节点复制出来的链接形如 `type=xhttp#name`，贴到任何客户端都连不通。
 *
 *   node scripts/test-share-link.js
 */
global.self = global;
const assert = require('assert');
const Share = require('../renderer/share.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + ' → ' + e.message);
  }
}

function node(type, server, port, conf, name) {
  return { type, server, port, conf, name: name || `节点-${type}` };
}

function parse(link) {
  const u = new URL(link);
  return { u, q: u.searchParams };
}

(function main() {
  console.log('— vless / xhttp');
  const xhttp = node('vless', 'fontaine.ajeyam.org', 8101, {
    uuid: '3853bc38-447e-43e5-995c-1531604a2c5a',
    tls: true,
    servername: 'dalasi.sheinway.uk',
    network: 'xhttp',
    'client-fingerprint': 'chrome',
    'xhttp-opts': { path: '/assets/update', mode: 'stream-one' },
  }, '美国｜达拉斯-CN2晚高峰19～01点');

  const lx = Share.toShareLink(xhttp);
  check('生成 vless 链接', () => assert.ok(lx.startsWith('vless://')));
  check('type=xhttp', () => assert.strictEqual(parse(lx).q.get('type'), 'xhttp'));
  check('带 path', () => assert.strictEqual(parse(lx).q.get('path'), '/assets/update'));
  check('带 mode', () => assert.strictEqual(parse(lx).q.get('mode'), 'stream-one'));
  check('保留 sni / fp', () => {
    assert.strictEqual(parse(lx).q.get('sni'), 'dalasi.sheinway.uk');
    assert.strictEqual(parse(lx).q.get('fp'), 'chrome');
  });
  check('不含空白/换行', () => assert.ok(!/[\s]/.test(lx)));
  check('节点名完整进 fragment', () => assert.strictEqual(decodeURIComponent(parse(lx).u.hash.slice(1)), xhttp.name));

  console.log('— vless / ws');
  const ws = node('vless', 'a.example.com', 443, {
    uuid: '11111111-2222-3333-4444-555555555555',
    tls: true,
    servername: 'cdn.example.com',
    network: 'ws',
    'ws-opts': { path: '/ws?ed=2048', headers: { Host: 'cdn.example.com' } },
  });
  const lw = Share.toShareLink(ws);
  check('type=ws', () => assert.strictEqual(parse(lw).q.get('type'), 'ws'));
  check('ws path/host 都在', () => {
    assert.strictEqual(parse(lw).q.get('path'), '/ws?ed=2048');
    assert.strictEqual(parse(lw).q.get('host'), 'cdn.example.com');
  });

  console.log('— vless / http(h2)');
  const h2 = node('vless', 'b.example.com', 443, {
    uuid: '11111111-2222-3333-4444-555555555555',
    tls: true,
    network: 'http',
    'http-opts': { path: ['/h2'], host: ['h2.example.com'] },
  });
  const lh = Share.toShareLink(h2);
  check('http 归一为 type=http', () => assert.strictEqual(parse(lh).q.get('type'), 'http'));
  check('h2 path/host 都在', () => {
    assert.strictEqual(parse(lh).q.get('path'), '/h2');
    assert.strictEqual(parse(lh).q.get('host'), 'h2.example.com');
  });

  console.log('— vless / grpc');
  const g = node('vless', 'c.example.com', 443, {
    uuid: '11111111-2222-3333-4444-555555555555',
    tls: true,
    network: 'grpc',
    'grpc-opts': { 'grpc-service-name': 'svc' },
  });
  const lg = Share.toShareLink(g);
  check('type=grpc 且带 serviceName', () => {
    assert.strictEqual(parse(lg).q.get('type'), 'grpc');
    assert.strictEqual(parse(lg).q.get('serviceName'), 'svc');
  });

  console.log('— vmess / ws');
  const vm = node('vmess', 'd.example.com', 443, {
    uuid: '11111111-2222-3333-4444-555555555555',
    alterId: 0,
    cipher: 'auto',
    tls: true,
    network: 'ws',
    'ws-opts': { path: '/vm', headers: { Host: 'vm.example.com' } },
  });
  const lv = Share.toShareLink(vm);
  const obj = JSON.parse(Buffer.from(lv.slice('vmess://'.length), 'base64').toString('utf8'));
  check('vmess net=ws', () => assert.strictEqual(obj.net, 'ws'));
  check('vmess host/path 都在', () => {
    assert.strictEqual(obj.host, 'vm.example.com');
    assert.strictEqual(obj.path, '/vm');
  });

  console.log('— vmess / http(h2)');
  const vm2 = node('vmess', 'e.example.com', 443, {
    uuid: '11111111-2222-3333-4444-555555555555',
    tls: true,
    network: 'h2',
    'http-opts': { path: ['/h2vm'], host: ['vmh2.example.com'] },
  });
  const lv2 = Share.toShareLink(vm2);
  const obj2 = JSON.parse(Buffer.from(lv2.slice('vmess://'.length), 'base64').toString('utf8'));
  check('h2 映射成 net=h2', () => assert.strictEqual(obj2.net, 'h2'));
  check('h2 vmess host/path 都在', () => {
    assert.strictEqual(obj2.host, 'vmh2.example.com');
    assert.strictEqual(obj2.path, '/h2vm');
  });

  console.log('— trojan / ws');
  const tj = node('trojan', 'f.example.com', 443, {
    password: 'p@ss word',
    tls: true,
    network: 'ws',
    'ws-opts': { path: '/tj', headers: { Host: 'tj.example.com' } },
  });
  const lt = Share.toShareLink(tj);
  check('trojan 带 ws 参数', () => {
    assert.strictEqual(parse(lt).q.get('type'), 'ws');
    assert.strictEqual(parse(lt).q.get('path'), '/tj');
    assert.strictEqual(parse(lt).q.get('host'), 'tj.example.com');
  });
  check('trojan 密码被编码', () => assert.ok(lt.includes('p%40ss%20word@')));

  console.log('— 原始链接优先');
  const raw = node('vless', 'g.example.com', 443, { uuid: 'x' });
  raw.raw = 'vless://uuid@g.example.com:443?type=xhttp&path=%2Fx&mode=auto#name';
  check('有 raw 时原样返回', () => assert.strictEqual(Share.toShareLink(raw), raw.raw));

  console.log('— 导入 → 再导出（round trip）');
  const Parser = require('../electron/lib/parser.js');
  const uri =
    'vless://3853bc38-447e-43e5-995c-1531604a2c5a@fontaine.ajeyam.org:8101' +
    '?encryption=none&security=tls&sni=dalasi.sheinway.uk&fp=chrome' +
    '&type=xhttp&path=%2Fassets%2Fupdate&mode=stream-one&extra=%7B%22xPaddingBytes%22%3A100%7D#rt';
  const imported = Parser.parseLine(uri, {});
  check('导入后保留 xhttp 传输', () => assert.strictEqual(imported.conf.network, 'xhttp'));
  check('导入后保留 path/mode/extra', () => {
    assert.strictEqual(imported.conf['xhttp-opts'].path, '/assets/update');
    assert.strictEqual(imported.conf['xhttp-opts'].mode, 'stream-one');
    assert.strictEqual(imported.conf['xhttp-opts'].extra.xPaddingBytes, 100);
  });
  const back = Share.toShareLink(imported);
  check('再导出仍是完整 xhttp 链接', () => {
    const q = parse(back).q;
    assert.strictEqual(q.get('type'), 'xhttp');
    assert.strictEqual(q.get('path'), '/assets/update');
    assert.strictEqual(q.get('mode'), 'stream-one');
    assert.ok(q.get('extra').includes('xPaddingBytes'));
  });

  console.log('— 不支持的协议');
  check('ssr 返回空串（不硬造）', () =>
    assert.strictEqual(Share.toShareLink(node('ssr', 'h.example.com', 443, {})), ''));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;
})();
