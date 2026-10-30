'use strict';

/**
 * 端到端自检：解析 → 生成配置 → 启动内核 → 延迟/测速/取 IP
 * 用法: node scripts/selftest.js
 */

const path = require('path');
const parser = require('../electron/lib/parser');
const { CoreManager } = require('../electron/lib/core');
const { testLatency, testSpeed, fetchExitIP, testTcp } = require('../electron/lib/tester');
const geo = require('../electron/lib/geo');

async function main() {
  const raw = process.env.TEST_LINK || 'ss://YWVzLTEyOC1nY206dGVzdDEyMw==@127.0.0.1:18388#local-ss';
  const res = parser.parseText(raw, { plainType: 'socks5' });
  console.log('解析节点数:', res.nodes.length, res.errors);
  if (!res.nodes.length) process.exit(1);
  const node = res.nodes[0];
  console.log('节点:', node.type, node.server + ':' + node.port, JSON.stringify(node.conf));

  const core = new CoreManager({
    corePath: path.join(__dirname, '..', 'vendor', 'mihomo.exe'),
    dataDir: path.join(__dirname, '..', '.selftest'),
    onLog: (m) => console.log('[core]', m),
  });

  const t0 = Date.now();
  await core.start([node]);
  console.log('内核启动耗时:', Date.now() - t0, 'ms, 端口:', core.portOf(node.id));

  const port = core.portOf(node.id);
  console.log('TCP:', await testTcp(node.server, node.port, 3000));
  console.log('延迟:', await testLatency(port, { timeout: 8000, rounds: 3 }));
  console.log('速度:', await testSpeed(port, { bytes: 5 * 1024 * 1024, timeout: 20000 }));
  const ipr = await fetchExitIP(port, { timeout: 8000 });
  console.log('出口 IP:', ipr);

  if (ipr.ok) {
    const map = await geo.lookupBatch([ipr.ip]);
    const g = map.get(ipr.ip);
    console.log('归属地:', g);
    console.log('DNSBL:', await geo.checkDnsbl(ipr.ip));
    console.log('健康度:', geo.scoreHealth({ geo: g, dnsbl: { listed: [] }, latency: 200, speed: 10 }));
  }

  await core.stop();
  console.log('完成');
  process.exit(0);
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
