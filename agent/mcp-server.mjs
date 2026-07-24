// AI 测试官 · MCP Server（零依赖）
//
// 把「理解变更 → 规划策略 → 执行验证 → 产出可决策报告」的执行引擎，包装成标准 MCP Server，
// 让任意 MCP 客户端（含 Box 平台 MCP 连接器、CodeBuddy、Claude Desktop 等）都能调用。
//
// 双 Transport：
//   ① stdio（默认）：适合被 MCP 客户端以「命令」方式拉起（Box MCP 连接器 / 本地 IDE）。
//   ② HTTP Streamable（--http）：适合以「URL」方式注册到 Box 平台 MCP 连接器，
//      绑定 127.0.0.1 即可本地；若 --host 0.0.0.0 必须配合 --token（避免裸暴露成任意命令执行）。
//
// 用法：
//   node agent/mcp-server.mjs                         # stdio 模式（默认）
//   node agent/mcp-server.mjs --http --port 3001      # HTTP/SSE，本地 127.0.0.1
//   node agent/mcp-server.mjs --http --port 3001 --host 0.0.0.0 --token <secret>   # 内网/评审访问（带鉴权）
//
// 暴露工具：
//   list_scenarios        列出五场景（A/B/C/D/E）语义与触发方式
//   run_test_officer      执行某一场景（可传 base/target/requirement/merge 等；useDemoDefaults 填演示默认值）
//   get_report            读取某次运行的报告 JSON，回放结论

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..'); // f:/HACK
const VERSION = '1.0.0';
const SERVER_NAME = 'ai-test-officer';

// ---------- 服务端参数 ----------
const margs = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = arr[i + 1];
    m[k] = v === undefined || v.startsWith('--') ? true : v;
  }
  return m;
}, {});

if (margs.help) {
  console.log(`AI 测试官 · MCP Server（让任意 MCP 客户端调度五场景测试）
用法：
  node agent/mcp-server.mjs                          # stdio 模式（默认，供 MCP 客户端以命令拉起）
  node agent/mcp-server.mjs --http --port 3001       # HTTP/SSE 模式（供 Box MCP 连接器以 URL 注册）
  node agent/mcp-server.mjs --http --host 0.0.0.0 --token <secret>   # 非本地暴露（强制带 token）

工具：list_scenarios / run_test_officer / get_report`);
  process.exit(0);
}

const HTTP_MODE = !!margs.http;
const PORT = Number(margs.port || 3001);
const HOST = margs.host || '127.0.0.1';
const TOKEN = margs.token || '';

if (HTTP_MODE && HOST === '0.0.0.0' && !TOKEN) {
  console.error('⛔ 拒绝以 0.0.0.0 裸暴露：请加 --token <secret>（否则等价于开放任意命令执行）。');
  process.exit(1);
}

// ---------- 日志（仅 stderr，绝不污染 stdout / SSE 流）----------
const log = (...a) => console.error(`[mcp ${new Date().toISOString()}]`, ...a);

// ---------- 子进程：调用执行引擎 ----------
function runNode(argv) {
  return new Promise((resolve) => {
    log('spawn:', 'node', argv.join(' '));
    const p = spawn('node', argv, { cwd: ROOT, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: out + '\n[SPAWN ERROR] ' + e.message }));
    p.on('close', (code) => resolve({ code: code ?? 0, out }));
  });
}

// ---------- 场景预设（useDemoDefaults）----------
const DEMO = {
  A: { scenario: 'A', base: 'main', target: 'feature/coupon-bug' },
  B: { scenario: 'B', base: 'main', target: 'main', requirement: 'sample-app/docs/requirement.md' },
  C: { scenario: 'C', base: 'main', target: 'feature/coupon-bug' },
  D: { scenario: 'D', base: 'feature/coupon-bug', target: 'main', requirement: 'sample-app/docs/requirement.md' },
  E: { scenario: 'E', base: 'main', target: 'feature/coupon-refund-guard', merge: 'feature/coupon-floor-guard' },
};

