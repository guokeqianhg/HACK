// 演示前 UI 链路就绪检查（固化 Playwright 真跑链路）
// 用法：node agent/check-ui-ready.mjs
// 仅做「静态就绪」校验（不联网、不起服务），输出 GO / 缺失项 + 修复命令。
// 真实 UI 冒烟由 run-test-officer.mjs 场景 A/C 或 `npm run smoke:ui` 执行。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const sampleApp = path.join(ROOT, 'sample-app');
const issues = [];
const ok = [];

function check(cond, label, fix) {
  if (cond) ok.push(label);
  else issues.push({ label, fix });
}

// 1) @playwright/test 依赖
const pkgPath = path.join(sampleApp, 'package.json');
let hasPwTestDep = false;
try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const d = pkg.devDependencies || {};
  hasPwTestDep = !!(d['@playwright/test'] || d.playwright);
} catch {}
check(hasPwTestDep, '@playwright/test 已声明依赖', 'cd sample-app && npm i -D @playwright/test playwright');

// 2) 本地已安装 @playwright/test
const pwBin = path.join(sampleApp, 'node_modules', '.bin', 'playwright' + (process.platform === 'win32' ? '.cmd' : ''));
check(fs.existsSync(pwBin), 'Playwright CLI 已安装(node_modules)', 'cd sample-app && npm i -D @playwright/test playwright');

// 3) Chromium 浏览器二进制存在（playwright 装在 sample-app/node_modules，须从那里解析）
let chromiumOk = false;
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(sampleApp, 'package.json'));
  const { chromium } = require('playwright');
  const exe = chromium.executablePath();
  chromiumOk = fs.existsSync(exe);
  if (!chromiumOk) issues.push({ label: `Chromium 二进制缺失(${exe})`, fix: 'cd sample-app && npx playwright install chromium' });
  else ok.push(`Chromium 二进制就绪(${exe})`);
} catch {
  issues.push({ label: '无法解析 playwright（核心未装）', fix: 'cd sample-app && npm i -D playwright' });
}

// 4) ui-smoke 用例文件存在
const spec = path.join(sampleApp, 'smoke', 'ui-smoke.spec.js');
check(fs.existsSync(spec), 'ui-smoke.spec.js 存在', '缺失前端冒烟用例');

console.log('\n=== AI 测试官 · UI 链路就绪检查 ===');
for (const o of ok) console.log(`  ✅ ${o}`);
for (const i of issues) console.log(`  ❌ ${i.label}\n      修复: ${i.fix}`);

if (issues.length === 0) {
  console.log('\n🟢 GO：UI 真跑链路就绪，场景 A/C 将以真实 Chromium 跑前端冒烟（不会 SKIP）。\n');
  process.exit(0);
} else {
  console.log('\n🔴 NO-GO：补齐上方缺失项后 UI 才会真跑；否则报告中前端将显示 ⏭ SKIP。\n');
  process.exit(1);
}
