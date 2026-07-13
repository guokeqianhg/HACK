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
//   - 场景 A：TGit/工蜂真实 MR diff —— 引擎内置 fetchTGitMRDiff() 直连工蜂 REST API（--pr <iid> + TGIT_TOKEN 即拉真实改动），
//             也兼容宿主 MCP 取回后 --diff <file> 喂入；拉完回写 MR 评论（commentToPR）
//   - 场景 B：TAPD MCP 取需求/缺陷 → 整理为 fixture JSON → --requirement <file> 注入
//   - 闭环收口：pushToWeChat() 经企微机器人 webhook 把报告实时推送给值班/开发
//   （MCP 工具由驱动本 Agent 的 LLM 宿主调用；本脚本同时内置直连 REST/HTTP 的真实路径，即使宿主不编排 MCP，真闭环依旧成立）

import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectTests, isSourceFile, isTestFile, isRunnableTest, testsForModule, expandTests, listAllTests } from './select-tests.mjs';
import { isLLMEnabled, callLLM, extractJSON, loadEnv, chat, _llmStats, fastModel, hasFastModel } from './llm.mjs';
import { runAgent } from './agent.mjs';
import { makeOfficerTools } from './officer-tools.mjs';

// 启动时加载本地 .env（含 LLM 密钥）；未配置则整层 LLM 自动失效、回退确定性逻辑。
await loadEnv();

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
                                [--requirement <json|md>] [--diff <file>] [--story <TAPD需求ID>] [--bug <TAPD缺陷ID>] [--out <name>] [--triggeredBy <text>]
                                [--pr <MR合并请求IID>] [--pr-project <owner/repo>]
                                [--webhook <url>]

场景：
  A  代码改动驱动：diff 来源优先级 = 外部 --diff 文件 > 工蜂真实 MR diff（--pr + TGIT_TOKEN 直连 REST）> 本地 git diff
      → 精准选测 → 在目标分支真实跑测 → 结果回写 MR 评论（--pr）并推送企微（--webhook）
  B  需求驱动：读 requirement（本地 JSON/Markdown，或由 --story/--bug 直连 TAPD REST 拉取需求/缺陷）→ 需求覆盖度报告（默认 docs/requirement.md，回退 requirement-demo.json）
  C  持续巡检用：base==target 时为全量回归（实际由 cron-monitor 调用，异常经企微推送）

示例：
  node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
  node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A --diff report/.mcp-diff.txt
  node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A --pr 123 --pr-project owner/repo --webhook https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
  node agent/run-test-officer.mjs --repo sample-app --base main --target main --scenario B --requirement sample-app/docs/requirement.md
  node agent/run-test-officer.mjs --repo sample-app --base main --target main --scenario B --story 100123 --triggeredBy "TAPD 需求 #100123 自动读走"`);
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

// ---------- 1.5 AI 语义理解（LLM，可选；未配置则回退结构分析）----------
// 这一步让「理解变更」真正由大模型完成：读懂改动意图、判断哪里可能出问题、
// 可能影响哪些业务流程，并给出建议验证重点——弥补纯正则/导入图「读得浅、判断不深」的短板。
// 聚焦 diff 到被测仓库子树（去掉 agent/、README、.codebuddy 等与 SUT 无关的噪声），
// 避免超长 diff 让模型"读偏"导致语义理解失败。
function focusDiffToRepo(diffText, repoDir) {
  const marker = path.basename(repoDir) + '/';
  const blocks = diffText.split(/\ndiff --git /).map((b, i) => (i === 0 ? b : 'diff --git ' + b));
  const kept = blocks.filter((b) => b.includes(marker));
  const focused = kept.join('\n').slice(0, 5000);
  return focused || diffText.slice(0, 4000);
}

async function semanticAnalyze(diffText, structural) {
  if (!isLLMEnabled()) return null;
  const system = `你是一名资深测试架构师，服务于「AI 测试官」。请对下面的代码 diff 做语义级理解：真正读懂改动意图、判断哪里可能出问题、可能影响哪些业务流程，并给出建议验证重点。
请先逐步思考（你会在回复中看到自己的思考轨迹），再【只输出一个 JSON 对象】，不要任何额外文字，结构：
{
  "intent": "一句话说明改动意图",
  "riskLevel": "high|medium|low",
  "riskAreas": ["可能受影响的代码区域"],
  "businessFlows": ["可能受影响的业务流程"],
  "recommendedFocus": ["建议重点验证的测试场景"],
  "reasoning": "为什么这里可能出问题（2-4 句）"
}`;
  const user = `代码 diff（已聚焦到被测仓库）：\n${focusDiffToRepo(diffText, repoDir)}\n\n辅助结构分析（已由引擎提取）：\n${JSON.stringify({ changedFiles: structural.changedFiles, changedFunctions: structural.changedFunctions, scope: structural.scope })}`;
  try {
    const { content, reasoning } = await chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      maxTokens: 1200,
      model: fastModel(),
    });
    if (reasoning) console.log('   🧠 思考轨迹：' + reasoning.replace(/\s+/g, ' ').slice(0, 200));
    // 思维链模型有时会把最终 JSON 放在 reasoning 中：content 与 reasoning 都尝试解析
    const j = extractJSON(content) || extractJSON(reasoning);
    if (!j || !j.intent) return null;
    return j;
  } catch (e) {
    console.warn('⚠️ AI 语义分析失败，回退结构分析：', e.message);
    return null;
  }
}

// ---------- 2.5 AI 根因推理（单发 chat + 日志内联，可选；未配置则保留正则提取）----------
// 失败用例的 rootCause 不再只靠正则，而是由模型结合 diff 摘要 + 真实失败日志/堆栈做语义归因（"为什么挂"）。
// 不再走 ReAct 工具循环：失败日志引擎本就持有，直接内联进 prompt 即可，省去多轮 Act→Observe 的无效开销。

// （Agent 实时日志已不再需要：根因/生成改为单发 chat，去掉 ReAct 工具循环）

// 从首轮原始输出中抽取某个失败用例的完整日志片段（供 get_failure_log 工具使用）
function getFailureLogFromRaw(raw, name) {
  if (!raw) return '(无原始日志)';
  const lines = raw.split(/\r?\n/);
  const norm = (s) => s.replace(/（类型=[^）]*）/g, '').trim();
  let idx = lines.findIndex((l) => l.includes(name));
  if (idx < 0) idx = lines.findIndex((l) => l.includes(norm(name)));
  if (idx < 0) {
    // 退化：用用例名前缀做部分匹配（应对模型传入的命名微小差异）
    const base = norm(name).slice(0, 12);
    if (base) idx = lines.findIndex((l) => l.includes(base));
  }
  if (idx < 0) return `(未在原始日志中找到用例「${name}」)`;
  return lines.slice(Math.max(0, idx - 4), idx + 50).join('\n');
}

// 构建注入 Agent 的领域上下文（闭包捕获引擎状态，避免把执行权限交给模型造成失控）
function buildOfficerCtx({ repoDir, diffText, lastUnitRaw, sel }) {
  const readRepoFile = (rel) => {
    try {
      return fs.readFileSync(path.resolve(repoDir, rel), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    repoDir,
    getDiff: () => diffText,
    listTests: () => listAllTests(repoDir),
    getFailureLog: (name) => getFailureLogFromRaw(lastUnitRaw, name),
    expandScope: (files) => expandTests(repoDir, files, sel.testFiles).map((f) => path.relative(repoDir, f)),
    getModuleSource: (rel) => readRepoFile(rel),
    readTestFile: (rel) => readRepoFile(rel),
  };
}

async function llmRootCause(diffText, failures, ctx) {
  if (!isLLMEnabled() || !failures.length) return {};
  // 失败日志引擎本就持有（来自首轮 runInWorktree 的原始输出），直接内联，避免让模型再走工具循环去取
  const logs = failures.map((f) => {
    const log = ctx.getFailureLog(f.name);
    return `### ${f.name}\n类型=${f.type}\n现有线索=${String(f.rootCause).slice(0, 200)}\n日志/堆栈:\n${log.slice(0, 1200)}`;
  }).join('\n---\n');
  const system = `你是资深测试调试专家（AI 测试官·根因分析）。给定代码 diff 摘要与若干失败用例的真实日志/堆栈，请对每条失败用例做语义级根因分析（读懂"为什么挂"），只输出一个 JSON 对象：
{ "causes": { "用例名": "语义根因（含可能触发条件，2-3 句）" } }
无法判断的用例值为 "（无法判定，见原始日志）"。不要输出任何额外文字。`;
  const user = `代码改动摘要：\n${String(diffText).slice(0, 3000)}\n\n失败用例与日志：\n${logs}`;
  try {
    const { content, reasoning } = await chat({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
      maxTokens: 1500,
      model: fastModel(),
    });
    if (reasoning) console.log('   🧠 根因推理轨迹：' + reasoning.replace(/\s+/g, ' ').slice(0, 200));
    const j = extractJSON(content) || extractJSON(reasoning);
    return (j && j.causes) || {};
  } catch (e) {
    console.warn('⚠️ AI 根因分析失败，保留原始日志：', e.message);
    return {};
  }
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