function buildArgv(p) {
  const scenario = (p.scenario || 'A').toUpperCase();
  const useDemo = !!p.useDemoDefaults;
  const d = useDemo ? DEMO[scenario] : {};
  const out = p.out || `mcp-${scenario}-${Date.now()}`;
  const repoUrl = p.repoUrl || '';
  // repoUrl 存在时不再默认注入本地 sample-app：让引擎自动 clone 远端仓库
  const repo = p.repo || (repoUrl ? '' : (d.repo || 'sample-app'));

  let argv;
  if (scenario === 'C') {
    const branch = p.target || p.base || d.target || d.base || 'main';
    argv = ['agent/cron-monitor.mjs', '--branch', branch, '--out', out, '--once'];
    if (p.webhook) argv.push('--webhook', p.webhook);
  } else {
    argv = ['agent/run-test-officer.mjs', '--scenario', scenario, '--out', out];
    if (repoUrl) argv.push('--repo-url', repoUrl);
    if (repo) argv.push('--repo', repo);
    // 前端 UI 冒烟解耦（换仓库可指定启动命令 / spec / 探活路径，或整体关闭）
    if (p.uiStart) argv.push('--ui-start', p.uiStart);
    if (p.uiSpec) argv.push('--ui-spec', p.uiSpec);
    if (p.uiReady) argv.push('--ui-ready', p.uiReady);
    if (p.uiOff) argv.push('--ui-off');
    const base = p.base || d.base;
    const target = p.target || d.target;
    if (base) argv.push('--base', base);
    if (target) argv.push('--target', target);
    const req = p.requirement || d.requirement;
    if (req) argv.push('--requirement', req);
    if (scenario === 'E' && (p.merge || d.merge)) argv.push('--merge', p.merge || d.merge);
    if (p.pr) {
      argv.push('--pr', String(p.pr));
      if (p.prProject) argv.push('--pr-project', p.prProject);
    }
    if (p.webhook) argv.push('--webhook', p.webhook);
    if (p.story) argv.push('--story', String(p.story));
    if (p.bug) argv.push('--bug', String(p.bug));
  }
  if (p.triggeredBy) argv.push('--triggeredBy', p.triggeredBy);
  return { argv, out };
}

function summarizeReport(report, scenario, out, ran) {
  const meta = report?.meta || {};
  const summary = report?.summary || {};
  const results = report?.results || [];
  const fails = results.filter((r) => r.status === 'fail');
  const fixVerdict = report?.fixVerdict;
  const conflict = report?.conflictAnalysis;

  const lines = [];
  lines.push(`# AI 测试官 · 场景 ${scenario} 执行结果`);
  lines.push('');
  lines.push(`- 仓库：${meta.repo || '-'}`);
  lines.push(`- 触发：${meta.triggeredBy || '-'}`);
  lines.push(`- AI 语义层：${meta.aiEnabled ? '已启用（LLM 驱动理解/规划/根因）' : '离线（确定性回退）'}`);
  lines.push(`- 验证：${summary.pass ?? 0} 符合预期 / ${summary.fail ?? 0} 发现问题 / 共 ${summary.total ?? results.length} 项`);
  if (fails.length) {
    lines.push('');
    lines.push(`## 发现问题（前 ${Math.min(fails.length, 10)} 项）`);
    for (const f of fails.slice(0, 10)) {
      lines.push(`- [${f.severity || '?'}] ${f.name}`);
      if (f.rootCause && f.rootCause !== '-') lines.push(`  - 根因：${f.rootCause}`);
    }
    if (fails.length > 10) lines.push(`- …其余 ${fails.length - 10} 项`);
  }
  if (fixVerdict) lines.push('', `## 修复判定：${fixVerdict.verdict}${fixVerdict.reason ? ' — ' + fixVerdict.reason : ''}`);
  if (Array.isArray(conflict) && conflict.length) {
    lines.push('', `## 语义冲突：${conflict.length} 个`);
    for (const c of conflict.slice(0, 5)) lines.push(`- ${c.description || JSON.stringify(c)}`);
  }
  lines.push('', `📊 完整报告：report/${out}.html`);
  return lines.join('\n');
}

