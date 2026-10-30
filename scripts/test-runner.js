'use strict';

const path = require('path');
const parser = require('../electron/lib/parser');
const { CoreManager } = require('../electron/lib/core');
const { Runner } = require('../electron/lib/runner');

async function main() {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const text = [
    `ss://${b64('aes-128-gcm:test123')}@127.0.0.1:18388#本地SS-可用`,
    `ss://${b64('aes-128-gcm:test123')}@127.0.0.1:18389#本地SS-端口错误`,
    'socks5://127.0.0.1:1#不可用节点',
    `ss://${b64('bad-cipher-xyz:pw')}@127.0.0.1:18388#配置非法节点`,
  ].join('\n');

  const parsed = parser.parseText(text, { plainType: 'socks5' });
  console.log('解析:', parsed.nodes.map((n) => n.name).join(', '));

  const core = new CoreManager({
    corePath: path.join(__dirname, '..', 'vendor', 'mihomo.exe'),
    dataDir: path.join(__dirname, '..', '.selftest'),
  });

  const patches = new Map();
  const runner = new Runner({
    core,
    settings: { concurrency: 3, latencyTimeout: 6000, speedTimeout: 15000, speedBytes: 3, deepHealth: true },
    emit: (ev) => {
      if (ev.type === 'node') {
        const cur = patches.get(ev.id) || {};
        patches.set(ev.id, { ...cur, ...ev.patch });
      } else if (ev.type !== 'phase') {
        console.log('[event]', ev.type, JSON.stringify(ev).slice(0, 160));
      }
    },
  });

  const t0 = Date.now();
  await runner.run(parsed.nodes, 'full');
  console.log('耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's');

  for (const n of parsed.nodes) {
    const p = patches.get(n.id) || {};
    console.log(`- ${n.name}: status=${p.status} lat=${p.latency} speed=${p.speed} ip=${p.ip} ${p.country || ''}${p.city || ''} health=${p.health} err=${p.error || ''}`);
  }
  await core.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
