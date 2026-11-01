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
        old.group = n.group || old.group;
        updated += 1;
        continue;
      }
      // 其它来源已有同节点则跳过，避免重复
      if (state.nodes.some((x) => keyOf(x) === k)) continue;
      if (!n.name) n.name = `${n.server}:${n.port}`;
      n.source = src.url;
      n.group = n.group || src.group || '';
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

  return { keyOf, mergeFromSource };
});
