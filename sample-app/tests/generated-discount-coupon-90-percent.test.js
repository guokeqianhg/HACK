import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCouponStack } from '../src/coupon.js';

test('折扣券：9折应付90%', () => {
  const r = applyCouponStack(10000, [{ id: 'P1', type: 'percent', percentOff: 10 }]);
  assert.equal(r.finalCents, 9000);
  assert.equal(r.applied[0].savedCents, 1000);
});
