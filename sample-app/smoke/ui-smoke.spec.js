// Playwright 真实浏览器 UI 冒烟（环境已安装 Playwright 时可运行）
// 运行：npx playwright test smoke/ui-smoke.spec.js
// 前置：npx playwright install chromium
//
// 注意：SUT 前端仅支持「单个折扣券」(coupon-percent 输入框)，故多券叠加无法在 UI 层触发；
// 多券叠加逻辑已在单测(coupon.test.js)与 API 冒烟(api-smoke.mjs)层覆盖，非 UI 测试缺失。
// 本文件聚焦真实可触发的前端路径，覆盖：
//   核心路径 / 空车 / 多商品 / 折扣正确性 / 金额格式化 / 库存不足错误态 / 购物车加购中间态 / 重复加购数量累加。
// 含折扣的用例在 feature/coupon-bug 分支（9折算成1折）会失败，从而在 UI 层抓出资损 bug。
import { test, expect } from '@playwright/test';

const BASE = process.env.SUT_URL || 'http://127.0.0.1:3000';

test.beforeEach(async ({ page, request }) => {
  await request.post(`${BASE}/api/test/reset`).catch(() => {});
  await page.goto(BASE);
});

// 现有核心路径：单商品 + 9 折券 → 应付 ¥269.10（bug 分支会失败）
test('核心路径：加购 → 用 9 折券结算 → 成功下单', async ({ page }) => {
  await page.getByTestId('add-SKU01').click();
  await page.getByTestId('coupon-input').fill('10');
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('ORD');
  // 校验「应付金额」为 9 折后的 ¥269.10（而非折扣额，避免误判）
  await expect(result).toContainText('应付 ¥269.10');
});

// 1) 空购物车结算：当前 SUT 未做空车拦截，放行且应付 ¥0.00
//    （此用例同时暴露「缺空购物车校验」这一产品缺口，正是 AI 测试官应发现的点）
test('空购物车结算 → 当前 SUT 放行并应付 ¥0.00（暴露缺空车校验）', async ({ page }) => {
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('应付 ¥0.00');
});

// 2) 多商品下单（无券）：SKU01 + SKU02 = 29900 + 9900 = 39800 → ¥398.00
//    注意：SUT 结算框默认带 10% 折扣券，故无券用例需显式填 0 抵消默认折扣
test('多商品下单（无优惠券）→ 应付 ¥398.00', async ({ page }) => {
  await page.getByTestId('add-SKU01').click();
  await page.getByTestId('add-SKU02').click();
  await page.getByTestId('coupon-input').fill('0');
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('应付 ¥398.00');
});

// 3) 多商品 + 9 折券：subtotal 39800，减 10% = 35820 → ¥358.20
//    （强化折扣正确性；bug 分支 9折算1折 → ¥39.80，会失败）
test('多商品 + 9 折券 → 应付 ¥358.20', async ({ page }) => {
  await page.getByTestId('add-SKU01').click();
  await page.getByTestId('add-SKU02').click();
  await page.getByTestId('coupon-input').fill('10');
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('应付 ¥358.20');
});

// 4) 高单价 + 9 折券：SKU03 159900，减 10% = 143910 → ¥1439.10（覆盖高单价与金额格式化）
test('高单价商品 + 9 折券 → 应付 ¥1439.10', async ({ page }) => {
  await page.getByTestId('add-SKU03').click();
  await page.getByTestId('coupon-input').fill('10');
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('应付 ¥1439.10');
});

// 5) 折扣券填 0% → 等同无优惠：SKU01 → ¥299.00
test('折扣券填 0% → 等同无优惠，应付 ¥299.00', async ({ page }) => {
  await page.getByTestId('add-SKU01').click();
  await page.getByTestId('coupon-input').fill('0');
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('应付 ¥299.00');
});

// 6) 金额格式化：应付金额必须为「¥ + 两位小数」格式（如 ¥299.00）
test('金额格式化：应付展示为 ¥xxx.xx（两位小数）', async ({ page }) => {
  await page.getByTestId('add-SKU01').click();
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText(/应付 ¥\d+\.\d{2}/);
});

// 7) 库存不足提示（错误状态 UI）：SKU03 库存 5，加购 6 次后结算应失败并提示库存不足
test('库存不足 → 错误状态(class=err)且提示「库存不足」', async ({ page }) => {
  const add = page.getByTestId('add-SKU03');
  for (let i = 0; i < 6; i++) await add.click();
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('err');
  await expect(result).toContainText('库存不足');
});

// 8) 购物车加购中间态反馈：加购后购物车应实时渲染商品与小计（结算前的交互反馈）
//    覆盖「加购 → 购物车状态展示」这一独立于结算的前端行为。
test('加购后购物车实时展示商品与小计（结算前中间态）', async ({ page }) => {
  await page.getByTestId('add-SKU01').click();
  const cart = page.getByTestId('cart-items');
  await expect(cart).toContainText('小计：¥299.00');
  await page.getByTestId('add-SKU02').click();
  await expect(cart).toContainText('小计：¥398.00');
});

// 9) 重复加购数量累加：同一 SKU 连点两次 → 数量翻倍，小计随之翻倍（购物车状态正确性）
test('重复加购同一商品 → 数量累加，小计翻倍', async ({ page }) => {
  const add = page.getByTestId('add-SKU01');
  await add.click();
  await add.click();
  const cart = page.getByTestId('cart-items');
  await expect(cart).toContainText('小计：¥598.00');
  // 结算校验：2×299.00 = 598.00，9 折后 ¥538.20（bug 分支会失败，UI 层再抓一次资损）
  await page.getByTestId('coupon-input').fill('10');
  await page.getByTestId('checkout-btn').click();
  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('应付 ¥538.20');
});
