// 浏览器端结账逻辑（ES Module，导入共享逻辑模块以便离线单测）
import { formatMoney, buildLineTotal } from '/src/checkout-client.js';

const state = { products: [], cart: [] };

async function loadProducts() {
  const res = await fetch('/api/products');
  state.products = await res.json();
  renderProducts();
}

function renderProducts() {
  const ul = document.getElementById('product-items');
  ul.innerHTML = '';
  for (const p of state.products) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${p.name}</span>
      <span>${formatMoney(p.priceCents)}</span>
      <span>库存 ${p.stock}</span>
      <button data-sku="${p.sku}" data-testid="add-${p.sku}">加入购物车</button>`;
    li.querySelector('button').addEventListener('click', () => addToCart(p.sku));
    ul.appendChild(li);
  }
}

function addToCart(sku) {
  const p = state.products.find((x) => x.sku === sku);
  const existing = state.cart.find((x) => x.sku === sku);
  if (existing) existing.qty += 1;
  else state.cart.push({ sku: p.sku, name: p.name, priceCents: p.priceCents, qty: 1 });
  renderCart();
}

function renderCart() {
  const ul = document.getElementById('cart-items');
  ul.innerHTML = '';
  let subtotal = 0;
  for (const it of state.cart) {
    const line = buildLineTotal(it.priceCents, it.qty);
    subtotal += line;
    const li = document.createElement('li');
    li.textContent = `${it.name} ×${it.qty} = ${formatMoney(line)}`;
    ul.appendChild(li);
  }
  const hint = document.createElement('li');
  hint.textContent = `小计：${formatMoney(subtotal)}`;
  ul.appendChild(hint);
}

async function checkout() {
  const percent = Number(document.getElementById('coupon-percent').value) || 0;
  const coupons = percent > 0 ? [{ id: 'P1', type: 'percent', percentOff: percent }] : [];
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: state.cart, coupons }),
  });
  const data = await res.json();
  const box = document.getElementById('result');
  if (data.ok) {
    box.className = 'ok';
    box.textContent = `下单成功 ${data.orderId} 应付 ${formatMoney(data.finalCents)}（已优惠 ${formatMoney(data.subtotalCents - data.finalCents)}）`;
  } else {
    box.className = 'err';
    box.textContent = `下单失败：${data.message || data.code}`;
  }
}

document.getElementById('checkout').addEventListener('click', checkout);
loadProducts();
