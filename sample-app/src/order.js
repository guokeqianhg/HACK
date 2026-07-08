// 下单编排：校验库存 → 计算优惠 → 生成订单
import { calcSubtotal, applyCouponStack } from './coupon.js';
import { reserve, release } from './inventory.js';

let seq = 0;

export function createOrder({ items = [], coupons = [] } = {}) {
  const subtotalCents = calcSubtotal(items);
  const { finalCents, applied, rejected } = applyCouponStack(subtotalCents, coupons);

  // 扣减库存（任一项不足则整体回滚）
  const reserved = [];
  for (const it of items) {
    const r = reserve(it.sku, it.qty);
    if (!r.ok) {
      for (const x of reserved) release(x.sku, x.qty);
      return { ok: false, code: 'INVENTORY', message: r.reason };
    }
    reserved.push(it);
  }

  seq += 1;
  return {
    ok: true,
    orderId: `ORD${String(seq).padStart(6, '0')}`,
    subtotalCents,
    finalCents,
    applied,
    rejected,
    items,
  };
}
