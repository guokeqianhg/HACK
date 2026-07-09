// AI 测试官 · 执行引擎（闭环：理解 diff → 规划 → 真实跑测 → 生成报告）
// 核心零依赖：基于 git + node --test + node smoke/api-smoke.mjs
// 前端体验链路（可选）：worktree 起 SUT 服务 + Playwright 跑 ui-smoke（需 sample-app 安装 @playwright/test）
//
// 用法：
//   node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
//
// 机制：
//   1. 理解：git diff base..target（或 --diff 直接喂入「TGit/工蜂 MCP 取回的 MR diff」），提取改动文件/函数/风险
//   2. 执行：用 git worktree 在 target 代码上真实运行单测 + API 冒烟 + 前端 UI 冒烟（不污染当前分支）
//   3. 报告：解析真实输出 → 写 report/report.json → 调 generate-report.mjs 渲染 HTML 看板
//
// MCP 接入（让平台能力从「装饰」变「可用」）：
//   - 场景 A：TGit/工蜂 MCP 取 MR/PR diff → 写入文件 → --diff <file> 直接喂入，避免重复 git 计算，也支持跨仓库远程 diff
//   - 场景 B：TAPD MCP 取需求/缺陷 → 整理为 fixture JSON → --requirement <file> 注入
//   （MCP 工具由驱动本 Agent 的 LLM 宿主调用；本脚本负责接收「MCP 取回的内容」并执行闭环）

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectTests, isSourceFile, isTestFile, testsForModule } from './select-tests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 鲁棒读取文本文件：兼容 UTF-8 / UTF-16LE（含或不含 BOM），避免 LLM/工具写出的文件因编码差异导致解析失败
function readTextRobust(p) {
  const buf = fs.readFileSync(p);
  let s;
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    s = buf.swap16().toString('utf16le'); // UTF-16 BE（罕见）
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    s = buf.toString('utf16le', 2); // UTF-16 LE（跳过 BOM）
  } else if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00 && buf[0] !== 0x00) {
    s = buf.toString('utf16le'); // 无 BOM 的 UTF-16LE（ASCII 占偶数字节）
  } else {
    s = buf.toString('utf8');
  }
  return s.replace(/^﻿/, '');
}

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
                                [--requirement <json>] [--diff <file>] [--out <name>] [--triggeredBy <text>]

场景：
  A  代码改动驱动：git diff base..target（或 --diff 直接喂入 TGit/工蜂 MCP 取回的 MR diff）→ 精准选测 → 在目标分支真实跑测
  B  需求驱动：读 requirement JSON（可由 TAPD MCP 取回后写出）→ 需求覆盖度报告（需 --requirement，默认 docs/requirement-demo.json）
  C  持续巡检用：base==target 时为全量回归（实际由 cron-monitor 调用）