async function runInWorktree(targetRef, testFiles, opts = {}) {
  const { skipUnit = false, skipApi = false, skipUi = false } = opts;
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
    if (!skipUnit) testOut = await run(sutInWt, 'node', ['--test', '--test-reporter=spec', ...runTests]);
    if (!skipApi) smokeOut = await run(sutInWt, 'node', ['smoke/api-smoke.mjs']);
    // 前端体验链路（可选）：失败或异常不影响后端闭环结果
    if (!skipUi) {
      try {
        uiOut = await runUiSmoke(sutInWt);
      } catch (e) {
        uiOut = [{ name: '前端 UI 冒烟（Playwright）', type: 'ui', status: 'skip', severity: '-', rootCause: `UI 链路执行异常已忽略：${e.message}`, repro: 'playwright test smoke/ui-smoke.spec.js', testFile: 'ui-smoke.spec.js' }];
      }
    }
  } finally {
    // 无论成功或失败都清理 worktree，避免 detached 分支/工作树残留污染仓库
    await git(repoDir, 'worktree', 'remove', '--force', wt).catch(() => {});
  }
  return {
    unit: skipUnit ? [] : parseNodeTest(testOut.out),
    api: skipApi ? [] : parseApiSmoke(smokeOut.out),
    ui: skipUi ? [] : uiOut,
    // 保留原始输出：供 AI 测试官 Agent 的 get_failure_log 工具抽取失败用例完整日志/堆栈
    raw: {
      unit: skipUnit ? '' : (testOut?.out || ''),
      api: skipApi ? '' : (smokeOut?.out || ''),
      ui: skipUi ? '' : JSON.stringify(uiOut, null, 2),
    },
  };
}

// ---------- 4. 自适应策略（P1）：首轮失败后，根据结果动态调整后续策略 ----------
// 不再是「固定流水线跑完即结束」：若首轮有失败，则①扩展选测（发现隐性影响面）②深度复跑确认（抓取完整根因）。
// 决策由确定性启发式给出（有失败就扩展选测 + 深度复跑，永远安全、零风险）；仅当配置了独立「快模型」时，
// 额外用其补一句决策旁白（判定类轻任务），推理模型不为一段旁白白花 23s。
async function adaptiveDecision(failing) {
  const decision = heuristicAdaptiveDecision(failing);
  if (isLLMEnabled() && hasFastModel()) {
    try {
      const { content } = await chat({
        messages: [
          { role: 'system', content: '你是「AI 测试官」的测试策略指挥官。首轮测试出现失败，请用一句话说明后续自适应动作的理由（扩展选测以发现隐性影响面、深度复跑确认可复现）。只输出一句话，不要 JSON、不要解释。' },
          { role: 'user', content: `失败用例（${failing.length} 个）：${failing.map((f) => f.name).join('、')}` },
        ],
        temperature: 0.2,
        maxTokens: 200,
        model: fastModel(),
      });
      const r = (content || '').trim();
      if (r) decision.rationale = r;
    } catch {
      /* 旁白失败不影响决策 */
    }
  }
  return decision;
}

function heuristicAdaptiveDecision(failing) {
  const hasUnit = failing.some((f) => f.type === 'unit');
  const hasApiUi = failing.some((f) => f.type === 'api' || f.type === 'ui');
  return {
    expandScope: hasUnit,
    deepDive: hasUnit || hasApiUi,
    rationale: '启发式：存在失败用例即触发扩展选测与深度复跑（离线模式）',
  };
}

function resolveTestFile(repoDir, basename) {
  if (!basename) return null;
  const g = globSync(path.join(repoDir, 'tests', basename));
  return g[0] || null;
}

// 执行自适应动作：返回 { decision, actions, extraResults, expandedTests }
async function runAdaptive({ decision, failing, target, repoDir, originalRun }) {
  const actions = [];
  const extraResults = [];
  const expandedTests = [];
  const failUnitFiles = [...new Set(failing.filter((f) => f.type === 'unit' && f.testFile).map((f) => resolveTestFile(repoDir, f.testFile)).filter(Boolean))];

  // 待跑集合：扩展选测发现的 + 需深度复跑的失败单测
  const expandSet = decision.expandScope ? expandTests(repoDir, failUnitFiles, originalRun) : [];

  // 动作1：扩展选测（发现隐性影响面）—— 跑的是首轮未覆盖的新测试，结果全部计入 extraResults
  if (expandSet.length) {
    expandedTests.push(...expandSet.map((f) => path.relative(repoDir, f)));
    actions.push(`扩展选测 ${expandSet.length} 个隐性关联测试（${expandedTests.join(', ')}）`);
    const { unit } = await runInWorktree(target, expandSet, { skipApi: true, skipUi: true });
    extraResults.push(...unit);
  }

  // 动作2：深度复跑失败单测（仅确认可复现 + 抓完整根因，不新增结果，避免与首轮重复）
  if (decision.deepDive && failUnitFiles.length) {
    actions.push(`深度复跑 ${failUnitFiles.length} 个失败单测以确认可复现并抓取完整根因`);
    const { unit } = await runInWorktree(target, failUnitFiles, { skipApi: true, skipUi: true });
    for (const r of unit) {
      const o = failing.find((x) => x.name === r.name);
      if (o) {
        if (r.status === 'fail' && r.rootCause && r.rootCause !== '-') o.rootCause = r.rootCause;
        o.reproConfirmed = true;
      }
    }
  }

  // 深度复跑 API/UI 链路（确认非单测类失败可复现并抓全日志）。无论是否有单测失败都执行，
  // 因为上面的 unit 组合跑已 skip 了 api/ui。
  if (decision.deepDive && failing.some((f) => f.type === 'api' || f.type === 'ui')) {
    const { api, ui } = await runInWorktree(target, [], { skipUnit: true });
    for (const r of [...api, ...ui]) {
      const o = failing.find((x) => x.name === r.name);
      if (o && r.status === 'fail' && r.rootCause && r.rootCause !== '-') o.rootCause = r.rootCause;
      if (o) o.reproConfirmed = true;
    }
    actions.push('复跑 API/UI 链路确认失败并抓取完整日志');
  }

  if (!actions.length) actions.push('失败用例已记录，无需额外自适应动作');
  return { decision, actions, extraResults, expandedTests };
}

// ---------- 5. 测试生成 Agent（P2 · 根因暴露盲区时自动补写回归测试）----------
// 设计（自洽、防幻觉）：LLM 只负责"读懂失败 + 写对 import + 断言正确行为"，
// 真实运行与判定由引擎在 worktree 中完成；若生成测试在缺陷分支竟然通过（说明断言了缺陷行为）
// 或运行报错，则把错误回灌给模型修复（最多 3 轮）。最终只保留"在缺陷分支失败=能抓住 bug"的测试。
// 这样生成的测试是真实可运行的回归守卫，而非 demo 摆设。

// 由失败单测反推其被测模块（同 stem 或 import 中指向 ../src）
function moduleUnderTest(repoDir, testFileAbs) {
  if (!testFileAbs) return null;
  const b = path.basename(testFileAbs).replace(/\.(test|spec)\.[mc]?js$/, '').replace(/(^|[-_])test$/, '');
  for (const c of [path.join(repoDir, 'src', b + '.js'), path.join(repoDir, 'src', b + '.mjs')]) {
    try { if (fs.statSync(c).isFile()) return path.relative(repoDir, c); } catch {}
  }
  try {
    const src = fs.readFileSync(testFileAbs, 'utf8');
    const m = src.match(/from\s+['"]\.\.\/(src\/[^'"]+)['"]/);
    if (m && fs.existsSync(path.resolve(repoDir, m[1]))) return m[1];
  } catch {}
  return null;
}

