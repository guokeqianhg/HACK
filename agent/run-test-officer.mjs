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
import { selectTests, isSourceFile, isTestFile } from './select-tests.mjs';

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
  // 通用影响面：仅基于文件类型归类，不含任何业务语义硬编码
  const srcFiles = changedFiles.filter(isSourceFile);
  const testFiles = changedFiles.filter(isTestFile);
  const otherFiles = changedFiles.filter((f) => !isSourceFile(f) && !isTestFile(f));
  let scope;
  if (changedFiles.length === 0) scope = '无改动（全量回归）';
  else if (srcFiles.length && testFiles.length) scope = `源码与测试同步改动（${srcFiles.length} 源码 / ${testFiles.length} 测试）`;
  else if (testFiles.length && !srcFiles.length) scope = '仅测试改动';
  else if (otherFiles.length && !srcFiles.length) scope = '配置/文档改动';
  else scope = `纯源码改动（${srcFiles.length} 个文件）`;
  return { changedFiles, changedFunctions, scope, srcFiles, testFiles, otherFiles };
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

async function runInWorktree(targetRef, testFiles) {
  const wt = path.join(os.tmpdir(), `aio-${Date.now()}`);
  await git(repoDir, 'worktree', 'add', '--detach', wt, targetRef);
  const sutInWt = path.join(wt, path.relative(ROOT, repoDir)); // worktree 含整个仓库树，SUT 在 wt/<相对路径>
  // 把仓库内绝对测试路径映射到 worktree 内对应路径（精准选测的子集，或全量兜底）
  const wtTestFiles = testFiles.map((f) => path.join(sutInWt, path.relative(repoDir, f)));
  const runTests = wtTestFiles.length ? wtTestFiles : globSync(path.join(sutInWt, 'tests', '*.test.js'));
  const testOut = await run(sutInWt, 'node', ['--test', ...runTests]);
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

  // 通用精准选测：导入图反向可达 + 同名兜底（不依赖业务语义）
  const gitRoot = (await git(repoDir, 'rev-parse', '--show-toplevel')).trim();
  const sel = selectTests({ repoDir, gitRoot, changedFiles: impact.changedFiles });
  impact.affectedTests = sel.testFiles.map((f) => path.relative(repoDir, f));
  impact.narrowed = sel.narrowed;
  impact.selectionReason = sel.reason;
  console.log(`   ${sel.narrowed ? '🎯 精准选测' : '⚠️ 全量回退'}：${sel.reason}`);

  console.log('🧪 执行验证（worktree 真实跑测）…');
  const { unit, api } = await runInWorktree(target, sel.testFiles);
  const results = [...unit, ...api];

  const plan = [
    { step: `读 git diff ${base}..${target}`, why: '定位改动文件，判断影响面' },
    sel.narrowed
      ? { step: `仅跑受影响测试（${sel.testFiles.length} 个）`, why: sel.reason }
      : { step: '跑全量单测 node --test', why: sel.reason },
    { step: '跑 API 冒烟', why: '端到端验证核心链路（前端体验）' },
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
