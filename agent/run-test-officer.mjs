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
import { selectTests, isSourceFile, isTestFile, testsForModule } from './select-tests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---------- 参数 ----------
const args = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = arr[i + 1];
    // 支持「不带值的开关」如 --help：下一个 token 仍是 -- 开头或无则记为 true
    m[k] = v === undefined || v.startsWith('--') ? true : v;
  }
  return m;
}, {});

if (args.help) {
  console.log(`AI 测试官 · 执行引擎（理解 diff → 规划 → 真实跑测 → 报告）
用法：
  node agent/run-test-officer.mjs --repo <dir> --base <ref> --target <ref> --scenario <A|B|C>
                                [--requirement <json>] [--out <name>] [--triggeredBy <text>]

场景：
  A  代码改动驱动：git diff base..target → 精准选测 → 在目标分支真实跑测
  B  需求驱动：读 requirement JSON → 需求覆盖度报告（需 --requirement，默认 docs/requirement-demo.json）
  C  持续巡检用：base==target 时为全量回归（实际由 cron-monitor 调用）

示例：
  node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
  node agent/run-test-officer.mjs --repo sample-app --base main --target main --scenario B --requirement sample-app/docs/requirement-demo.json`);
  process.exit(0);
}

const repoDir = path.resolve(ROOT, args.repo || 'sample-app');
const base = args.base || 'main';
const target = args.target || 'HEAD';
const scenario = args.scenario || 'A';
const triggeredBy = args.triggeredBy || `分支 ${target} 对比 ${base}`;

if (!['A', 'B', 'C'].includes(scenario)) {
  console.error(`❌ 非法 --scenario "${scenario}"，仅支持 A / B / C（用 --help 查看用法）`);
  process.exit(1);
}

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
        const r = { name, type: 'unit', status: 'fail', severity: 'high', rootCause: '', repro: 'node --test', testFile: '' };
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
        if (!r.testFile) r.testFile = f.split(/[\\/]/).pop();
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
        // 通用：失败用例的 rootCause 直接用可读的 check 名，不做任何业务关键词特判
        rootCause: m[1] === 'PASS' ? '-' : name,
        repro: 'node smoke/api-smoke.mjs',
      };
      results.push(cur);
    }
  }
  return results;
}

async function runInWorktree(targetRef, testFiles) {
  const wt = path.join(os.tmpdir(), `aio-${Date.now()}`);
  let testOut, smokeOut;
  try {
    await git(repoDir, 'worktree', 'add', '--detach', wt, targetRef);
    const sutInWt = path.join(wt, path.relative(ROOT, repoDir)); // worktree 含整个仓库树，SUT 在 wt/<相对路径>
    // 把仓库内绝对测试路径映射到 worktree 内对应路径（精准选测的子集，或全量兜底）
    const wtTestFiles = testFiles.map((f) => path.join(sutInWt, path.relative(repoDir, f)));
    const runTests = wtTestFiles.length ? wtTestFiles : globSync(path.join(sutInWt, 'tests', '*.test.js'));
    // 显式锁定 spec reporter：node:test 默认 reporter 受环境/版本影响，
    // 锁定后 parseNodeTest 才能稳定按 ✔/✖ 行解析，避免解析失败导致结果丢失
    testOut = await run(sutInWt, 'node', ['--test', '--test-reporter=spec', ...runTests]);
    smokeOut = await run(sutInWt, 'node', ['smoke/api-smoke.mjs']);
  } finally {
    // 无论成功或失败都清理 worktree，避免 detached 分支/工作树残留污染仓库
    await git(repoDir, 'worktree', 'remove', '--force', wt).catch(() => {});
  }
  return { unit: parseNodeTest(testOut.out), api: parseApiSmoke(smokeOut.out) };
}

// ---------- 3. 报告 ----------
function summarize(results) {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const blocking = fail > 0 ? ['存在失败用例，须修复并复测通过后方可合入/发布'] : [];
  return { total: results.length, pass, fail, blocking };
}

// 场景 B：读需求/缺陷 fixture（离线版 TAPD），结构通用：
//   { id, title, source, affectedModules:[相对 repoDir 的源码路径], points:[{id,desc,module}] }
function readRequirement(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!raw.points || !Array.isArray(raw.points)) throw new Error('需求 fixture 缺少 points 数组');
  return raw;
}

// 场景 B：把需求点映射到测试执行结果，产出「需求覆盖度」
//   status: pass（有测试且全过）/ fail（该模块直接对应测试有失败）/ gap（无对应测试 → 测试缺口）
function computeCoverage(req, results, repoDir) {
  const failingFiles = new Set(results.filter((r) => r.status === 'fail' && r.testFile).map((r) => r.testFile));
  return req.points.map((pt) => {
    const tFiles = testsForModule(repoDir, pt.module).map((f) => path.basename(f));
    let status;
    if (tFiles.length === 0) status = 'gap';
    else if (tFiles.some((t) => failingFiles.has(t))) status = 'fail';
    else status = 'pass';
    return { id: pt.id, desc: pt.desc, module: pt.module, status, tests: tFiles };
  });
}

