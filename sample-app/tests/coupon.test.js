import test from 'node:test';
import assert from 'node:assert/strict';
import { calcSubtotal, applyCouponStack } from '../src/coupon.js';

test('小计 = 单价 × 数量', () => {
  assert.equal(calcSubtotal([{ priceCents: 10000, qty: 2 }]), 20000);
});

test('满减券：满足门槛才生效', () => {
  const r = applyCouponStack(20000, [{ id: 'T1', type: 'threshold', thresholdCents: 15000, minusCents: 3000 }]);
  assert.equal(r.finalCents, 17000);
  assert.equal(r.applied.length, 1);
});

test('满减券：不满门槛被拒绝', () => {
  const r = applyCouponStack(10000, [{ id: 'T1', type: 'threshold', thresholdCents: 15000, minusCents: 3000 }]);
  assert.equal(r.finalCents, 10000);
  assert.equal(r.rejected.length, 1);
});

test('折扣券：9 折应付 90%', () => {
  const r = applyCouponStack(10000, [{ id: 'P1', type: 'percent', percentOff: 10 }]);
  assert.equal(r.finalCents, 9000);
  assert.equal(r.applied[0].savedCents, 1000);
});

test('叠加：满减 + 无门槛 + 折扣', () => {
  const r = applyCouponStack(20000, [
    { id: 'T1', type: 'threshold', thresholdCents: 15000, minusCents: 3000 },
    { id: 'N1', type: 'nofloor', minusCents: 1000 },
    { id: 'P1', type: 'percent', percentOff: 10 },
  ]);
  // 20000 - 3000 - 1000 = 16000; 16000 * 0.9 = 14400
  assert.equal(r.finalCents, 14400);
});

test('价格不为负', () => {
  const r = applyCouponStack(1000, [{ id: 'N1', type: 'nofloor', minusCents: 5000 }]);
  assert.equal(r.finalCents, 0);
});

test('无门槛立减券：直接立减固定金额', () => {
  const r = applyCouponStack(10000, [{ id: 'N1', type: 'nofloor', minusCents: 1000 }]);
  assert.equal(r.finalCents, 9000);
  assert.equal(r.applied.length, 1);
});