// 在 worktree 中落盘生成测试并真实运行，返回 pass/fail/error
async function runGeneratedTest(targetRef, relTestPath, content) {
  const wt = path.join(os.tmpdir(), `aio-gen-${Date.now()}`);
  try {
    await git(repoDir, 'worktree', 'add', '--detach', wt, targetRef);
    const sutInWt = path.join(wt, path.relative(ROOT, repoDir));
    const abs = path.join(sutInWt, relTestPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const res = await run(sutInWt, 'node', ['--test', '--test-reporter=spec', abs]);
    const parsed = parseNodeTest(res.out);
    const hasFail = parsed.some((r) => r.status === 'fail');
    const hasPass = parsed.some((r) => r.status === 'pass');
    return { status: hasFail ? 'fail' : hasPass || parsed.length ? 'pass' : 'error', out: res.out };
  } catch (e) {
    return { status: 'error', out: e.message };
  } finally {
    await git(repoDir, 'worktree', 'remove', '--force', wt).catch(() => {});
  }
}

async function fixGen(system, prevAnswer, feedback) {
  const { content } = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: '（上一轮产出）\n' + prevAnswer },
      { role: 'user', content: '❌ 反馈：' + feedback + '\n\n请重新只输出修正后的 JSON 对象（fileName/content/targetModule/asserts）。' },
    ],
    temperature: 0.2,
    maxTokens: 2000,
    model: fastModel(),
  });
  return content;
}

// ---------- 5. 测试生成 Agent（P2 · 根因暴露盲区时自动补写回归测试）----------
// 设计（自洽、防幻觉）：LLM 只负责"读懂失败 + 写对 import + 断言正确行为"，
// 真实运行与判定由引擎在 worktree 中完成；若生成测试在缺陷分支竟然通过（说明断言了缺陷行为）
// 或运行报错，则把错误回灌给模型修复（最多 1 轮）。最终只保留"在缺陷分支失败=能抓住 bug"的测试。
// 关键提速：失败日志/被测源码/同目录测试 引擎本就持有，直接内联进 prompt（不再走 ReAct 工具循环）；
// 多个候选用例并行生成（Promise.all），每个仅 1 次草稿 + 最多 1 次修复。
async function generateRegressionTests({ target, failing, ctx }) {
  const out = [];
  if (!isLLMEnabled() || !failing.length) return out;
  const candidates = failing.filter((f) => f.type === 'unit' && f.testFile).slice(0, 2);
  if (!candidates.length) return out;

  const jobs = candidates.map(async (f) => {
    const moduleRel = moduleUnderTest(repoDir, path.resolve(repoDir, 'tests', f.testFile));
    const moduleSrc = moduleRel ? ctx.getModuleSource(moduleRel) : '';
    const testSrc = ctx.readTestFile(path.join('tests', f.testFile));
    const system = `你是「AI 测试官」的测试生成 Agent。给定一条失败用例、其真实日志、被测模块源码、以及同目录已有测试的风格，请生成一个【新的回归测试文件】（node:test 形式），用于把"正确预期行为"锁死。
要求：
- 必须 import 被测模块的真实导出（见下方「被测模块源码」确认导出名与签名），再做断言。
- 断言【正确预期】而非缺陷行为：该测试在【当前缺陷分支】应当失败（证明它能抓住这个 bug），在修复后应通过。
- 参考「同目录已有测试」的风格。
- 只输出一个 JSON 对象：{"fileName": "generated-<简短slug>.test.js", "targetModule": "src/xxx.js", "asserts": "一句话说明它锁定的正确行为", "content": "完整可运行的测试文件源码（含 import 与 node:test 的 test()）"}。`;
    const user = `失败用例：${f.name}
已有线索（rootCause）：${String(f.rootCause).slice(0, 400)}
被测模块（推测）：${moduleRel || '未知'}
失败日志/堆栈：
${ctx.getFailureLog(f.name).slice(0, 1500)}
${moduleRel && moduleSrc ? `\n被测模块源码（${moduleRel}）：\n${moduleSrc.slice(0, 3000)}` : ''}
${testSrc ? `\n同目录已有测试（${f.testFile}）参考：\n${testSrc.slice(0, 2000)}` : ''}
请只输出上述 JSON。`;

    let last;
    try {
      const r = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2, maxTokens: 2000, model: fastModel() });
      last = r.content;
      if (r.reasoning) console.log('   🧠 测试生成推理：' + r.reasoning.replace(/\s+/g, ' ').slice(0, 160));
    } catch (e) {
      return { name: f.name, status: 'error', note: '生成调用失败：' + e.message };
    }

    let result = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const gen = extractJSON(last) || {};
      const content = gen.content;
      const fileName = (gen.fileName || `generated-${String(f.name).slice(0, 20).replace(/\W+/g, '-')}.test.js`).replace(/"/g, '');
      if (!content || !/node:test|import/.test(content)) {
        last = await fixGen(system, last, '生成的 JSON 缺少可用的 content（测试源码），或没有 import node:test，请补全一个完整可运行的测试文件源码。');
        continue;
      }
      const runRes = await runGeneratedTest(target, path.join('tests', fileName), content);
      if (runRes.status === 'fail') {
        // 验证通过：在缺陷分支确实失败（能抓住 bug）→ 落盘为仓库内真实可复跑的回归守卫
        fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
        const dest = path.join(repoDir, 'tests', fileName);
        fs.writeFileSync(dest, content, 'utf8');
        result = { name: f.name, fileName, targetModule: gen.targetModule || moduleRel || '', asserts: gen.asserts || '', status: 'reproduced', content, path: path.relative(repoDir, dest) };
        console.log(`   🧪 生成回归测试 ${fileName}：缺陷分支失败 ✓（已写入 ${path.relative(ROOT, dest)} 作为回归守卫）`);
      } else if (runRes.status === 'pass') {
        last = await fixGen(system, last, `生成的测试在【缺陷分支】竟然通过了，说明它在断言缺陷行为而不是正确行为。请改为断言【正确预期】，使其在缺陷分支应当失败（作为回归守卫）。运行输出：\n${runRes.out.slice(0, 1000)}`);
      } else {
        last = await fixGen(system, last, `测试运行出错（语法/导入/路径问题），请修正使其可在 node --test 下运行：\n${runRes.out.slice(0, 1400)}`);
      }
    }
    return result || { name: f.name, status: 'error', note: '修复后仍无法生成可运行且能复现 bug 的测试' };
  });

  return Promise.all(jobs);
}

// ---------- 6. 场景 B AI 覆盖度语义判定（P2 · 防幻觉的"事实由引擎测、语义由 LLM 判"）----------
// 关键设计：模块是否存在、测试是否运行、结果如何——这些事实全部由引擎实测并作为证据喂给 LLM；
// LLM 只做"语义判断"：给定测试是否真的验证了需求点意图（testAdequacy）。
// 确定性 status 仍是权威徽章；LLM 的 verdict 仅在一致时强化，不一致时作为"AI 提示"并列展示，绝不臆造事实。
function gatherCoverageEvidence(req, results, repoDir) {
  return req.points.map((pt) => {
    const impl = probeImplementation(repoDir, pt.module);
    const tFiles = testsForModule(repoDir, pt.module).map((f) => path.basename(f));
    const tResults = results.filter((r) => tFiles.includes(r.testFile));
    // 只给"事实证据"：模块是否存在/是否桩、关联测试的实测结果与状态。
    // 不给大段源码（避免触发模型长链思维耗光 token 而吐不出 JSON；充分性判断靠测试名+状态+需求描述即可，且避免过拟合）。
    return {
      id: pt.id,
      desc: pt.desc,
      module: pt.module,
      impl: { exists: impl.exists, hasImpl: impl.hasImpl, codeLines: impl.codeLines },
      testResults: tResults.map((r) => ({ name: r.name, status: r.status })),
    };
  });
}