// 统一生成「AI 测试官过程时间线」，供 HTML 可视化（不依赖业务语义）
function buildProcess({ scenario, req, impact, sel, summary }) {
  const phases = [];
  if (scenario === 'B') {
    phases.push({ title: '① 读需求/缺陷', detail: `${req.id} · ${req.title}`, status: 'done' });
    phases.push({ title: '② 拆解测试点', detail: `${req.points.length} 个测试点 / 命中 ${impact.srcFiles.length} 个模块`, status: 'done' });
  } else {
    phases.push({ title: '① 理解变更', detail: `git diff ${base}..${target}`, status: 'done' });
    phases.push({ title: '② 影响面分析', detail: impact.changedFiles.join(', ') || '（无改动）', status: 'done' });
  }
  phases.push({
    title: '③ 选测策略',
    detail: sel.narrowed ? `🎯 精准选测 ${sel.testFiles.length} 个` : `⚠️ 全量回退 ${sel.testFiles.length} 个`,
    status: 'done',
  });
  phases.push({
    title: '④ 执行验证',
    detail: `通过 ${summary.pass} / 失败 ${summary.fail}`,
    status: summary.fail > 0 ? 'warn' : 'done',
  });
  phases.push({ title: '⑤ 生成可决策报告', detail: 'report/index.html', status: 'done' });
  return phases;
}

async function main() {
  const outName = args.out || 'report';
  const reportJsonPath = path.join(ROOT, 'report', `${outName}.json`);

  // --- 场景 B：需求驱动（离线读取 fixture，复用通用选测引擎）---
  if (scenario === 'B') {
    const reqPath = args.requirement || path.join(repoDir, 'docs', 'requirement-demo.json');
    const req = readRequirement(reqPath);
    const gitRoot = (await git(repoDir, 'rev-parse', '--show-toplevel')).trim();
    const rel = path.relative(gitRoot, repoDir);
    const changedFiles = req.affectedModules.map((m) => path.join(rel, m));
    const impact = {
      changedFiles,
      changedFunctions: [],
      scope: `需求驱动（场景 B）：${req.title}`,
      requirement: { id: req.id, title: req.title, source: req.source },
      srcFiles: changedFiles.filter(isSourceFile),
      testFiles: [],
      otherFiles: [],
    };
    const sel = selectTests({ repoDir, gitRoot, changedFiles });
    impact.affectedTests = sel.testFiles.map((f) => path.relative(repoDir, f));
    impact.narrowed = sel.narrowed;
    impact.selectionReason = sel.reason;
    console.log(`📋 场景 B · 需求 ${req.id}（${req.points.length} 测试点）→ 关联 ${sel.testFiles.length} 个测试`);

    console.log('🧪 执行验证（worktree 真实跑测）…');
    const { unit, api } = await runInWorktree(target, sel.testFiles);
    const results = [...unit, ...api];
    const coverage = computeCoverage(req, results, repoDir);
    const covered = coverage.filter((c) => c.status === 'pass').length;
    const gaps = coverage.filter((c) => c.status === 'gap').length;
    const failingPts = coverage.filter((c) => c.status === 'fail').length;

    const plan = [
      { step: `读需求文档 ${req.id}`, why: '拆解测试点，明确应验证的能力' },
      { step: `关联代码模块（${impact.srcFiles.length} 个）`, why: '把需求点映射到实现源码' },
      sel.narrowed ? { step: `仅跑受影响测试（${sel.testFiles.length} 个）`, why: sel.reason } : { step: '跑全量单测', why: sel.reason },
      { step: '跑 API 端到端冒烟', why: '真实 API 端到端验证核心下单链路' },
      { step: '产出需求覆盖度报告', why: `已覆盖 ${covered} / 缺口 ${gaps} / 不达标 ${failingPts}` },
    ];
    const report = {
      meta: { title: 'AI 测试官报告', repo: path.basename(repoDir), scenario, triggeredBy, generatedAt: new Date().toISOString() },
      impact,
      plan,
      results,
      coverage,
      process: buildProcess({ scenario, req, impact, sel, summary: summarize(results) }),
      summary: summarize(results),
    };
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`📝 已写 ${reportJsonPath}`);
    await run(ROOT, 'node', ['report/generate-report.mjs', reportJsonPath]);
    console.log(`\n✅ 场景 B 完成：覆盖 ${covered} / 缺口 ${gaps} / 不达标 ${failingPts}`);
    return;
  }

  // --- 场景 A / C：代码改动驱动（或 base=target 全量回归）---
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
    { step: '跑 API 端到端冒烟', why: '真实 API 端到端验证核心下单链路' },
  ];

  const report = {
    meta: { title: 'AI 测试官报告', repo: path.basename(repoDir), scenario, triggeredBy, generatedAt: new Date().toISOString() },
    impact,
    plan,
    results,
    process: buildProcess({ scenario, impact, sel, summary: summarize(results) }),
    summary: summarize(results),
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`📝 已写 ${reportJsonPath}`);

  await run(ROOT, 'node', ['report/generate-report.mjs', reportJsonPath]);
  console.log(`\n✅ 完成：通过 ${report.summary.pass} / 失败 ${report.summary.fail}`);
}

main().catch((e) => {
  console.error('❌ 执行失败:', e.message);
  process.exit(1);
});
