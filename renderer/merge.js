/**
 * 订阅同步的节点合并逻辑（纯函数，便于单测）
 * - 已存在（协议 + 服务器 + 端口一致）：更新配置，保留检测结果
 * - 新增：追加
 * - 订阅中消失：按 removeGone 决定是否移除
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IPHMerge = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function keyOf(n) {
    return `${n.type}|${String(n.server).toLowerCase()}|${n.port}`;
  }

  /**
   * 该订阅里用户手动改过的分组名。
   * 「重命名分组 / 移动节点到分组」只改 node.group，没有单独的别名表，
   * 所以同步时只能从现有节点反推：
   *   - 优先用订阅对象上记下的 src.groupName（节点全被换掉时也还在）
   *   - 退化为看现有节点：只认非默认名（默认名就是订阅源 hostname / 文件名），
   *     且必须唯一，出现多个自定义分组说明用户是按其它维度分的（如按国家），此时不猜
   */
  function inheritedGroupOf(state, src) {
    if (src.groupName) return src.groupName;
    const def = src.group || '';
    const seen = new Set();
    for (const n of state.nodes) {
      if (n.source !== src.url) continue;
      const g = n.group || '';
      if (!g || g === def) continue;
      seen.add(g);
    }
    return seen.size === 1 ? Array.from(seen)[0] : '';
  }

  /**
   * @param {{nodes: Array, selected: Set}} state 会被就地修改
   * @param {{url: string, group?: string}} src 订阅源
   * @param {Array} incoming 最新拉取到的节点
   * @param {boolean} removeGone 是否移除订阅中已消失的节点
   * @returns {{added: number, updated: number, removed: number}}
   */
  function mergeFromSource(state, src, incoming, removeGone) {
    const owned = state.nodes.filter((n) => n.source === src.url);
    const ownedMap = new Map();
    for (const n of owned) ownedMap.set(keyOf(n), n);
    // 每轮只算一次：节点上千条时，放在循环里就是 O(n²)
    const inheritedGroup = inheritedGroupOf(state, src);

    const incomingKeys = new Set();
    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const n of incoming) {
      const k = keyOf(n);
      incomingKeys.add(k);
      const old = ownedMap.get(k);
      if (old) {
        old.name = n.name || old.name;
        old.conf = n.conf;
        old.raw = n.raw;
        // 分组名是用户可编辑的元数据，订阅里的默认名不能覆盖它，
        // 否则每次「更新代理」都会把重命名打回 hostname（用户报的 bug）。
        if (!old.group) old.group = n.group || src.group || '';
        updated += 1;
        continue;
      }
      // 其它来源已有同节点则跳过，避免重复
      if (state.nodes.some((x) => keyOf(x) === k)) continue;
      if (!n.name) n.name = `${n.server}:${n.port}`;
      n.source = src.url;
      // 用户改过名时新节点跟着进同一个分组，否则同源会裂出「自定义名 + 默认名」两组
      n.group = inheritedGroup || n.group || src.group || '';
      state.nodes.push(n);
      added += 1;
    }

    if (removeGone) {
      const goneIds = new Set();
      for (const n of owned) {
        if (!incomingKeys.has(keyOf(n))) {
          goneIds.add(n.id);
          if (state.selected && state.selected.delete) state.selected.delete(n.id);
          removed += 1;
        }
      }
      if (goneIds.size) state.nodes = state.nodes.filter((n) => !goneIds.has(n.id));
    }

    return { added, updated, removed };
  }

  return { keyOf, mergeFromSource, inheritedGroupOf };
});