示例：
  node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
  node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A --diff report/.mcp-diff.txt
  node agent/run-test-officer.mjs --repo sample-app --base main --target main --scenario B --requirement sample-app/docs/requirement-demo.json`);
  process.exit(0);
}

const repoDir = path.resolve(ROOT, args.repo || 'sample-app');
const base = args.base || 'main';
const target = args.target || 'HEAD';
const scenario = args.scenario || 'A';
const triggeredBy = args.triggeredBy || `分支 ${target} 对比 ${base}`;
// MCP 注入口：场景 A 可由 TGit/工蜂 MCP 取回 MR diff 后通过 --diff 直接喂入
const diffFile = args.diff || '';

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
  // 防御：MCP/外部取回的 diff 可能带 UTF-8 BOM，会破坏首行 ^diff 匹配，先剥掉
  const text = String(diffText).replace(/^﻿/, '');
  const changedFiles = [...text.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
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
function run(cwd, cmd, cmdArgs, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { cwd, windowsHide: true, env: opts.env || process.env, shell: !!opts.shell });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => rej(e)); // spawn 失败（如二进制缺失）转为 reject，避免未捕获崩溃
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

function parsePlaywright(out, code) {
  const results = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // 通过：✓ name (Xs)
    const mPass = line.match(/^\s*[✓✔]\s+(.+?)\s+\([\d.]+s\)/);
    if (mPass) {
      cur = { name: mPass[1].trim(), type: 'ui', status: 'pass', severity: '-', rootCause: '-', repro: 'playwright test smoke/ui-smoke.spec.js', testFile: 'ui-smoke.spec.js' };
      results.push(cur);
      continue;
    }
    // 失败：  1) file:line › name ───────
    const mFail = line.match(/^\s*\d+\)\s+.+?›\s+(.+?)\s+─{5,}/);
    if (mFail) {
      cur = { name: mFail[1].trim(), type: 'ui', status: 'fail', severity: 'high', rootCause: '', repro: 'playwright test smoke/ui-smoke.spec.js', testFile: 'ui-smoke.spec.js' };
      results.push(cur);
      continue;
    }
    // 收集失败用例的根因（Error / Expected / Received / Locator 等）
    if (cur && cur.status === 'fail') {
      const t = line.trim();
      if (t && /^(Error|Expected|Received|Locator|Timeout|Call log|- |at )/.test(t) && !/^\d+ (passed|failed)/.test(t)) {
        cur.rootCause += t + ' ';
      }
    }
  }
  // 兜底：解析不出但退出码非 0 → 记为失败（如浏览器未安装）
  if (results.length === 0) {
    results.push({
      name: '前端 UI 冒烟（Playwright）',
      type: 'ui',
      status: code === 0 ? 'pass' : 'fail',
      severity: code === 0 ? '-' : 'high',
      rootCause: code === 0 ? '-' : 'UI 冒烟执行异常（详见日志/浏览器未安装）',
      repro: 'playwright test smoke/ui-smoke.spec.js',
      testFile: 'ui-smoke.spec.js',
    });
  }
  return results;
}

// 取一个当前空闲端口，避免多次运行间 SUT 服务端口冲突（曾导致 UI 测连到上次的残留服务）
function getFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

// 前端体验链路（可选）：仅当 sample-app 已安装 @playwright/test 时生效；否则优雅跳过，不阻塞后端闭环。
// 做法：在 worktree 起 SUT 服务（测试目标 ref 的真实前端）→ 用主仓库已装的 Playwright 驱动浏览器访问该服务。
// （ui-smoke.spec.js 仅做环境无关的浏览器操作，故复用主仓库副本即可，避免在每个 worktree 重复装浏览器。）
async function runUiSmoke(sutInWt) {
  // Windows 上 .bin/playwright 实为 .cmd 包装；直接 spawn 无扩展名会 ENOENT，需用平台正确路径
  const pwBase = path.join(repoDir, 'node_modules', '.bin', 'playwright');
  const pwBin = process.platform === 'win32' && fs.existsSync(pwBase + '.cmd') ? pwBase + '.cmd' : pwBase;
  const specFile = path.join(repoDir, 'smoke', 'ui-smoke.spec.js');
  const skip = (reason) => ([{
    name: '前端 UI 冒烟（Playwright）', type: 'ui', status: 'skip', severity: '-',
    rootCause: reason, repro: 'playwright test smoke/ui-smoke.spec.js', testFile: 'ui-smoke.spec.js',
  }]);
  if (!fs.existsSync(pwBin)) {
    return skip('环境未安装 @playwright/test（前端链路跳过）。在 sample-app 执行 `npm i -D playwright && npx playwright install chromium` 后生效。');
  }
  if (!fs.existsSync(specFile)) return skip('未找到 ui-smoke.spec.js');

  const port = await getFreePort();
  const base = `http://localhost:${port}`;
  const server = spawn('node', ['src/server.js'], { cwd: sutInWt, env: { ...process.env, PORT: String(port) }, windowsHide: true });
  let uiResults;
  try {
    // 等待 SUT 就绪
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`${base}/api/products`); if (r.ok) { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) {
      uiResults = [{ name: '前端 UI 冒烟（Playwright）', type: 'ui', status: 'fail', severity: 'high', rootCause: 'SUT 服务未能在 worktree 启动（前端链路无法验证）', repro: 'npm start', testFile: 'ui-smoke.spec.js' }];
    } else {
      // spec 路径统一转正斜杠：Playwright 把位置参数当正则过滤，反斜杠会被误判导致 "No tests found"
      const specArg = specFile.replace(/\\/g, '/');
      const pwArgs = ['test', specArg, '--reporter=line'];
      // Windows 用 cmd /c 数组式调用 .cmd（最稳，无 EINVAL）；其他平台直接执行二进制
      const out = process.platform === 'win32'
        ? await run(repoDir, 'cmd', ['/c', pwBin, ...pwArgs], { env: { ...process.env, SUT_URL: base } })
        : await run(repoDir, pwBin, pwArgs, { env: { ...process.env, SUT_URL: base } });
      uiResults = parsePlaywright(out.out, out.code);
    }
  } finally {
    try { server.kill(); } catch {}
  }
  return uiResults;
}