// ---------- 工具实现 ----------
const TOOLS = [
  {
    name: 'list_scenarios',
    description: '列出 AI 测试官支持的五个场景（A 代码改动 / B 需求驱动 / C 持续巡检 / D Bug 修复验证 / E 合并冲突检测）及其触发方式与产出。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      const s = [
        ['A · 代码改动', '读 diff → 影响面分析 → 精准选测 → worktree 真实跑测', 'run_test_officer({scenario:"A", base, target})'],
        ['B · 需求驱动', '读需求文档 → AI 拆解测试点 → 源码核对 + 覆盖度矩阵', 'run_test_officer({scenario:"B", requirement})'],
        ['C · 持续巡检', '对目标分支全量回归 → 异常经企微 webhook 推送（dry-run 落盘）', 'run_test_officer({scenario:"C", target})'],
        ['D · Bug 修复验证', '缺陷基线复现 → 修复分支验证 → fail→pass 证据 + 有无回归', 'run_test_officer({scenario:"D", base, target})'],
        ['E · 合并冲突检测', '两分支各自通过 → 模拟合并跑测 → 抓语义冲突', 'run_test_officer({scenario:"E", base, target, merge})'],
      ];
      const text = '# AI 测试官 · 五场景\n' + s.map(([n, d, c]) => `- **${n}**：${d}\n  - 调用：${c}`).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'run_test_officer',
    description: '执行 AI 测试官某一场景：理解变更 → 规划策略 → 真实跑测 → 产出可决策报告。会真实运行单测/API/UI 冒烟（不 mock）。设 useDemoDefaults=true 可自动填入演示分支参数，零配置体验。',
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'], description: '场景编号' },
        useDemoDefaults: { type: 'boolean', description: 'true 时自动填入演示分支（feature/coupon-bug 等），无需手动传 base/target' },
        repo: { type: 'string', description: '被测仓库目录（默认 sample-app）；与 repoUrl 二选一' },
        repoUrl: { type: 'string', description: '远端仓库地址（GitHub/工蜂等），引擎自动 clone 后跑测（含全部分支）；与 repo 二选一' },
        uiStart: { type: 'string', description: '前端 UI 冒烟：在被测仓库内启动服务的命令（默认 "node src/server.js"）' },
        uiSpec: { type: 'string', description: '前端 UI 冒烟：Playwright spec 相对仓库根路径（默认 smoke/ui-smoke.spec.js）' },
        uiReady: { type: 'string', description: '前端 UI 冒烟：服务就绪探活的相对路径（默认 /api/products）' },
        uiOff: { type: 'boolean', description: 'true 时关闭前端 UI 冒烟（换无前端的仓库时用）' },
        base: { type: 'string', description: '基准分支/提交（如 main）' },
        target: { type: 'string', description: '目标分支/提交（如 feature/coupon-bug）' },
        requirement: { type: 'string', description: '场景 B 需求文档路径（.md/.json）' },
        merge: { type: 'string', description: '场景 E 待合并的另一分支' },
        pr: { type: 'string', description: '场景 A 工蜂 MR IID（配合 TGIT_TOKEN 真实回写评论）' },
        prProject: { type: 'string', description: '工蜂项目 owner/repo' },
        story: { type: 'string', description: '场景 B 真实 TAPD 需求 ID（需 TAPD 凭据）' },
        bug: { type: 'string', description: '场景 D 真实 TAPD 缺陷 ID（需 TAPD 凭据）' },
        webhook: { type: 'string', description: '企微机器人 webhook（报告实时推送）' },
        triggeredBy: { type: 'string', description: '触发来源说明（写入报告元信息）' },
        out: { type: 'string', description: '报告文件名前缀（默认 mcp-<场景>-<时间戳>）' },
      },
      required: ['scenario'],
    },
    async run(p) {
      const scenario = (p.scenario || 'A').toUpperCase();
      if (!['A', 'B', 'C', 'D', 'E'].includes(scenario)) {
        return { isError: true, content: [{ type: 'text', text: `❌ 非法 scenario "${scenario}"，仅支持 A/B/C/D/E` }] };
      }
      const { argv, out } = buildArgv(p);
      const ran = await runNode(argv);
      const reportPath = path.join(ROOT, 'report', `${out}.json`);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch {}
      if (ran.code !== 0 && !report) {
        return {
          isError: true,
          content: [{ type: 'text', text: `❌ 执行引擎异常（exit ${ran.code}）：\n${ran.out.slice(-1500)}` }],
        };
      }
      const text = summarizeReport(report, scenario, out, ran);
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'get_report',
    description: '读取某次运行的报告 JSON（report/<out>.json），回放其结论与统计。',
    inputSchema: {
      type: 'object',
      properties: { out: { type: 'string', description: '报告文件名前缀（不含 .json），如 mcp-A-123 / report-A' } },
      required: ['out'],
    },
    async run(p) {
      const reportPath = path.join(ROOT, 'report', `${p.out}.json`);
      let report;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
      catch { return { isError: true, content: [{ type: 'text', text: `❌ 找不到报告 report/${p.out}.json` }] }; }
      const scenario = report.meta?.scenario || '?';
      const text = summarizeReport(report, scenario, p.out, null);
      return { content: [{ type: 'text', text }] };
    },
  },
];