async function llmCoverageJudge(evidence) {
  if (!isLLMEnabled() || !evidence.length) return null;
  // 注意：该推理模型会把大量 token 花在链思维上，必须把提示压到"只输出 JSON"，否则会吐不出 JSON。
  const system = `你是测试覆盖度语义评审。输入是若干"需求点 + 引擎实测证据（模块是否存在、是否疑似桩、关联测试实测结果与状态）"。
规则：
- verdict 必须与证据严格一致：模块不存在→missing；模块疑似桩→stub；关联测试有失败→fail；有实现但无关联测试→untested；有关联测试且全通过→pass。
- testAdequacy：strong（测试名/结果表明确实验证了该需求点意图）/ weak（仅浅层验证或无法确认）/ none。
- reasoning：每点 1 句话依据；gap：若 verdict≠pass 或 testAdequacy≠strong 则给缺口，否则空串。
禁止任何分析文字，直接输出 JSON 数组，格式：[{"pointId":"P1","verdict":"pass","testAdequacy":"strong","confidence":"high|medium|low","reasoning":"...","gap":""}]`;
  const user = JSON.stringify(evidence);
  try {
    const { content, reasoning } = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2, maxTokens: 6000, model: fastModel() });
    if (reasoning) console.log('   🧠 覆盖度判定：' + reasoning.replace(/\s+/g, ' ').slice(0, 160));
    const arr = extractJSON(content) || extractJSON(reasoning);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    console.warn('⚠️ AI 覆盖度判定失败，沿用确定性结果：', e.message);
    return null;
  }
}

async function llmRequirementAudit(reqText, points) {
  if (!isLLMEnabled()) return null;
  const system = `你是需求拆解审计。给定需求文档文本与已结构化解析出的"测试点"列表，请：
1. 列出该需求隐含的、应当被测试的能力点（impliedCapabilities）。
2. 对比已解析测试点，指出文档提到但测试点未覆盖的能力（missingFromPoints）。
禁止任何分析文字，直接输出 JSON：{"impliedCapabilities":["..."],"missingFromPoints":[{"desc":"未覆盖能力","why":"为何重要"}]}`;
  const user = `需求文档：\n${reqText}\n\n已解析测试点：\n${points.map((p) => `${p.id}: ${p.desc}（模块：${p.module || '未指定'}）`).join('\n')}`;
  try {
    const { content, reasoning } = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2, maxTokens: 2000, model: fastModel() });
    const j = extractJSON(content) || extractJSON(reasoning);
    return j && Array.isArray(j.impliedCapabilities) ? j : null;
  } catch (e) {
    console.warn('⚠️ AI 需求审计失败：', e.message);
    return null;
  }
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

// 场景 B：读需求/缺陷（离线版 TAPD / TAPD MCP 取回 / 手写 Markdown），结构通用：
//   JSON: { id, title, source, affectedModules:[相对 repoDir 的源码路径], points:[{id,desc,module,tests?}] }
//   MD  : 通用约定格式（见 parseMarkdownRequirement），引擎统一规约为上述结构
// 不读取/匹配任何业务关键词，对任意 repo 与需求输入可复用（防过拟合）。
function readRequirement(p) {
  const isMd = /\.md$/i.test(p);
  const raw = isMd ? parseMarkdownRequirement(readTextRobust(p)) : JSON.parse(readTextRobust(p));
  if (!raw.points || !Array.isArray(raw.points) || !raw.points.length) {
    throw new Error(`需求文件（${p}）未解析出任何测试点（points）`);
  }
  return raw;
}

