// 前端结账客户端逻辑（纯函数，既被浏览器 app.js 使用，也被 node:test 直接测试）
// 这样「前端体验」的核心计算逻辑可被离线单测覆盖，而非只能靠浏览器。

export function formatMoney(cents) {
  return '¥' + (cents / 100).toFixed(2);
}

export function buildLineTotal(priceCents, qty) {
  return priceCents * qty;
}

// 根据购物车明细 + 优惠，给出页面要展示的汇总（与后端保持同一套金额口径）
export function summarizeCart(items, coupons = []) {
  const subtotal = items.reduce((s, it) => s + buildLineTotal(it.priceCents, it.qty), 0);
  // 简化：前端先用后端同款规则估算展示；真实下单以 POST /api/checkout 为准
  return { subtotalCents: subtotal };
}
