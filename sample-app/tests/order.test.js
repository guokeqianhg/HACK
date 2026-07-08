import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrder } from '../src/order.js';
import { setStock, getStock, resetInventory } from '../src/inventory.js';

test.beforeEach(() => {
  resetInventory();
  setStock('SKU01', 10);
});

test('正常下单：返回订单号与优惠后金额', () => {
  const r = createOrder({
    items: [{ sku: 'SKU01', name: 'k', priceCents: 10000, qty: 1 }],
    coupons: [{ id: 'P1', type: 'percent', percentOff: 10 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.finalCents, 9000);
  assert.ok(r.orderId);
});

test('库存不足下单失败并回滚库存', () => {
  const r = createOrder({
    items: [{ sku: 'SKU01', name: 'k', priceCents: 10000, qty: 99 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVENTORY');
  assert.equal(getStock('SKU01'), 10); // 回滚成功
});