// ---------- JSON-RPC 分发 ----------
async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions:
          'AI 测试官 MCP Server：用 list_scenarios 查看五场景，用 run_test_officer 执行（设 useDemoDefaults=true 可零配置体验）。执行结果为真实测试报告，非 mock。',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: `❌ 未知工具 ${params.name}` }] };
      try {
        return await tool.run(params.arguments || {});
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `❌ 工具执行异常：${e.message}` }] };
      }
    }
    default:
      throw new Error(`不支持的方法 ${method}`);
  }
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  if (msg.method) {
    if (msg.id === undefined) return null; // 通知：静默处理（如 notifications/initialized）
    try {
      const result = await dispatch(msg.method, msg.params || {});
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } };
    }
  }
  return null; // 其他（响应）忽略
}

// ---------- Transport: stdio ----------
function startStdio() {
  log('stdio 模式启动');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleMessage(msg).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// ---------- Transport: HTTP Streamable ----------
function startHttp() {
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: VERSION }));
    }
    if (req.url !== '/mcp') { res.writeHead(404); return res.end('Not Found'); }

    if (req.method === 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Method Not Allowed' })); }

    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

    // 鉴权
    if (TOKEN) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    }

    // 读 body
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }

    // 会话
    let sessionId = req.headers['mcp-session-id'];
    if (msg.method === 'initialize') {
      sessionId = crypto.randomUUID();
      sessions.set(sessionId, { createdAt: Date.now() });
    } else if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'Unknown or missing Mcp-Session-Id' } }));
    }

    const result = await handleMessage(msg);

    const accept = req.headers['accept'] || '';
    const wantJson = accept.includes('application/json') && !accept.includes('text/event-stream');

    const headers = { 'Cache-Control': 'no-cache' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    if (!result) { // 通知，无响应体
      res.writeHead(202, headers);
      return res.end();
    }
    if (wantJson) {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  });

  server.listen(PORT, HOST, () => {
    log(`HTTP 模式启动：http://${HOST}:${PORT}/mcp  （MCP 连接器填此 URL；/health 可探活）`);
    if (HOST === '0.0.0.0') log('⚠️ 已绑定 0.0.0.0，已强制 Bearer 鉴权');
  });
}

if (HTTP_MODE) startHttp();
else startStdio();
