// 迷你电商后端服务（零依赖，使用 node 内置 http）
// 同时托管前端静态资源（public/、src/）与 JSON API。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrder } from './order.js';
import { getStock, setStock, resetInventory } from './inventory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PRODUCTS = [
  { sku: 'SKU01', name: '机械键盘', priceCents: 29900, stock: 10 },
  { sku: 'SKU02', name: '无线鼠标', priceCents: 9900, stock: 20 },
  { sku: 'SKU03', name: '4K显示器', priceCents: 159900, stock: 5 },
];

function seedInventory() {
  resetInventory();
  for (const p of PRODUCTS) setStock(p.sku, p.stock);
}

// 初始化库存
seedInventory();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function canResetForTest(req) {
  return process.env.ENABLE_TEST_RESET === '1' || process.env.NODE_ENV === 'test' || isLocalRequest(req);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // API
    if (req.method === 'GET' && url.pathname === '/api/products') {
      return sendJson(res, 200, PRODUCTS.map((p) => ({ ...p, stock: getStock(p.sku) })));
    }
    if (req.method === 'GET' && url.pathname === '/api/inventory') {
      return sendJson(res, 200, Object.fromEntries(PRODUCTS.map((p) => [p.sku, getStock(p.sku)])));
    }
    if (req.method === 'POST' && url.pathname === '/api/test/reset') {
      if (!canResetForTest(req)) return sendJson(res, 403, { ok: false, message: 'test reset disabled' });
      seedInventory();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      let body = '';
      req.on('data', (c) => (body += c));
      await new Promise((r) => req.on('end', r));
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, message: 'bad json' });
      }
      const result = createOrder(payload);
      return sendJson(res, result.ok ? 200 : 422, result);
    }

    // 静态资源
    if (req.method === 'GET' && !url.pathname.startsWith('/api')) {
      const rel = url.pathname === '/' ? '/public/index.html' : url.pathname;
      const fp = path.normalize(path.join(ROOT, rel));
      if (!fp.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      try {
        const buf = await readFile(fp);
        const ext = path.extname(fp);
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        return res.end(buf);
      } catch {
        res.writeHead(404);
        return res.end('Not Found');
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`SUT running on http://${host}:${port}`));
}