async function runInWorktree(targetRef, testFiles) {
  const wt = path.join(os.tmpdir(), `aio-${Date.now()}`);
  let testOut, smokeOut, uiOut = [];
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
    // 前端体验链路（可选）：失败或异常不影响后端闭环结果
    try {
      uiOut = await runUiSmoke(sutInWt);
    } catch (e) {
      uiOut = [{ name: '前端 UI 冒烟（Playwright）', type: 'ui', status: 'skip', severity: '-', rootCause: `UI 链路执行异常已忽略：${e.message}`, repro: 'playwright test smoke/ui-smoke.spec.js', testFile: 'ui-smoke.spec.js' }];
    }
  } finally {
    // 无论成功或失败都清理 worktree，避免 detached 分支/工作树残留污染仓库
    await git(repoDir, 'worktree', 'remove', '--force', wt).catch(() => {});
  }
  return { unit: parseNodeTest(testOut.out), api: parseApiSmoke(smokeOut.out), ui: uiOut };
}

// ---------- 3. 报告 ----------
function summarize(results) {
  // skip（如 Playwright 未装）不计入总数/通过率，避免污染统计，仅在结果表如实展示
  const effective = results.filter((r) => r.status !== 'skip');
  const pass = effective.filter((r) => r.status === 'pass').length;
  const fail = effective.filter((r) => r.status === 'fail').length;
  const blocking = fail > 0 ? ['存在失败用例，须修复并复测通过后方可合入/发布'] : [];
  return { total: effective.length, pass, fail, blocking };
}

// 场景 B：读需求/缺陷 fixture（离线版 TAPD），结构通用：
//   { id, title, source, affectedModules:[相对 repoDir 的源码路径], points:[{id,desc,module}] }
function readRequirement(p) {
  const raw = JSON.parse(readTextRobust(p));
  if (!raw.points || !Array.isArray(raw.points)) throw new Error('需求 fixture 缺少 points 数组');
  return raw;
}