// 场景 B：从 Markdown 需求解析出覆盖度 fixture 结构。
// 通用约定（对任意 repo 适用：仅用「模块路径 + 用例名子串」，不含业务语义）：
//   # 需求标题
//   需求ID: <id>
//   ## 模块：src/xxx.js            ← 后续测试点归属的源码模块（相对 repoDir）
//   ### 测试点 P1：描述
//   关联用例：用例名子串1, 用例名子串2   ← 可选，做 per-point 精确核对
// 兜底：若全文无「测试点」结构化块，则按「## 小节」生成测试点（模块未知，仅做存在性展示）。
function parseMarkdownRequirement(md) {
  // 归一化：去 BOM/回车（CRLF 会让 '$' 整行匹配失效）、全角冒号→半角、全角空格→普通空格，
  // 避免不同编辑器/平台写入差异导致解析失败
  const norm = (s) => s.replace(/^﻿/, '').replace(/\r/g, '').replace(/：/g, ':').replace(/；/g, ';').replace(/　/g, ' ');
  const lines = md.split('\n').map(norm).filter((l) => l.length);
  let id = 'REQ-MD';
  let title = '';
  const moduleSet = new Set();
  const affectedModules = [];
  const pushModule = (m) => { if (m && !moduleSet.has(m)) { moduleSet.add(m); affectedModules.push(m); } };
  // 全文档扫描路径线索（模块行 / 反引号 / 普通路径），作为受影响模块
  for (const l of lines) {
    for (const m of l.matchAll(/(?:^|[\s`(])((?:src\/)?[\w.\/-]+\.(?:js|ts|tsx|jsx))/g)) pushModule(m[1]);
  }

  const points = [];
  let curModule = '';
  let seq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { if (!title) title = h1[1].trim(); continue; }
    // id：兼容「需求ID / 需求编号 / ID / Requirement」+ 冒号（已归一化为半角）
    const idLine = line.match(/^(?:需求\s*ID|需求编号|ID|Requirement)\s*[:：]\s*(\S+)/i);
    if (idLine) { id = idLine[1].trim(); continue; }
    // 模块行：## 后跟一个源码路径（兼容「模块：」前缀或无前缀）
    const modLine = line.match(/^##\s*(?:模块\s*[:：]\s*)?((?:src\/)?[\w.\/-]+\.(?:js|ts|tsx|jsx))\s*$/i);
    if (modLine) { curModule = modLine[1].trim(); pushModule(curModule); continue; }
    // 测试点：### 后含「测试点」+ 编号（如 P1）；编号用 [^\s：:] 避免整段中文被吞
    const pt = line.match(/^###\s*测试点\s+([^\s：:]+)\s*[:：]?\s*(.*)$/);
    if (pt) {
      const pid = pt[1].trim() || `P${++seq}`;
      let desc = pt[2].trim();
      const tests = [];
      for (let j = i + 1; j < lines.length; j++) {
        const tl = lines[j];
        if (/^#{1,3}\s/.test(tl)) break; // 遇到下个标题即停止收集
        const tm = tl.match(/关联\s*用例\s*[:：]\s*(.+)/);
        if (tm) tm[1].split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean).forEach((t) => tests.push(t));
      }
      if (!desc && tests.length === 0 && lines[i + 1]) desc = lines[i + 1].trim();
      points.push({ id: pid, desc: desc || pid, module: curModule, tests });
      continue;
    }
  }

  // 兜底：无任何结构化「测试点」时，先按 ## 小节标题生成点（模块未知）；
  // 若连 ## 小节都没有（如 TAPD 自由文本需求），则用一个兜底点（标题本身），
  // 保证任意输入都能产出至少 1 个测试点，不会因解析失败中断场景 B。
  if (points.length === 0) {
    for (const l of lines) {
      const h = l.match(/^##\s+(.+)$/);
      if (h) points.push({ id: `P${++seq}`, desc: h[1].trim(), module: '', tests: [] });
    }
  }
  if (points.length === 0) {
    points.push({ id: 'P1', desc: title || id, module: '', tests: [] });
  }
  if (!points.length) throw new Error('Markdown 需求未解析出任何测试点');
  return { id, title: title || id, source: 'Markdown', affectedModules, points };
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
function buildProcess({ scenario, req, impact, sel, summary, adaptive, generatedTests = [] }) {
  const phases = [];
  if (scenario === 'B') {
    phases.push({ title: '① 读需求/缺陷', detail: `${req.id} · ${req.title}`, status: 'done' });
    phases.push({ title: '② 拆解测试点', detail: `${req.points.length} 个测试点 / 命中 ${impact.srcFiles.length} 个模块`, status: 'done' });
    if (impact.aiCoverage) phases.push({ title: '③ AI 覆盖度语义判定', detail: '引擎实测证据 + LLM 语义评审（含测试充分性）', status: 'done' });
  } else {
    const u = impact.llmUnderstand;
    phases.push({
      title: u ? '① 理解变更（AI 语义分析）' : '① 理解变更',
      detail: u
        ? `${u.intent}（风险 ${u.riskLevel}）`
        : (impact.diffSource || `git diff ${base}..${target}`),
      status: 'done',
    });
    const impactDetail = u && Array.isArray(u.businessFlows) && u.businessFlows.length
      ? `${impact.changedFiles.join(', ') || '（无改动）'} ｜ AI 提示影响：${u.businessFlows.join('、')}`
      : (impact.changedFiles.join(', ') || '（无改动）');
    phases.push({ title: '② 影响面分析', detail: impactDetail, status: 'done' });
  }
  if (impact && impact.reactPlan) {
    const rp = impact.reactPlan;
    const extra = (rp.addedTests?.length ? `补选 ${rp.addedTests.length} 个` : '') + (rp.blindSpots?.length ? ` ｜ 盲区 ${rp.blindSpots.length} 处` : '');
    phases.push({
      title: '②→ ReAct 整体规划',
      detail: `核心风险：${rp.focus || '—'}${extra ? ' ｜ ' + extra : ''}`,
      status: 'done',
    });
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
  // 自适应策略（P1）：首轮出现失败时动态扩展选测 / 深度复跑，体现「根据中间结果调整策略」
  if (adaptive && adaptive.actions && adaptive.actions.length) {
    const detail = `决策：${adaptive.decision?.rationale || ''} ｜ ${adaptive.actions.join('；')}`;
    phases.push({ title: '⑤ 自适应策略（失败驱动）', detail, status: 'done' });
  }
  if (generatedTests && generatedTests.length) {
    const ok = generatedTests.filter((g) => g.status === 'reproduced').length;
    phases.push({ title: '⑦ AI 生成回归测试', detail: `${generatedTests.length} 个候选 / ${ok} 个在缺陷分支可复现 bug`, status: 'done' });
  }
  phases.push({ title: '⑥ 生成可决策报告', detail: 'report/index.html', status: 'done' });
  return phases;
}

// ---------- ReAct 整体规划（问题3）：用真正的 Agent 循环自主规划"测什么/顺序/是否含 UI" ----------
// 与确定性 selectTests 的关系：selectTests 给出"结构可达"的候选集（导入图/同名），
// ReAct Agent 则从"改动语义 + 业务风险"出发，判断这些候选里【哪些最该先测、是否要含 UI、有无遗漏】，
// 产出一份"测试计划"，其建议的测试文件与结构选测取并集。自主性从"局部决策"升级为"整体策略规划"。
async function planWithReActAgent({ repoDir, diffText, impact, sel, officerCtx }) {
  if (!isLLMEnabled() || !hasFastModel()) return null;

  const tools = makeOfficerTools({ ...officerCtx, repoDir });
  const system = `你是「AI 测试官」的首席规划 Agent。你的职责不是执行测试，而是【规划测试策略】。
你会拿到一次代码改动，需要通过工具观察"改了什么、有哪些可运行测试"，然后自主决定：
  1. 本次改动最该优先验证的核心风险点是什么；
  2. 从现有测试文件中，挑选出必须运行的子集（给相对路径）；
  3. 是否需要包含前端 UI 冒烟（ui 类）与 API 冒烟；
  4. 有无"改动涉及但现有测试未覆盖"的隐性盲区。

规则：
- 必须先调用 get_diff 与 list_test_files 观察事实，再下结论，不要凭空臆测。
- 最终答复用 JSON（且只输出 JSON），结构：
  {"focus":"一句话核心风险","mustRunTests":["tests/xxx.test.js", ...],"includeUi":true|false,"includeApi":true|false,"blindSpots":["..."],"rationale":"为何这样规划"}
- mustRunTests 只能来自 list_test_files 返回的真实相对路径。`;

  const task = `本次改动文件：${impact.changedFiles.join(', ') || '(无)'}
改动函数（结构分析）：${impact.changedFunctions.join(', ') || '(无)'}
结构选测已给出候选：${sel.testFiles.map((f) => path.relative(repoDir, f)).join(', ') || '(无)'}
请先用工具观察真实 diff 与全部可运行测试，再给出你的测试计划（JSON）。`;

  let plan = null;
  const trace = [];
  try {
    const res = await runAgent({
      system,
      task,
      tools,
      maxSteps: 6,
      model: fastModel(),
      temperature: 0,
      maxTokens: 1200,
      onStep: (s) => {
        if (s.type === 'reason') trace.push({ kind: 'think', text: String(s.text).slice(0, 400) });
        else if (s.type === 'action') trace.push({ kind: 'act', tool: s.tool, args: s.args });
        else if (s.type === 'answer') trace.push({ kind: 'answer', text: String(s.text).slice(0, 400) });
      },
    });
    plan = extractJSON(res.answer);
    if (plan) plan._trace = trace;
  } catch {
    return null;
  }
  if (!plan || typeof plan !== 'object') return null;

  // 把 Agent 建议的测试文件解析成 repoDir 下的绝对路径，仅收真实存在且 node 可跑的（避免把 .spec.js 错塞给 node --test）
  const suggestedAbs = [];
  for (const rel of Array.isArray(plan.mustRunTests) ? plan.mustRunTests : []) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(repoDir, rel);
    if (fs.existsSync(abs) && isRunnableTest(abs)) suggestedAbs.push(abs);
  }
  // 与结构选测取并集（去重）
  const merged = Array.from(new Set([...sel.testFiles, ...suggestedAbs]));
  const added = merged.filter((f) => !sel.testFiles.includes(f)).map((f) => path.relative(repoDir, f));
  plan._addedTests = added;
  plan._mergedTests = merged;
  return plan;
}

// ---------- PR/MR 自动回写闭环（问题2）：跑完 → 在工蜂(TGit) MR 下评论测试结果 ----------
// 有 TGIT_TOKEN + --pr <iid> 时经工蜂 REST API 真实回写；否则优雅降级为写 report/pr-comment.md（dry-run），
// 与现有 webhook 风格一致，保证离线 Demo 不受影响。
function buildPRComment({ report, reportUrl }) {
  const s = report.summary;
  const passRate = s.total ? Math.round((s.pass / s.total) * 100) : 0;
  const icon = s.fail > 0 ? '🔴' : '🟢';
  const lines = [];
  lines.push(`## ${icon} AI 测试官 · 自动化验证报告`);
  lines.push('');
  lines.push(`**结论**：通过 ${s.pass} / 失败 ${s.fail}（通过率 ${passRate}%）`);
  if (report.impact?.llmUnderstand) {
    const u = report.impact.llmUnderstand;
    lines.push(`**AI 语义理解**：意图=${u.intent} ｜ 风险=${u.riskLevel}`);
  }
  const failed = (report.results || []).filter((r) => r.status === 'fail');
  if (failed.length) {
    lines.push('');
    lines.push('**失败用例与根因：**');
    for (const r of failed.slice(0, 8)) {
      lines.push(`- \`${r.name}\`：${String(r.rootCause || r.message || '').slice(0, 160)}`);
    }
  }
  const repro = (report.generatedTests || []).filter((g) => g.status === 'reproduced');
  if (repro.length) {
    lines.push('');
    lines.push(`**AI 生成回归测试**：${repro.length} 个已在缺陷分支复现 bug，已作为回归守卫写入（点击文件名跳转仓库查看）：`);
    for (const g of repro) {
      const rel = String(g.path || g.fileName || '').replace(/\\/g, '/');
      lines.push(`- [\`${g.name}\`](${rel}) → 回归守卫 \`${rel}\``);
    }
  }
  if (reportUrl) {
    lines.push('');
    lines.push(`📊 完整报告：${reportUrl}`);
  }
  lines.push('');
  lines.push('_由 AI 测试官自动生成_');
  return lines.join('\n');
}

// 定位工蜂项目：优先 --pr-project owner/repo，否则从 git remote.origin.url 推断（供 diff 拉取与 MR 评论复用）
function resolveTGitProject() {
  let project = args['pr-project'];
  if (!project || project === true) {
    try {
      const remote = execSync('git config --get remote.origin.url', { cwd: repoDir }).toString().trim();
      const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
      if (m) project = m[1];
    } catch {}
  }
  return project || '';
}

// 经工蜂 REST API 拉取真实 MR 改动（MCP gongfeng 的真实落地点：脚本直连，不依赖宿主编排）。
// changes 接口按文件返回 diff，拼接为统一 diff 文本供 analyzeDiff 解析；失败抛错交由调用方回退。
async function fetchTGitMRDiff({ project, iid, token, apiBase }) {
  const encProj = encodeURIComponent(project);
  const url = `${apiBase}/projects/${encProj}/merge_requests/${iid}/changes`;
  const resp = await fetch(url, { headers: { 'PRIVATE-TOKEN': token } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  const changes = Array.isArray(data.changes) ? data.changes : [];
  const text = changes.map((c) => c.diff || '').filter(Boolean).join('\n');
  if (!text.trim()) throw new Error('MR 无 diff 内容');
  return text;
}

// 经 TAPD REST API 直连拉取需求/缺陷（MCP tapd 的真实落地点：脚本直连，不依赖宿主编排）。
// 与 fetchTGitMRDiff 同构：成功则规约为 requirement fixture（Markdown）并落盘，交由场景 B 消费；失败抛错交由调用方回退本地文件。
// 鉴权：TAPD Open API 使用 HTTP Basic（api_user:api_password 经 base64）。
const TAPD_API_BASE = process.env.TAPD_API_BASE || 'https://api.tapd.cn';
function tapdAuthHeader() {
  const u = process.env.TAPD_API_USER || '';
  const p = process.env.TAPD_API_PASSWORD || '';
  if (!u || !p) return null;
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}
// 简单清洗 TAPD 富文本描述（去 HTML 标签/多余空白），保证规约后的 Markdown 可解析（防过拟合：只用通用路径/标题解析）
function stripHtmlLight(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
// 把 TAPD 需求/缺陷规约为 Markdown 需求（复用 parseMarkdownRequirement，对任意输入通用）
function tapdToMarkdown({ kind, id, name, description }) {
  const title = name || (kind === 'bug' ? `缺陷 #${id}` : `需求 #${id}`);
  const body = stripHtmlLight(description);
  return `# ${title}\n需求ID: ${kind === 'bug' ? 'BUG' : 'STORY'}-${id}\n\n${body}\n`;
}
async function fetchTAPDStory({ storyId, workspaceId, apiBase = TAPD_API_BASE }) {
  const auth = tapdAuthHeader();
  if (!auth) throw new Error('未配置 TAPD_API_USER / TAPD_API_PASSWORD');
  const url = `${apiBase}/stories?workspace_id=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(storyId)}`;
  const resp = await fetch(url, { headers: { Authorization: auth } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  const arr = Array.isArray(data?.data) ? data.data : [];
  const story = arr[0]?.Story || arr[0]?.story || arr[0];
  if (!story || !story.id) throw new Error('TAPD 未返回该需求');
  return tapdToMarkdown({ kind: 'story', id: story.id, name: story.name, description: story.description });
}
async function fetchTAPDBug({ bugId, workspaceId, apiBase = TAPD_API_BASE }) {
  const auth = tapdAuthHeader();
  if (!auth) throw new Error('未配置 TAPD_API_USER / TAPD_API_PASSWORD');
  const url = `${apiBase}/bugs?workspace_id=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(bugId)}`;
  const resp = await fetch(url, { headers: { Authorization: auth } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  const arr = Array.isArray(data?.data) ? data.data : [];
  const bug = arr[0]?.Bug || arr[0]?.bug || arr[0];
  if (!bug || !bug.id) throw new Error('TAPD 未返回该缺陷');
  return tapdToMarkdown({ kind: 'bug', id: bug.id, name: bug.title || bug.name, description: bug.description });
}

async function commentToPR({ report }) {
  const prIid = args.pr;
  if (!prIid || prIid === true) return; // 未指定 --pr 则不启用 PR 回写
  const body = buildPRComment({ report, reportUrl: 'report/index.html' });
  const token = process.env.TGIT_TOKEN || process.env.GIT_TOKEN || '';
  const project = resolveTGitProject();
  const apiBase = process.env.TGIT_API_BASE || 'https://git.woa.com/api/v3';
  if (!token || !project) {
    // 优雅降级：写本地 dry-run 评论文件，Demo 可展示"闭环意图"且不依赖网络/凭据
    const out = path.join(ROOT, 'report', 'pr-comment.md');
    fs.writeFileSync(out, body, 'utf8');
    console.log(`💬 PR 回写（dry-run，未配置 TGIT_TOKEN/项目）：已写 ${out}`);
    return;
  }

  try {
    const encProj = encodeURIComponent(project);
    const url = `${apiBase}/projects/${encProj}/merge_requests/${prIid}/notes`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
      body: JSON.stringify({ body }),
    });
    if (resp.ok) {
      console.log(`💬 PR 回写成功：已在 ${project} !${prIid} 评论测试结果`);
    } else {
      const t = await resp.text().catch(() => '');
      const out = path.join(ROOT, 'report', 'pr-comment.md');
      fs.writeFileSync(out, body, 'utf8');
      console.log(`💬 PR 回写失败（HTTP ${resp.status}），已降级写 ${out}：${t.slice(0, 120)}`);
    }
  } catch (e) {
    const out = path.join(ROOT, 'report', 'pr-comment.md');
    fs.writeFileSync(out, body, 'utf8');
    console.log(`💬 PR 回写异常（${e.message}），已降级写 ${out}`);
  }
}

// ---------- 企微机器人真实推送（闭环收口：跑完 → 实时推送给值班/开发）----------
// 配置 --webhook <url> 或 WEBHOOK_URL 时经企微机器人 webhook 真实推送（与 cron-monitor 同协议）；否则跳过，保持离线零依赖。
// 企微 markdown 正文限制 4096 字节，超长截断以免推送被拒；推送失败/异常时降级落盘 report/.officer-last-message.md。
async function pushToWeChat({ report }) {
  const webhook = args.webhook || process.env.WEBHOOK_URL || '';
  if (!webhook || webhook === true) return;
  const content = buildPRComment({ report, reportUrl: 'report/index.html' });
  const md = content.length > 4000 ? content.slice(0, 4000) + '\n…(正文过长已截断)' : content;
  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md } }),
    });
    const j = await resp.json().catch(() => ({}));
    if (resp.ok && (j.errcode === 0 || j.errcode === undefined)) {
      console.log('📲 企微推送成功：测试报告已实时推送给值班/开发');
    } else {
      console.log(`📲 企微推送失败 HTTP ${resp.status} ${JSON.stringify(j)}（已降级写 report/.officer-last-message.md）`);
      fs.writeFileSync(path.join(ROOT, 'report', '.officer-last-message.md'), content, 'utf8');
    }
  } catch (e) {
    console.log('📲 企微推送异常：' + e.message + '（已降级写 report/.officer-last-message.md）');
    fs.writeFileSync(path.join(ROOT, 'report', '.officer-last-message.md'), content, 'utf8');
  }
}

async function main() {
  const WALL0 = Date.now();
  const perf = () => `⏱ 性能：wall ${((Date.now() - WALL0) / 1000).toFixed(1)}s ｜ LLM ${_llmStats.calls} 次调用累计 ${(_llmStats.ms / 1000).toFixed(1)}s`;
  const outName = args.out || 'report';
  const reportJsonPath = path.join(ROOT, 'report', `${outName}.json`);

  // 预热快模型代理：首次调用常因代理冷启动慢 10~30s。这里在后台提前发一个极小请求，
  // 与后续的 git 解析 / 选测 / 首轮跑测（约 30s）并行，避免冷启动落在关键路径上。
  if (isLLMEnabled() && hasFastModel()) {
    chat({ model: fastModel(), maxTokens: 8, temperature: 0, messages: [{ role: 'user', content: 'ping' }], stats: false }).catch(() => {});
  }


  // --- 场景 B：需求驱动（TAPD 直连 / 离线 fixture，复用通用选测引擎）---
  if (scenario === 'B') {
    // 默认优先用 Markdown 需求（docs/requirement.md），不存在则回退 JSON fixture
    const defMd = path.join(repoDir, 'docs', 'requirement.md');
    let reqPath = args.requirement || (fs.existsSync(defMd) ? defMd : path.join(repoDir, 'docs', 'requirement-demo.json'));
    let tapdSource = '';
    // 场景 B 直连 TAPD（与场景 A 直连 TGit 同构）：脚本自己从 TAPD REST 拉需求/缺陷，
    // 不依赖宿主 MCP→写文件；落盘为 .md 后复用 parseMarkdownRequirement 规约为通用 fixture。
    const tapdWs = process.env.TAPD_WORKSPACE_ID || '';
    if (args.story || args.bug) {
      if (!tapdWs) {
        console.warn('⚠️ 指定了 --story/--bug 但未配置 TAPD_WORKSPACE_ID，回退本地需求文件');
      } else {
        try {
          const md = args.story
            ? await fetchTAPDStory({ storyId: args.story, workspaceId: tapdWs, apiBase: TAPD_API_BASE })
            : await fetchTAPDBug({ bugId: args.bug, workspaceId: tapdWs, apiBase: TAPD_API_BASE });
          const rel = args.story ? `report/.mcp-req-story-${args.story}.md` : `report/.mcp-req-bug-${args.bug}.md`;
          const abs = path.join(ROOT, rel);
          fs.writeFileSync(abs, md, 'utf8');
          reqPath = abs;
          tapdSource = args.story ? `TAPD 真实需求（#${args.story} @ workspace ${tapdWs}）` : `TAPD 真实缺陷（#${args.bug} @ workspace ${tapdWs}）`;
          console.log(`   🌐 已从 TAPD 拉取${args.story ? '需求' : '缺陷'}，落盘 ${rel}`);
        } catch (e) {
          console.warn(`⚠️ TAPD 直连拉取失败（${e.message}），回退本地需求文件`);
        }
      }
    }
    const req = readRequirement(reqPath);
    if (tapdSource) req.source = tapdSource;
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
    const run1B = await runInWorktree(target, sel.testFiles);
    const { unit, api, ui } = run1B;
    const results = [...unit, ...api, ...ui];
    const officerCtxB = buildOfficerCtx({ repoDir, diffText: '', lastUnitRaw: run1B.raw.unit, sel });
    // AI 根因推理（场景 B 同样适用：单发 chat + 日志内联，结合失败日志重写 rootCause）
    const failingB = results.filter((r) => r.status === 'fail');
    if (failingB.length) {
      const causesB = await llmRootCause('', failingB, officerCtxB);
      for (const r of failingB) if (causesB[r.name]) r.rootCause = causesB[r.name];
    }

    // ---------- 自适应策略（P1）：确定性决策 + 可选快模型旁白 ----------
    let adaptiveB = null;
    if (failingB.length) {
      const decisionB = await adaptiveDecision(failingB);
      adaptiveB = await runAdaptive({ decision: decisionB, failing: failingB, target, repoDir, originalRun: sel.testFiles });
      if (adaptiveB.extraResults.length) results.push(...adaptiveB.extraResults);
      const firstFailNamesB = new Set(failingB.map((f) => f.name));
      const newFailingB = results.filter((r) => r.status === 'fail' && !firstFailNamesB.has(r.name));
      if (newFailingB.length) {
        const causesB2 = await llmRootCause('', newFailingB, officerCtxB);
        for (const r of newFailingB) if (causesB2[r.name]) r.rootCause = causesB2[r.name];
      }
      console.log(`🔄 自适应策略：${decisionB.rationale} ｜ ${adaptiveB.actions.join('；')}`);
    }

    // ---------- AI 测试生成（根因暴露盲区时，自动补写能复现 bug 的回归测试）----------
    let generatedTests = [];
    if (isLLMEnabled()) {
      generatedTests = await generateRegressionTests({ target, failing: failingB, ctx: officerCtxB });
      if (generatedTests.length) console.log(`🧪 AI 生成回归测试：${generatedTests.filter((g) => g.status === 'reproduced').length} 个在缺陷分支可复现 bug`);
    }

    const coverage = computeCoverage(req, results, repoDir);
    const covered = coverage.filter((c) => c.status === 'pass').length;
    const gaps = coverage.filter((c) => ['missing', 'stub', 'untested'].includes(c.status)).length;
    const failingPts = coverage.filter((c) => c.status === 'fail').length;

    // ---------- AI 覆盖度语义判定（事实由引擎测、语义由 LLM 判；覆盖度判定 ∥ 需求审计并行）----------
    let aiSuggestedPoints = [];
    if (isLLMEnabled()) {
      const evidence = gatherCoverageEvidence(req, results, repoDir);
      const reqText = readTextRobust(reqPath);
      const [aiCov, aiAudit] = await Promise.all([
        llmCoverageJudge(evidence),
        llmRequirementAudit(reqText, req.points),
      ]);
      if (Array.isArray(aiCov)) {
        const map = new Map(aiCov.map((x) => [x.pointId, x]));
        for (const c of coverage) {
          const a = map.get(c.id);
          if (a) c.ai = { verdict: a.verdict, testAdequacy: a.testAdequacy, confidence: a.confidence, reasoning: a.reasoning, gap: a.gap };
        }
        console.log(`   🤖 AI 覆盖度判定：${coverage.filter((c) => c.ai).length} 个测试点已加语义评审`);
      }
      if (aiAudit && aiAudit.missingFromPoints && aiAudit.missingFromPoints.length) {
        aiSuggestedPoints = aiAudit.missingFromPoints;
        console.log(`   🤖 AI 需求审计：发现 ${aiSuggestedPoints.length} 个文档提及但测试点未覆盖的能力`);
      }
      impact.aiCoverage = true;
    }

    const plan = [
      { step: `读需求文档 ${req.id}`, why: '拆解测试点，明确应验证的能力' },
      { step: `关联代码模块（${impact.srcFiles.length} 个）`, why: '把需求点映射到实现源码' },
      sel.narrowed ? { step: `仅跑受影响测试（${sel.testFiles.length} 个）`, why: sel.reason } : { step: '跑全量单测', why: sel.reason },
      { step: '跑 API 端到端冒烟', why: '真实 API 端到端验证核心下单链路' },
      { step: '产出需求覆盖度报告', why: `已覆盖 ${covered} / 缺口 ${gaps} / 不达标 ${failingPts}` },
    ];
    if (adaptiveB && adaptiveB.actions.length) {
      plan.push({
        step: `自适应扩展/复跑（${adaptiveB.expandedTests.length} 个新测试）`,
        why: `首轮失败触发：${adaptiveB.decision?.rationale || ''}`,
      });
    }
    const report = {
      meta: { title: 'AI 测试官报告', repo: path.basename(repoDir), scenario, triggeredBy, generatedAt: new Date().toISOString(), aiEnabled: isLLMEnabled() },
      impact,
      plan,
      results,
      coverage,
      adaptive: adaptiveB,
      aiSuggestedPoints,
      generatedTests,
      process: buildProcess({ scenario, req, impact, sel, summary: summarize(results), adaptive: adaptiveB, generatedTests }),
      summary: summarize(results),
    };
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`📝 已写 ${reportJsonPath}`);
    await run(ROOT, 'node', ['report/generate-report.mjs', reportJsonPath]);
    console.log(`\n✅ 场景 B 完成：覆盖 ${covered} / 缺口 ${gaps} / 不达标 ${failingPts}`);
    console.log(perf());
    return;
  }

  // --- 场景 A / C：代码改动驱动（或 base=target 全量回归）---
  // diff 来源优先级：--diff 外部文件 > 工蜂真实 MR diff（--pr + TGIT_TOKEN，直连 REST）> 本地 git diff
  const tgitToken = process.env.TGIT_TOKEN || process.env.GIT_TOKEN || '';
  const tgitApiBase = process.env.TGIT_API_BASE || 'https://git.woa.com/api/v3';
  let diffText, diffSource;
  if (diffFile) {
    diffText = readTextRobust(path.resolve(ROOT, diffFile));
    diffSource = `MCP/外部 diff 文件：${diffFile}`;
  } else if (args.pr && args.pr !== true && tgitToken) {
    const project = resolveTGitProject();
    if (project) {
      try {
        diffText = await fetchTGitMRDiff({ project, iid: args.pr, token: tgitToken, apiBase: tgitApiBase });
        diffSource = `TGit 真实 MR diff（!${args.pr} @ ${project}）`;
        fs.writeFileSync(path.join(ROOT, 'report', '.mcp-diff.txt'), diffText, 'utf8');
        console.log(`   🌐 已从工蜂拉取真实 MR diff（${project} !${args.pr}），落盘 report/.mcp-diff.txt`);
      } catch (e) {
        console.warn(`⚠️ TGit 真实 diff 拉取失败（${e.message}），回退本地 git diff`);
        diffText = await git(repoDir, 'diff', `${base}..${target}`, '--', '.');
        diffSource = `git diff ${base}..${target}（TGit 拉取失败回退）`;
      }
    } else {
      diffText = await git(repoDir, 'diff', `${base}..${target}`, '--', '.');
      diffSource = `git diff ${base}..${target}（无法定位工蜂项目，回退）`;
    }
  } else {
    // 注意：被测仓库 sample-app 在本工作区是 HACK 仓库的子目录（无独立 .git），
    // 直接 `git diff base..target` 会作用到整个 HACK 仓库、混入 agent/README 等无关改动并触发全量回退。
    // 用 `-- .` 把 diff 限定到 cwd（sample-app）子树，只关注被测代码改动。
    diffText = await git(repoDir, 'diff', `${base}..${target}`, '--', '.');
    diffSource = `git diff ${base}..${target}`;
  }
  console.log(`🔍 理解变更：${diffSource}`);
  const impact = analyzeDiff(diffText);
  impact.diffSource = diffSource;
  impact.aiEnabled = isLLMEnabled();
  // AI 语义理解：纯展示、失败即无；用快模型且与后续跑测并行，不阻塞主链路
  const semanticP = isLLMEnabled() ? semanticAnalyze(diffText, impact).catch(() => null) : Promise.resolve(null);
  console.log(`   改动文件：${impact.changedFiles.join(', ') || '(无)'}`);
  console.log(`   改动函数：${impact.changedFunctions.join(', ') || '(无)'}`);

  // 通用精准选测：导入图反向可达 + 同名兜底（不依赖业务语义）
  const gitRoot = (await git(repoDir, 'rev-parse', '--show-toplevel')).trim();
  const sel = selectTests({ repoDir, gitRoot, changedFiles: impact.changedFiles });
  impact.affectedTests = sel.testFiles.map((f) => path.relative(repoDir, f));
  impact.narrowed = sel.narrowed;
  impact.selectionReason = sel.reason;
  console.log(`   ${sel.narrowed ? '🎯 精准选测' : '⚠️ 全量回退'}：${sel.reason}`);

  // ---------- ReAct 整体规划（问题3）：Agent 自主观察 diff/测试集，规划"测什么/顺序/是否含 UI"，与结构选测取并集 ----------
  const officerCtxPlan = buildOfficerCtx({ repoDir, diffText, lastUnitRaw: '', sel });
  const reactPlan = await planWithReActAgent({ repoDir, diffText, impact, sel, officerCtx: officerCtxPlan });
  let runTests = sel.testFiles;
  if (reactPlan) {
    runTests = reactPlan._mergedTests && reactPlan._mergedTests.length ? reactPlan._mergedTests : sel.testFiles;
    impact.reactPlan = {
      focus: reactPlan.focus,
      includeUi: reactPlan.includeUi,
      includeApi: reactPlan.includeApi,
      blindSpots: reactPlan.blindSpots || [],
      rationale: reactPlan.rationale,
      addedTests: reactPlan._addedTests || [],
      trace: reactPlan._trace || [],
    };
    console.log(`   🧭 ReAct 规划：核心风险=${reactPlan.focus || '（未指明）'}`);
    if (reactPlan._addedTests && reactPlan._addedTests.length) {
      console.log(`      Agent 补充选测 ${reactPlan._addedTests.length} 个：${reactPlan._addedTests.join(', ')}`);
    }
    if (reactPlan.blindSpots && reactPlan.blindSpots.length) {
      console.log(`      Agent 识别盲区：${reactPlan.blindSpots.join('；')}`);
    }
  }

  console.log('🧪 执行验证（worktree 真实跑测）…');
  const run1 = await runInWorktree(target, runTests);
  const { unit, api, ui } = run1;
  const results = [...unit, ...api, ...ui];
  // 语义理解（已与跑测并行）此刻应已完成，补打展示
  impact.llmUnderstand = await semanticP;
  if (impact.llmUnderstand) {
    console.log(`   🤖 AI 语义理解：意图=${impact.llmUnderstand.intent} ｜ 风险=${impact.llmUnderstand.riskLevel}`);
    console.log(`      影响流程：${(impact.llmUnderstand.businessFlows || []).join('、') || '（未指明）'}`);
  } else if (isLLMEnabled()) {
    console.log('   （AI 语义理解未返回有效结果，沿用结构分析）');
  } else {
    console.log('   （AI 语义分析未启用 · 离线模式，沿用结构分析）');
  }

  // 构建领域上下文（供根因/生成读取日志与源码；不再注入 ReAct 工具）
  const officerCtx = buildOfficerCtx({ repoDir, diffText, lastUnitRaw: run1.raw.unit, sel });

  // AI 根因推理（单发 chat + 日志内联，去掉伪工具循环）：用模型结合 diff + 真实日志重写 rootCause
  const failing = results.filter((r) => r.status === 'fail');
  if (failing.length) {
    const causes = await llmRootCause(diffText, failing, officerCtx);
    for (const r of failing) if (causes[r.name]) r.rootCause = causes[r.name];
  }

  // ---------- 自适应策略（P1）：首轮失败后，确定性决策 + 可选快模型旁白 ----------
  let adaptive = null;
  if (failing.length) {
    const decision = await adaptiveDecision(failing);
    adaptive = await runAdaptive({ decision, failing, target, repoDir, originalRun: runTests });
    if (adaptive.extraResults.length) results.push(...adaptive.extraResults);
    // 扩展选测可能暴露新的失败 → 只对【首轮未出现的新失败】补跑 AI 根因，避免整轮重复
    const firstFailNames = new Set(failing.map((f) => f.name));
    const newFailing = results.filter((r) => r.status === 'fail' && !firstFailNames.has(r.name));
    if (newFailing.length) {
      const causes2 = await llmRootCause(diffText, newFailing, officerCtx);
      for (const r of newFailing) if (causes2[r.name]) r.rootCause = causes2[r.name];
    }
    console.log(`🔄 自适应策略：${decision.rationale} ｜ ${adaptive.actions.join('；')}`);
  }

  // ---------- AI 测试生成（根因暴露盲区时，自动补写能复现 bug 的回归测试）----------
  let generatedTests = [];
  if (isLLMEnabled()) {
    generatedTests = await generateRegressionTests({ target, failing, ctx: officerCtx });
    if (generatedTests.length) console.log(`🧪 AI 生成回归测试：${generatedTests.filter((g) => g.status === 'reproduced').length} 个在缺陷分支可复现 bug`);
  }

  const u = impact.llmUnderstand;
  const plan = [
    {
      step: `读 git diff ${base}..${target}`,
      why: u ? `AI 语义理解：${u.intent}（${u.reasoning || '判断影响面'}）` : '定位改动文件，判断影响面',
    },
  ];
  if (impact.reactPlan) {
    plan.push({
      step: `ReAct Agent 规划测试策略（核心风险：${impact.reactPlan.focus || '—'}）`,
      why: `${impact.reactPlan.rationale || '自主规划测什么/顺序/是否含 UI'}`
        + (impact.reactPlan.addedTests?.length ? `；补充选测 ${impact.reactPlan.addedTests.length} 个` : '')
        + (impact.reactPlan.blindSpots?.length ? `；识别盲区 ${impact.reactPlan.blindSpots.length} 处` : ''),
    });
  }
  plan.push(
    sel.narrowed
      ? { step: `仅跑受影响测试（${sel.testFiles.length} 个）`, why: (u && u.recommendedFocus?.length ? `AI 建议重点：${u.recommendedFocus.join('、')}；` : '') + sel.reason }
      : { step: '跑全量单测 node --test', why: sel.reason },
    { step: '跑 API 端到端冒烟', why: '真实 API 端到端验证核心下单链路' },
  );
  if (adaptive && adaptive.actions.length) {
    plan.push({
      step: `自适应扩展/复跑（${adaptive.expandedTests.length} 个新测试）`,
      why: `首轮失败触发：${adaptive.decision?.rationale || ''}`,
    });
  }

  const report = {
    meta: { title: 'AI 测试官报告', repo: path.basename(repoDir), scenario, triggeredBy, generatedAt: new Date().toISOString(), aiEnabled: isLLMEnabled() },
    impact,
    plan,
    results,
    adaptive,
    generatedTests,
    process: buildProcess({ scenario, impact, sel, summary: summarize(results), adaptive, generatedTests }),
    summary: summarize(results),
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`📝 已写 ${reportJsonPath}`);

  await run(ROOT, 'node', ['report/generate-report.mjs', reportJsonPath]);

  // ---------- PR/MR 自动回写闭环（问题2）：跑完 → 在工蜂 MR 下评论测试结果（有凭据则真写，否则 dry-run）----------
  await commentToPR({ report });

  // ---------- 企微真实推送闭环：跑完 → 实时推送给值班/开发（配置 --webhook/WEBHOOK_URL 则真推，否则跳过）----------
  await pushToWeChat({ report });


  console.log(`\n✅ 完成：通过 ${report.summary.pass} / 失败 ${report.summary.fail}`);
  console.log(perf());
}

main().catch((e) => {
  console.error('❌ 执行失败:', e.message);
  process.exit(1);
});
