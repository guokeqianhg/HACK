// 优惠券与金额计算（纯逻辑，可被 node:test 与浏览器共享测试）
//
// 优惠券模型：
//  - threshold 满减券：{ type:'threshold', thresholdCents, minusCents }
//  - nofloor   无门槛立减券：{ type:'nofloor', minusCents }
//  - percent   折扣券：{ type:'percent', percentOff }  percentOff=10 表示「减 10%」即 9 折
//
// 叠加规则：
//  - 每类最多 1 张
//  - 计算顺序：先满减 → 再无门槛 → 最后折扣（折扣作用在前面减完后的金额上）
//  - 最终价不为负

export function calcSubtotal(items) {
  return items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
}

export function applyCouponStack(subtotalCents, coupons = []) {
  let price = subtotalCents;
  const applied = [];
  const rejected = [];

  for (const c of coupons) {
    if (c.type === 'threshold') {
      if (price >= c.thresholdCents) {
        price -= c.minusCents;
        applied.push({ id: c.id, type: c.type, savedCents: c.minusCents });
      } else {
        rejected.push({ id: c.id, reason: `未满 ${c.thresholdCents} 分门槛` });
      }
    } else if (c.type === 'nofloor') {
      price -= c.minusCents;
      applied.push({ id: c.id, type: c.type, savedCents: c.minusCents });
    } else if (c.type === 'percent') {
      // 正确实现：折扣券「减 percentOff%」，即保留 (1 - percentOff/100)
      const saved = Math.round(price * (c.percentOff / 100));
      price -= saved;
      applied.push({ id: c.id, type: c.type, savedCents: saved });
    }
  }

  price = Math.max(0, price);
  return { finalCents: price, applied, rejected, originalCents: subtotalCents };
}
