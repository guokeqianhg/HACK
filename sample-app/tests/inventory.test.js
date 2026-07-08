import test from 'node:test';
import assert from 'node:assert/strict';
import { setStock, getStock, reserve, release, resetInventory } from '../src/inventory.js';

test.beforeEach(() => resetInventory());

test('扣减成功返回剩余库存', () => {
  setStock('A', 5);
  const r = reserve('A', 2);
  assert.equal(r.ok, true);
  assert.equal(r.left, 3);
  assert.equal(getStock('A'), 3);
});

test('库存不足被拒绝', () => {
  setStock('A', 1);
  const r = reserve('A', 2);
  assert.equal(r.ok, false);
});

test('释放可回补库存', () => {
  setStock('A', 1);
  reserve('A', 1);
  release('A', 1);
  assert.equal(getStock('A'), 1);
});
