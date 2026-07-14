import test from 'node:test';
import assert from 'node:assert/strict';
import { calcSubtotal, applyCouponStack } from '../src/coupon.js';

test('叠加：满减 + 无门槛 + 折扣（正确顺序与计算）', () => {
  const r = applyCouponStack(20000, [
    { id: 'T1', type: 'threshold', thresholdCents: 15000, minusCents: 3000 },
    { id: 'N1', type: 'nofloor', minusCents: 1000 },
    { id: 'P1', type: 'percent', percentOff: 10 },
  ]);
  // 正确计算：20000 - 3000 = 17000; 17000 - 1000 = 16000; 16000 * 0.9 = 14400
  assert.equal(r.finalCents, 14400);
  assert.equal(r.applied.length, 3);
  assert.equal(r.applied[0].savedCents, 3000);
  assert.equal(r.applied[1].savedCents, 1000);
  assert.equal(r.applied[2].savedCents, 1600);
});
