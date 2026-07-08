import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, buildLineTotal } from '../src/checkout-client.js';

test('formatMoney 分转元', () => {
  assert.equal(formatMoney(29900), '¥299.00');
  assert.equal(formatMoney(0), '¥0.00');
});

test('buildLineTotal 行小计', () => {
  assert.equal(buildLineTotal(29900, 2), 59800);
});
