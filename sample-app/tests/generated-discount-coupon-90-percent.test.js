import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCouponStack } from '../src/coupon.js';

test('折扣券：9 折应付 90% (正确预期)', () => {
  const r = applyCouponStack(10000, [{ id: 'P1', type: 'percent', percentOff: 10 }]);
  // 正确行为：折扣券减 percentOff%，即保留 (1 - percentOff/100) = 0.9
  // 10000 * 0.9 = 9000
  assert.equal(r.finalCents, 9000);
  assert.equal(r.applied[0].savedCents, 1000);
});
