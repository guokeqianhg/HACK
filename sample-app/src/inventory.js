// 内存库存（纯逻辑，可被 node:test 直接测试）
// 注意：本示例未处理并发扣减，属于真实后端常见隐患点（演示用）。

const stock = new Map(); // sku -> 可用数量

export function setStock(sku, qty) {
  stock.set(sku, qty);
}

export function getStock(sku) {
  return stock.get(sku) ?? 0;
}

export function reserve(sku, qty) {
  const cur = getStock(sku);
  if (cur < qty) {
    return { ok: false, reason: `库存不足 sku=${sku} 可用${cur} 需${qty}` };
  }
  stock.set(sku, cur - qty);
  return { ok: true, left: cur - qty };
}

export function release(sku, qty) {
  stock.set(sku, getStock(sku) + qty);
}

export function resetInventory() {
  stock.clear();
}
