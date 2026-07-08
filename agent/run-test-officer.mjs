// AI 测试官 · 执行引擎（闭环：理解 diff → 规划 → 真实跑测 → 生成报告）
// 零依赖：基于 git + node --test + node smoke/api-smoke.mjs
//
// 用法：
//   node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
//
// 机制：
//   1. 理解：git diff base..target，提取改动文件/函数/风险
//   2. 执行：用 git worktree 在 target 代码上真实运行单测 + API 冒烟（不污染当前分支）
//   3. 报告：解析真实输出 → 写 report/report.json → 调 generate-report.mjs 渲染 HTML 看板

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---------- 参数 ----------
const args = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) m[a.slice(2)] = arr[i + 1];
  return m;
}, {});
const repoDir = path.resolve(ROOT, args.repo || 'sample-app');
const base = args.base || 'main';
const target = args.target || 'HEAD';
const scenario = args.scenario || 'A';
const triggeredBy = args.triggeredBy || `分支 ${target} 对比 ${base}`;

// ---------- 1. 理解：git diff ----------
function git(cwd, ...argv) {
  return new Promise((res, rej) => {
    const p = spawn('git', argv, { cwd, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(out))));
  });
}

function analyzeDiff(diffText) {
  const changedFiles = [...diffText.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  const changedFunctions = [
    ...new Set(
      [...diffText.matchAll(/@@[^\n]*@@\s*(.+?)\s*$/gm)].map((m) => m[1].trim()).filter(Boolean),
    ),
  ];
  const riskRules = [
    { match: 'src/coupon.js', risk: '优惠计算错误可能导致资损（如折扣/满减算错导致订单金额异常）', scene: '下单-使用优惠券' },
    { match: 'src/inventory.js', risk: '库存扣减错误可能导致超卖或少卖', scene: '下单-库存校验' },
    { match: 'src/order.js', risk: '下单编排错误可能导致下单失败或金额错误', scene: '下单链路' },
    { match: 'src/server.js', risk: '接口错误可能导致前端请求失败或返回错误数据', scene: '前端体验' },
  ];
  const risks = changedFiles
    .map((f) => riskRules.find((r) => f.endsWith(r.match)))
    .filter(Boolean);
  const risk = risks.map((r) => r.risk).join('；') || '改动未命中已知高风险模块';
  const affectedScenarios = [...new Set(risks.map((r) => r.scene))];
  return { changedFiles, changedFunctions, risk, affectedScenarios };
}

// ---------- 2. 执行：在 worktree 真实跑测 ----------
function run(cwd, cmd, cmdArgs) {
  return new Promise((res) => {
    const p = spawn(cmd, cmdArgs, { cwd, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => res({ code, out }));
  });
}

function parseNodeTest(out) {
  const results = [];
  const failByName = new Map();
  const seen = new Set();
  let lastFailName = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^✔ /.test(line)) {
      const name = line.slice(2).split(' (')[0].trim();
      if (!seen.has(name)) {
        seen.add(name);
        results.push({ name, type: 'unit', status: 'pass', severity: '-', rootCause: '-', repro: 'node --test' });
      }
      lastFailName = null;
    } else if (/^✖ /.test(line)) {
      const name = line.slice(2).split(' (')[0].trim();
      if (name === 'failing tests:') {
        lastFailName = null;
        continue;
      }
      lastFailName = name;
      if (!seen.has(name)) {
        seen.add(name);
        const r = { name, type: 'unit', status: 'fail', severity: 'high', rootCause: '', repro: 'node --test' };
        failByName.set(name, r);
        results.push(r);
      }
    } else if (lastFailName) {
      const r = failByName.get(lastFailName);
      if (/AssertionError|strictEqual|!==|expected|actual/i.test(line)) {
        r.rootCause += line.trim() + ' ';
      } else if (/tests[\\/][\w.-]+\.test\.js/.test(line)) {
        const f = line.match(/tests[\\/][\w.-]+\.test\.js/)[0];
        if (!r.rootCause.includes(f)) r.rootCause += `(${f})`;
        lastFailName = null;
      }
    }
  }
  return results;
}

function parseApiSmoke(out) {
  const results = [];
  const lines = out.split('\n');
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(PASS|FAIL)\s+(.+)$/);
    if (m) {
      const name = m[2].trim();
      cur = {
        name,
        type: 'api',
        status: m[1] === 'PASS' ? 'pass' : 'fail',
        severity: m[1] === 'PASS' ? '-' : 'high',
        rootCause: /应付|库存/.test(name) ? name : '-',
        repro: 'node smoke/api-smoke.mjs',
      };
      results.push(cur);
    }
  }
  return results;
}

async function runInWorktree(targetRef) {
  const wt = path.join(os.tmpdir(), `aio-${Date.now()}`);
  await git(repoDir, 'worktree', 'add', '--detach', wt, targetRef);
  const sutInWt = path.join(wt, path.relative(ROOT, repoDir)); // worktree 含整个仓库树，SUT 在 wt/<相对路径>
  const testFiles = globSync(path.join(sutInWt, 'tests', '*.test.js'));
  const testOut = await run(sutInWt, 'node', ['--test', ...testFiles]);
  const smokeOut = await run(sutInWt, 'node', ['smoke/api-smoke.mjs']);
  await git(repoDir, 'worktree', 'remove', '--force', wt);
  return { unit: parseNodeTest(testOut.out), api: parseApiSmoke(smokeOut.out) };
}

// ---------- 3. 报告 ----------
function summarize(results) {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const blocking = fail > 0 ? ['存在失败用例，须修复并复测通过后方可合入/发布'] : [];
  return { total: results.length, pass, fail, blocking };
}

async function main() {
  console.log(`🔍 理解变更：${base}..${target}`);
  const diffText = await git(repoDir, 'diff', `${base}..${target}`);
  const impact = analyzeDiff(diffText);
  console.log(`   改动文件：${impact.changedFiles.join(', ') || '(无)'}`);
  console.log(`   改动函数：${impact.changedFunctions.join(', ') || '(无)'}`);

  console.log('🧪 执行验证（worktree 真实跑测）…');
  const { unit, api } = await runInWorktree(target);
  const results = [...unit, ...api];

  const plan = [
    { step: `读 git diff ${base}..${target}`, why: '定位改动文件/函数，判断影响面' },
    { step: '跑单测 node --test', why: impact.changedFiles.length ? `直接覆盖改动模块(${impact.changedFiles.join(',')})` : '回归核心逻辑' },
    { step: '跑 API 冒烟', why: '端到端验证下单/优惠/库存链路（前端体验）' },
  ];

  const report = {
    meta: { title: 'AI 测试官报告', repo: path.basename(repoDir), scenario, triggeredBy, generatedAt: new Date().toISOString() },
    impact,
    plan,
    results,
    summary: summarize(results),
  };

  const reportJsonPath = path.join(ROOT, 'report', 'report.json');
  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`📝 已写 ${reportJsonPath}`);

  await run(ROOT, 'node', ['report/generate-report.mjs']);
  console.log(`\n✅ 完成：通过 ${report.summary.pass} / 失败 ${report.summary.fail}`);
}

main().catch((e) => {
  console.error('❌ 执行失败:', e.message);
  process.exit(1);
});