// 场景 B：通用「实现核对」探针 —— 仅基于模块结构判断需求点是否真的有代码落地，
// 不读取/匹配任何业务关键词，对任意 repo 与需求 fixture 可复用（防过拟合）。
// 判定信号：模块是否存在、是否存在非桩的实质实现（函数/类/导出 + 足够代码行）。
function probeImplementation(repoDir, moduleRel) {
  const base = { exists: false, hasImpl: false, lines: 0, codeLines: 0 };
  if (!moduleRel) return { ...base, note: '未指定模块' };
  let src;
  try {
    src = fs.readFileSync(path.resolve(repoDir, moduleRel), 'utf8');
  } catch {
    return { ...base, note: '源码模块不存在' };
  }
  const lines = src.split('\n').length;
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
  }).length;
  // 通用「非桩」判定：存在函数/类/导出/赋值等实质实现结构（与具体业务名无关）
  const hasStructure = /(function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|class\s+\w+|=>\s*\{|export\s+(default\s+)?(function|class|const|let|var|\{)|\bmodule\.exports)/.test(src);
  const hasImpl = hasStructure && codeLines >= 3;
  return {
    exists: true,
    hasImpl,
    lines,
    codeLines,
    note: hasImpl ? '实现存在' : '模块存在但无实质实现（疑似桩）',
  };
}

// 场景 B：把需求点映射到「源码实现核对 + 测试执行结果」，产出「需求覆盖度」
//   status: pass（实现存在且测试通过）/ fail（实现有、测试有、但测试失败）
//           untested（实现存在但无对应测试）/ stub（模块在但疑似桩）/ missing（模块根本不存在）
//   可选 per-point 精确核对：point.tests 为「测试用例名子串」数组，命中则按这些用例的
//   真实结果判定，避免「同模块多需求点一损俱损」误报；未提供则回退通用模块级判定。
//   （tests 仅为名称子串，代码不写任何业务语义，对任意 repo/需求 fixture 通用。）
function computeCoverage(req, results, repoDir) {
  const failingFiles = new Set(results.filter((r) => r.status === 'fail' && r.testFile).map((r) => r.testFile));
  return req.points.map((pt) => {
    const tFiles = testsForModule(repoDir, pt.module).map((f) => path.basename(f));
    const impl = probeImplementation(repoDir, pt.module);
    let status, note;

    // 1) 优先：per-point 精确核对（point.tests 命中真实用例名）
    if (Array.isArray(pt.tests) && pt.tests.length) {
      const matched = results.filter((r) => pt.tests.some((p) => r.name && r.name.includes(p)));
      if (matched.length) {
        const failed = matched.filter((r) => r.status === 'fail');
        if (failed.length) {
          status = 'fail';
          note = `关联用例未通过（${failed.map((r) => r.name).join('、')}）`;
        } else {
          status = 'pass';
          note = `关联用例全部通过（${matched.length} 个）`;
        }
        return { id: pt.id, desc: pt.desc, module: pt.module, status, note, impl, tests: tFiles };
      }
      // 声明了 tests 但无用例命中 → 回退模块级
    }

    // 2) 通用模块级核对（兜底）
    if (!impl.exists) {
      status = 'missing';
      note = impl.note || '源码模块不存在';
    } else if (!impl.hasImpl) {
      status = 'stub';
      note = impl.note || '模块存在但疑似桩实现';
    } else if (tFiles.length === 0) {
      status = 'untested';
      note = '实现存在但无对应测试';
    } else if (tFiles.some((t) => failingFiles.has(t))) {
      status = 'fail';
      note = '模块测试未通过，实现可能不正确';
    } else {
      status = 'pass';
      note = '已实现且模块测试通过';
    }
    return { id: pt.id, desc: pt.desc, module: pt.module, status, note, impl, tests: tFiles };
  });
}

// 统一生成「AI 测试官过程时间线」，供 HTML 可视化（不依赖业务语义）
function buildProcess({ scenario, req, impact, sel, summary }) {
  const phases = [];
  if (scenario === 'B') {
    phases.push({ title: '① 读需求/缺陷', detail: `${req.id} · ${req.title}`, status: 'done' });
    phases.push({ title: '② 拆解测试点', detail: `${req.points.length} 个测试点 / 命中 ${impact.srcFiles.length} 个模块`, status: 'done' });
  } else {
    phases.push({ title: '① 理解变更', detail: impact.diffSource || `git diff ${base}..${target}`, status: 'done' });
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
    const { unit, api, ui } = await runInWorktree(target, sel.testFiles);
    const results = [...unit, ...api, ...ui];
    const coverage = computeCoverage(req, results, repoDir);
    const covered = coverage.filter((c) => c.status === 'pass').length;
    const gaps = coverage.filter((c) => ['missing', 'stub', 'untested'].includes(c.status)).length;
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
  const diffText = diffFile
    ? readTextRobust(path.resolve(ROOT, diffFile))
    : await git(repoDir, 'diff', `${base}..${target}`);
  console.log(`🔍 理解变更：${diffFile ? `(来自外部 diff 文件 ${diffFile})` : `${base}..${target}`}`);
  const impact = analyzeDiff(diffText);
  impact.diffSource = diffFile ? `MCP/外部 diff 文件：${diffFile}` : `git diff ${base}..${target}`;
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
  const { unit, api, ui } = await runInWorktree(target, sel.testFiles);
  const results = [...unit, ...api, ...ui];

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
