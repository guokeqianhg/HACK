// 场景 C 离线冒烟：直接驱动真实 API 走核心下单路径（无需浏览器）
// 运行：node smoke/api-smoke.mjs
import { createServer } from '../src/server.js';
import { resetInventory, setStock } from '../src/inventory.js';

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

// 1) 商品列表
const prods = await (await fetch(`${base}/api/products`)).json();
check('商品列表返回 3 个商品', prods.length === 3);

// 2) 9 折券下单：29900 * 0.9 = 26910
const r1 = await fetch(`${base}/api/checkout`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    items: [{ sku: 'SKU01', name: '机械键盘', priceCents: 29900, qty: 1 }],
    coupons: [{ id: 'P1', type: 'percent', percentOff: 10 }],
  }),
});
const o1 = await r1.json();
check('下单成功', o1.ok === true);
check('9 折后应付 26910 分(¥269.10)', o1.finalCents === 26910);

// 3) 库存已扣减
const inv = await (await fetch(`${base}/api/inventory`)).json();
check('库存已扣减至 9', inv.SKU01 === 9);

// 4) 库存不足拦截
const r2 = await fetch(`${base}/api/checkout`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ sku: 'SKU02', name: '无线鼠标', priceCents: 9900, qty: 999 }] }),
});
const o2 = await r2.json();
check('库存不足被拒绝(INVENTORY)', o2.ok === false && o2.code === 'INVENTORY');

server.close();
server.closeAllConnections?.(); // 立即关闭 keep-alive socket，避免事件循环排空导致进程 hang
console.log(failures === 0 ? '\n✅ ALL SMOKE PASS' : `\n❌ ${failures} SMOKE FAILED`);
// 用 exitCode 而非 process.exit，避免与 undici keep-alive socket 关闭竞争导致 libuv 断言
process.exitCode = failures === 0 ? 0 : 1;
