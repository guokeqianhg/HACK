// Playwright 真实浏览器 UI 冒烟（环境已安装 Playwright 时可运行）
// 运行：npx playwright test smoke/ui-smoke.spec.js
// 前置：npx playwright install chromium
import { test, expect } from '@playwright/test';

const BASE = process.env.SUT_URL || 'http://localhost:3000';

test('核心路径：加购 → 用 9 折券结算 → 成功下单', async ({ page }) => {
  await page.goto(BASE);

  // 加入机械键盘
  await page.getByTestId('add-SKU01').click();

  // 设置折扣券 10%（9 折）并提交
  await page.getByTestId('coupon-input').fill('10');
  await page.getByTestId('checkout-btn').click();

  const result = page.getByTestId('result');
  await expect(result).toHaveClass('ok');
  await expect(result).toContainText('ORD');
  await expect(result).toContainText('¥269.10');
});
