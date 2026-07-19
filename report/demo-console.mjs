// AI 测试官 · 功能展示控制台
// 用法：node report/demo-console.mjs [--port 5180] [--host 127.0.0.1]，然后打开 http://127.0.0.1:5180
//
// 一个页面串起评审演示全流程：场景介绍 → 浏览器一键真实执行 → Think→Act→Observe 实时过程 → 报告跳转。
// 与 live-server.mjs（被动实时看板，需另开终端跑命令）的区别：本控制台可直接在页面上触发场景运行。
//
// 实现：纯 node:http + Server-Sent Events，零第三方依赖。
// 安全：场景命令为服务端白名单（与 agent/demo.mjs 完全一致），页面只能选择运行哪个场景，不能注入任意命令。
// 并发：全局同一时间只允许一个场景在跑（多个 worktree/端口会冲突），其余请求返回 409。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REPORT_DIR = __dirname;

const args = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = arr[i + 1];
    m[k] = v === undefined || v.startsWith('--') ? true : v;
  }
  return m;
}, {});
const PORT = Number(args.port || process.env.CONSOLE_PORT || 5180);
const HOST = args.host || process.env.CONSOLE_HOST || '127.0.0.1';

// ---------- 五场景定义（命令与 agent/demo.mjs 保持一致，真实执行、不 mock） ----------
const SCENARIOS = [
  {
    id: 'a', icon: '🔀', title: '场景 A · 代码改动', out: 'report-A',
    sub: '读 diff → 影响面分析 → 精准选测 → worktree 真实跑测',
    cmd: 'run-test-officer --scenario A',
    argv: ['agent/run-test-officer.mjs', '--repo', 'sample-app', '--base', 'main', '--target', 'feature/coupon-bug', '--scenario', 'A', '--out', 'report-A', '--triggeredBy', '展示控制台 · 场景A 代码改动'],
  },
  {
    id: 'b', icon: '📋', title: '场景 B · 需求驱动', out: 'report-B',
    sub: '读需求文档 → AI 拆解测试点 → 源码核对 + 覆盖度矩阵',
    cmd: 'run-test-officer --scenario B --requirement …',
    argv: ['agent/run-test-officer.mjs', '--repo', 'sample-app', '--base', 'main', '--target', 'main', '--scenario', 'B', '--requirement', 'sample-app/docs/requirement.md', '--out', 'report-B', '--triggeredBy', '展示控制台 · 场景B 需求驱动'],
  },
  {
    id: 'c-healthy', icon: '🩺', title: '场景 C · 巡检基线', out: 'report-C-healthy',
    sub: '对 main 全量回归（健康基线），企微推送 dry-run 落盘',
    cmd: 'cron-monitor --branch main',
    argv: ['agent/cron-monitor.mjs', '--branch', 'main', '--out', 'report-C-healthy', '--triggeredBy', '展示控制台 · 场景C 巡检'],
  },
  {
    id: 'c-alert', icon: '🚨', title: '场景 C · 异常告警', out: 'report-C-alert',
    sub: '对含 bug 分支巡检 → 发现异常 → 企微告警（dry-run）',
    cmd: 'cron-monitor --branch feature/coupon-bug',
    argv: ['agent/cron-monitor.mjs', '--branch', 'feature/coupon-bug', '--out', 'report-C-alert', '--triggeredBy', '展示控制台 · 场景C 巡检'],
  },
  {
    id: 'd', icon: '🩹', title: '场景 D · Bug 修复验证', out: 'report-D',
    sub: '缺陷基线复现 → 修复分支验证 → fail→pass 证据 + 有无回归',
    cmd: 'run-test-officer --scenario D',
    argv: ['agent/run-test-officer.mjs', '--repo', 'sample-app', '--base', 'feature/coupon-bug', '--target', 'main', '--scenario', 'D', '--requirement', 'sample-app/docs/requirement.md', '--out', 'report-D', '--triggeredBy', '展示控制台 · 场景D 修复验证'],
  },
  {
    id: 'e', icon: '🧬', title: '场景 E · 合并冲突检测', out: 'report-E',
    sub: '两分支各自通过 → 模拟合并跑测 → 抓语义冲突',
    cmd: 'run-test-officer --scenario E --merge …',
    argv: ['agent/run-test-officer.mjs', '--repo', 'sample-app', '--base', 'main', '--target', 'feature/coupon-refund-guard', '--merge', 'feature/coupon-floor-guard', '--scenario', 'E', '--out', 'report-E', '--triggeredBy', '展示控制台 · 场景E 合并冲突检测'],
  },
];
const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

// ---------- 运行状态（全局单跑） ----------
let running = null; // { id, proc, startedAt, tail }
const lastRun = new Map(); // id -> { exit, endedAt, errTail }

function readSummary(out) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${out}.json`), 'utf8'));
    const s = j.summary || {};
    return {
      exists: true,
      total: s.total ?? (j.results || []).length,
      pass: s.pass ?? 0,
      fail: s.fail ?? 0,
      generatedAt: (j.meta && j.meta.generatedAt) || '',
      hasHtml: fs.existsSync(path.join(REPORT_DIR, `${out}.html`)),
      reportFile: `${out}.html`,
    };
  } catch {
    return { exists: false };
  }
}

// AI 语义层是否启用（只看是否存在 key，不读取/外泄密钥内容）
function aiEnabled() {
  if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) return true;
  try {
    const t = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    return /^\s*(OPENAI_API_KEY|LLM_API_KEY)\s*=\s*\S+/m.test(t);
  } catch {
    return false;
  }
}

function startRun(sc) {
  if (running) return false;
  // 先清空该场景的实时事件文件，避免已连接的 SSE 客户端回放到上一轮运行的旧事件（旧 done 会误触发"已完成"）
  try { fs.writeFileSync(path.join(REPORT_DIR, `.live-${sc.out}.ndjson`), '', 'utf8'); } catch {}
  const child = spawn('node', sc.argv, { cwd: ROOT, windowsHide: true });
  running = { id: sc.id, proc: child, startedAt: Date.now(), tail: '' };
  const eat = (d) => {
    if (running && running.id === sc.id) running.tail = (running.tail + d.toString()).slice(-4000);
  };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);
  child.on('close', (code) => {
    lastRun.set(sc.id, {
      exit: code ?? -1,
      endedAt: Date.now(),
      errTail: code ? (running?.tail || '').slice(-1500) : '',
    });
    running = null;
  });
  return true;
}

function statePayload() {
  return {
    aiEnabled: aiEnabled(),
    runningId: running?.id || null,
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      icon: s.icon,
      title: s.title,
      sub: s.sub,
      cmd: s.cmd,
      out: s.out,
      running: running?.id === s.id,
      last: lastRun.get(s.id) || null,
      report: readSummary(s.out),
    })),
  };
}

function sendSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---------- 展示页（内联 CSS/JS，离线可用） ----------
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>AI 测试官 · 功能展示控制台</title>
<style>
  :root{--bg:#0b0e17;--panel:#12172a;--panel2:#161c33;--line:#232a45;--txt:#e7eaf6;--sub:#8993b8;--accent:#6d8dff;--accent2:#9b7dff;--ok:#3ddc97;--warn:#ffb86b;--err:#ff6b81}
  *{box-sizing:border-box}
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:radial-gradient(1400px 700px at 15% -10%,#1c2452 0%,var(--bg) 55%);color:var(--txt);min-height:100vh;line-height:1.5}
  a{color:var(--accent);text-decoration:none}
  code{background:#0d1120;padding:2px 7px;border-radius:5px;color:#b9c3ff;border:1px solid var(--line);font-size:12px}
  button{font-family:inherit}

  header{padding:26px 32px 20px;border-bottom:1px solid var(--line);background:rgba(18,23,42,.6);backdrop-filter:blur(8px);position:sticky;top:0;z-index:10}
  .hrow{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{margin:0;font-size:20px;font-weight:800;letter-spacing:.2px;background:linear-gradient(135deg,#c9d4ff,#e8d9ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .hchips{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
  .chip{font-size:12px;padding:4px 11px;border-radius:20px;background:var(--panel2);border:1px solid var(--line);color:var(--sub)}
  .chip b{color:var(--txt);font-weight:600}
  .chip.ai-on{color:var(--ok);border-color:rgba(61,220,151,.4)}
  .chip.ai-off{color:var(--warn);border-color:rgba(255,184,107,.4)}

  main{max-width:1180px;margin:0 auto;padding:26px 32px 60px;display:grid;gap:22px}

  .intro{padding:22px 24px;background:linear-gradient(135deg,rgba(109,141,255,.1),rgba(155,125,255,.06));border:1px solid rgba(109,141,255,.3);border-radius:16px}
  .intro h2{margin:0 0 8px;font-size:17px;color:#f1f3ff}
  .intro p{margin:0;font-size:13px;color:#c3cbef;line-height:1.8;max-width:900px}

  .toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .toolbar h2{margin:0;font-size:16px;color:#f1f3ff}
  .toolbar .spacer{flex:1}
  .btn{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;border-radius:9px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:.15s;box-shadow:0 4px 14px rgba(109,141,255,.25)}
  .btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(109,141,255,.35)}
  .btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  .btn.ghost{background:var(--panel2);color:var(--txt);border:1px solid var(--line);box-shadow:none;font-weight:600}
  .btn.ghost:hover:not(:disabled){border-color:var(--accent)}

  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media (max-width:960px){.grid{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:640px){.grid{grid-template-columns:1fr}}
  .sc{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:8px;transition:.18s;position:relative;overflow:hidden}
  .sc:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(0,0,0,.35)}
  .sc.running{border-color:rgba(109,141,255,.55);box-shadow:0 0 0 3px rgba(109,141,255,.12)}
  .sc.selected{border-color:var(--accent2)}
  .sc.fresh{border-color:var(--ok);box-shadow:0 0 0 3px rgba(61,220,151,.18)}
  .thint{font-size:11.5px;color:var(--sub)}
  .scrow{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
  .sctitle{font-size:14.5px;font-weight:700;color:#f1f3ff}
  .scstatus{font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap}
  .scstatus.ok{background:rgba(61,220,151,.14);color:var(--ok)}
  .scstatus.bad{background:rgba(255,107,129,.14);color:var(--err)}
  .scstatus.muted{background:var(--panel2);color:var(--sub)}
  .scstatus.run{background:rgba(109,141,255,.16);color:var(--accent)}
  .scsub{font-size:12.5px;color:var(--sub);line-height:1.6;min-height:40px}
  .scbar{height:6px;background:var(--line);border-radius:6px;overflow:hidden}
  .scbar i{display:block;height:100%;border-radius:6px;transition:width .4s}
  .scnum{font-size:11.5px;color:var(--sub)}
  .scbtns{display:flex;gap:8px;margin-top:2px}
  .scbtns .btn{padding:6px 12px;font-size:12px}
  .scbtns a.btnlink{display:inline-flex;align-items:center;padding:6px 12px;font-size:12px;font-weight:600;border-radius:9px;border:1px solid var(--line);color:var(--accent);background:var(--panel2)}
  .scbtns a.btnlink:hover{border-color:var(--accent)}
  .scbtns a.btnlink.disabled{opacity:.4;pointer-events:none;color:var(--sub)}

  /* 实时执行面板 */
  .livepanel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
  .lp-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .lp-head h2{margin:0;font-size:15.5px;color:#f1f3ff}
  .lp-head .runname{font-size:12.5px;color:var(--accent);font-weight:600}
  .lp-head .lp-hint{font-size:11.5px;color:var(--sub);margin-left:auto}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--sub);flex-shrink:0}
  .dot.live{background:var(--ok);animation:pulse 1.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(61,220,151,.55)}70%{box-shadow:0 0 0 9px rgba(61,220,151,0)}100%{box-shadow:0 0 0 0 rgba(61,220,151,0)}}
  .timeline{display:flex;flex-direction:column;max-height:560px;overflow-y:auto;padding-right:6px}
  .step{display:grid;grid-template-columns:28px 1fr;gap:14px;position:relative;padding-bottom:20px}
  .step:last-child{padding-bottom:0}
  .step::before{content:'';position:absolute;left:13px;top:28px;bottom:0;width:2px;background:var(--line)}
  .step:last-child::before{display:none}
  .node{width:28px;height:28px;border-radius:50%;background:var(--panel2);border:2px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:12px;z-index:1;transition:.25s}
  .step.start .node{border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 4px rgba(109,141,255,.15)}
  .step.done .node{border-color:var(--ok);background:rgba(61,220,151,.12);color:var(--ok)}
  .step.warn .node{border-color:var(--warn);background:rgba(255,184,107,.12);color:var(--warn)}
  .step.error .node{border-color:var(--err);background:rgba(255,107,129,.12);color:var(--err)}
  .step .body{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .step.start .body{border-color:rgba(109,141,255,.35)}
  .step .title{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .badge{font-size:10.5px;padding:2px 8px;border-radius:20px;font-weight:600}
  .badge.start{background:rgba(109,141,255,.16);color:var(--accent)}
  .badge.done{background:rgba(61,220,151,.16);color:var(--ok)}
  .step .detail{color:#c3cbef;font-size:12.5px;margin-top:5px;word-break:break-word;line-height:1.6}
  .loglist{margin-top:8px;display:flex;flex-direction:column;gap:5px}
  .logline{font-size:12px;color:var(--sub);padding:5px 10px;background:#0d1120;border-radius:8px;border-left:3px solid var(--line);word-break:break-word;animation:fadeIn .25s ease}
  .logline.think{border-left-color:var(--accent2);color:#c9baff}
  .logline.act{border-left-color:var(--accent);color:#b7c6ff}
  .logline.answer{border-left-color:var(--ok);color:#a9f2d2}
  @keyframes fadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
  .empty{color:var(--sub);text-align:center;padding:44px 0;font-size:13.5px}
  .empty .big{font-size:36px;margin-bottom:8px}
  .footer-stat{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
  .fs{flex:1;min-width:100px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center;font-size:12px;color:var(--sub)}
  .fs b{display:block;font-size:22px;margin-bottom:2px;color:var(--txt)}
  .fs.pass b{color:var(--ok)}.fs.fail b{color:var(--err)}
  a.reportlink{display:inline-flex;align-items:center;justify-content:center;gap:6px;color:var(--accent);font-size:13px;font-weight:700}
  a.reportlink:hover{text-decoration:underline}
  .errbox{margin-top:14px;background:rgba(255,107,129,.08);border:1px solid rgba(255,107,129,.35);border-radius:10px;padding:12px 14px;font-size:12px;color:#f3b6c1}
  .errbox pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;max-height:180px;overflow:auto;color:var(--sub)}

  /* 能力亮点 */
  .caps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media (max-width:960px){.caps{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:640px){.caps{grid-template-columns:1fr}}
  .cap{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
  .cap .cicon{font-size:20px}
  .cap h3{margin:8px 0 6px;font-size:14px;color:#f1f3ff}
  .cap p{margin:0;font-size:12.5px;color:var(--sub);line-height:1.7}

  .note{padding:16px 20px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:12px;font-size:12.5px;color:#c3cbef;line-height:1.9}
  .note b{color:#f1f3ff}
  .sec-title{margin:6px 0 -6px;font-size:16px;color:#f1f3ff}

  .toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--warn);color:var(--warn);padding:10px 18px;border-radius:10px;font-size:13px;z-index:50;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  footer{text-align:center;color:var(--sub);font-size:12px;padding:0 32px 36px}
</style></head>
<body>
<header>
  <div class="hrow">
    <h1>🤖 AI 测试官 · 功能展示控制台</h1>
    <div class="hchips">
      <span class="chip">五场景闭环</span>
      <span class="chip">ReAct 规划</span>
      <span class="chip">自适应策略</span>
      <span class="chip">AI 回归生成</span>
      <span class="chip" id="aiChip">AI 语义层 …</span>
    </div>
  </div>
</header>
<main>
  <div class="intro">
    <h2>理解变更 → 规划策略 → 执行验证 → 产出可决策报告</h2>
    <p>覆盖后端逻辑到前端体验的全链路自动化测试 Agent。点击任意场景卡片上的「▶ 运行」，即可在浏览器里真实触发执行引擎（git worktree + node --test + API/UI 冒烟），并在下方实时面板观看 ReAct Agent 的 Think → Act → Observe 完整过程；跑完一键跳转可决策报告。全程零依赖、离线可演示，所有结果均为真实跑测，未做任何 mock。</p>
  </div>

  <div class="toolbar">
    <h2>🎬 五场景演示</h2>
    <span class="spacer"></span>
    <button class="btn ghost" id="refreshBtn">↻ 刷新状态</button>
    <button class="btn" id="runAllBtn">▶ 一键运行全部场景</button>
    <span class="thint">卡片展示各场景最近一次运行结果（含历史运行）；刚跑完的场景会以绿框高亮</span>
  </div>
  <div class="grid" id="grid"></div>

  <div class="livepanel" id="livePanel">
    <div class="lp-head">
      <span class="dot" id="dot"></span>
      <h2>📡 实时执行过程</h2>
      <span class="runname" id="liveRunName"></span>
      <span class="lp-hint">Think → Act → Observe 流式呈现 · 页面刷新可回放补看</span>
    </div>
    <div id="timeline" class="timeline"><div class="empty"><div class="big">🛰️</div>点击场景卡片上的「▶ 运行」或「📡 实时」，这里会实时出现执行过程</div></div>
    <div class="footer-stat" id="footerStat" style="display:none"></div>
    <div class="errbox" id="errBox" style="display:none"></div>
  </div>

  <h2 class="sec-title">✨ 核心能力</h2>
  <div class="caps">
    <div class="cap"><div class="cicon">🧠</div><h3>AI 语义理解变更</h3><p>LLM 解读 diff 的改动意图、风险等级与受影响业务流程，给出建议验证重点；未配置 Key 自动回退确定性启发式，离线 Demo 不受影响。</p></div>
    <div class="cap"><div class="cicon">🧭</div><h3>ReAct 自主规划</h3><p>真正的 Think→Act→Observe 循环 + Function Calling：Agent 自主调用 get_diff / list_test_files / get_module_source 观察事实后规划测什么、怎么测。</p></div>
    <div class="cap"><div class="cicon">🎯</div><h3>精准选测 + 自适应</h3><p>导入图反向可达，只跑受影响测试；首轮失败后自动扩展选测发现隐性影响面、深度复跑确认复现，避免把偶发抖动误报为缺陷。</p></div>
    <div class="cap"><div class="cicon">🧪</div><h3>AI 生成回归测试</h3><p>由失败用例生成回归测试并在缺陷分支真实验证（能复现 bug 才落盘），防幻觉；等价守卫已存在时自动去重复用。</p></div>
    <div class="cap"><div class="cicon">🌐</div><h3>前端体验验证</h3><p>安装 Playwright 后自动在 worktree 起 SUT 服务，用真实浏览器跑 UI 冒烟（结账/优惠券链路）并入报告；未安装则 ⏭ SKIP 不阻断。</p></div>
    <div class="cap"><div class="cicon">🔗</div><h3>平台真闭环</h3><p>TGit MR diff 拉取与评论回写、TAPD 需求/缺陷接入、企微 webhook 异常推送；无凭据时全部自动 dry-run 落盘，评审现场零依赖。</p></div>
  </div>

  <div class="note">
    <b>使用说明</b><br>
    • 本控制台命令：<code>node report/demo-console.mjs</code>（默认 <code>http://127.0.0.1:5180</code>，<code>--port</code> 可改）<br>
    • 场景命令为服务端白名单（与 <code>agent/demo.mjs</code> 一致），页面仅可选择运行哪个场景；同一时间只允许一个场景运行，避免 worktree/端口冲突<br>
    • 被动实时看板（另开终端跑命令时观看）仍可用：<code>node report/live-server.mjs</code> → <code>http://127.0.0.1:5177</code><br>
    • 所有报告均为真实执行结果（本地 git worktree + node --test + API 冒烟 + 可选 Playwright UI 冒烟），未做任何 mock
  </div>
</main>
<div class="toast" id="toast"></div>
<footer>由「AI 测试官」展示控制台提供 · 方向二 · 全链路自动化测试 Agent</footer>
`;

const CLIENT_JS = `
<script>
var grid = document.getElementById('grid');
var timeline = document.getElementById('timeline');
var dot = document.getElementById('dot');
var footerStat = document.getElementById('footerStat');
var errBox = document.getElementById('errBox');
var liveRunName = document.getElementById('liveRunName');
var runAllBtn = document.getElementById('runAllBtn');
var toastEl = document.getElementById('toast');
var es = null;
var phaseNodes = new Map();
var currentOut = null;
var scenarios = [];
var runningId = null;
var doneResolve = null;
var connectSeq = 0;
var runStartTs = 0;

function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(iso){
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  function p(n){ return String(n).padStart(2, '0'); }
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function toast(msg){
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(function(){ toastEl.style.display = 'none'; }, 3200);
}

// ---------- 场景卡片 ----------
function badgeFor(sc){
  if (sc.running) return '<span class="scstatus run">⏳ 运行中…</span>';
  var r = sc.report;
  if (!r || !r.exists) return '<span class="scstatus muted">尚未运行</span>';
  if (r.fail > 0) return '<span class="scstatus bad">🐞 发现 ' + r.fail + ' 个问题</span>';
  return '<span class="scstatus ok">✅ 未发现异常</span>';
}
function barFor(sc){
  var r = sc.report;
  if (sc.running) return '<div class="scbar"><i style="width:100%;background:var(--accent)"></i></div><div class="scnum">正在执行，见下方实时面板…</div>';
  if (!r || !r.exists) return '<div class="scbar"><i style="width:0%"></i></div><div class="scnum">点击「▶ 运行」真实执行该场景</div>';
  var pct = r.total ? Math.round(r.pass / r.total * 100) : 0;
  var color = r.fail > 0 ? '#ff6b81' : '#3ddc97';
  return '<div class="scbar"><i style="width:' + pct + '%;background:' + color + '"></i></div>'
    + '<div class="scnum">上次结果 · ' + r.pass + ' 符合预期 / ' + r.total + ' 总验证项（' + pct + '%）' + (r.generatedAt ? ' · ' + esc(fmtTime(r.generatedAt)) : '') + '</div>';
}
function renderGrid(){
  // 指纹相同则跳过整体重绘：避免 5s 轮询把按钮 DOM 重建，吞掉用户正在进行的点击
  var fp = JSON.stringify([scenarios, runningId, currentOut]);
  if (grid._fp === fp) return;
  grid._fp = fp;
  var html = '';
  for (var i = 0; i < scenarios.length; i++) {
    var sc = scenarios[i];
    var anyRunning = !!runningId;
    html += '<div class="sc' + (sc.running ? ' running' : '') + (currentOut === sc.out ? ' selected' : '') + '" data-id="' + sc.id + '">'
      + '<div class="scrow"><div class="sctitle">' + sc.icon + ' ' + esc(sc.title) + '</div>' + badgeFor(sc) + '</div>'
      + '<div class="scsub">' + esc(sc.sub) + '</div>'
      + '<div><code>' + esc(sc.cmd) + '</code></div>'
      + barFor(sc)
      + '<div class="scbtns">'
      + '<button class="btn" data-act="run" data-id="' + sc.id + '"' + (anyRunning ? ' disabled' : '') + '>' + (sc.running ? '运行中…' : '▶ 运行') + '</button>'
      + '<button class="btn ghost" data-act="live" data-id="' + sc.id + '">📡 实时</button>'
      + '<a class="btnlink' + (sc.report && sc.report.exists && sc.report.hasHtml ? '' : ' disabled') + '" href="./' + sc.out + '.html" target="_blank">📊 查看报告</a>'
      + '</div></div>';
  }
  grid.innerHTML = html;
}

async function loadState(){
  try {
    var res = await fetch('/api/state');
    var st = await res.json();
    scenarios = st.scenarios;
    runningId = st.runningId;
    var chip = document.getElementById('aiChip');
    chip.textContent = st.aiEnabled ? 'AI 语义层 · 已启用' : 'AI 语义层 · 离线回退';
    chip.className = 'chip ' + (st.aiEnabled ? 'ai-on' : 'ai-off');
    renderGrid();
    runAllBtn.disabled = !!runningId;
    return st;
  } catch (e) { return null; }
}

// ---------- 实时面板（事件 schema 与 live-server 一致：meta/phase/log/done） ----------
function iconFor(status){
  if (status === 'done') return '✓';
  if (status === 'warn') return '!';
  if (status === 'error') return '✕';
  return '…';
}
function ensurePhaseEl(ev){
  var key = ev.phase || ('log-' + ev.seq);
  if (phaseNodes.has(key)) return phaseNodes.get(key);
  var emp = timeline.querySelector('.empty');
  if (emp) emp.remove();
  var el = document.createElement('div');
  el.className = 'step ' + (ev.status || 'start');
  el.innerHTML = '<div class="node">' + iconFor(ev.status) + '</div><div class="body">'
    + '<div class="title"><span class="titletext"></span><span class="badge ' + (ev.status === 'done' ? 'done' : 'start') + '">' + (ev.status === 'done' ? '完成' : '进行中') + '</span></div>'
    + '<div class="detail"></div><div class="loglist"></div></div>';
  timeline.appendChild(el);
  phaseNodes.set(key, el);
  return el;
}
function renderEvent(ev){
  if (ev.type === 'meta') return;
  if (ev.type === 'phase') {
    var el = ensurePhaseEl(ev);
    el.className = 'step ' + (ev.status || 'start');
    el.querySelector('.node').textContent = iconFor(ev.status);
    el.querySelector('.titletext').textContent = ev.title || ev.phase;
    var b = el.querySelector('.badge');
    b.className = 'badge ' + (ev.status === 'done' ? 'done' : 'start');
    b.textContent = ev.status === 'done' ? '完成' : '进行中';
    el.querySelector('.detail').textContent = ev.detail || '';
    timeline.scrollTop = timeline.scrollHeight;
    return;
  }
  if (ev.type === 'log') {
    var host = ev.phase ? phaseNodes.get(ev.phase) : null;
    if (!host) { var vals = Array.from(phaseNodes.values()); host = vals[vals.length - 1]; }
    if (!host) host = ensurePhaseEl({ phase: ev.phase || 'log', status: 'start', title: '过程日志' });
    var line = document.createElement('div');
    line.className = 'logline ' + (ev.kind || '');
    line.textContent = ev.detail || '';
    host.querySelector('.loglist').appendChild(line);
    timeline.scrollTop = timeline.scrollHeight;
    return;
  }
  if (ev.type === 'done') {
    dot.classList.remove('live');
    var s = (ev.detail && ev.detail.summary) || {};
    footerStat.style.display = 'flex';
    footerStat.innerHTML =
      '<div class="fs"><b>' + (s.total != null ? s.total : '-') + '</b>总验证项</div>'
      + '<div class="fs pass"><b>' + (s.pass != null ? s.pass : '-') + '</b>符合预期</div>'
      + '<div class="fs fail"><b>' + (s.fail != null ? s.fail : '-') + '</b>发现问题</div>'
      + '<div class="fs" style="display:flex;align-items:center;justify-content:center"><a class="reportlink" href="./' + (ev.detail && ev.detail.reportFile || '') + '" target="_blank">📊 查看完整报告 →</a></div>';
    // 只认本次运行开始之后产生的 done 事件：回放到的上一轮旧 done 不能让"等待完成"提前结束（否则一键运行全部会连锁 409）
    if (doneResolve && (!ev.ts || ev.ts >= runStartTs - 4000)) { var r = doneResolve; doneResolve = null; r(); }
  }
}
function connect(out){
  if (es) es.close();
  currentOut = out;
  var mySeq = ++connectSeq;
  timeline.innerHTML = '<div class="empty"><div class="big">🛰️</div>连接中…</div>';
  footerStat.style.display = 'none';
  errBox.style.display = 'none';
  phaseNodes = new Map();
  liveRunName.textContent = '· ' + out;
  dot.classList.add('live');
  renderGrid();
  es = new EventSource('/events?run=' + encodeURIComponent(out));
  es.onmessage = function(m){ try { renderEvent(JSON.parse(m.data)); } catch (e) {} };
  es.onerror = function(){ dot.classList.remove('live'); };
  // 从未运行过的场景没有事件文件：几秒后仍无事件则明确提示，而不是永远停在"连接中…"
  setTimeout(function(){
    if (mySeq === connectSeq && timeline.querySelector('.empty')) {
      timeline.innerHTML = '<div class="empty"><div class="big">🗂️</div>该场景暂无实时事件记录，点击「▶ 运行」开始一次真实执行</div>';
      dot.classList.remove('live');
    }
  }, 3500);
  document.getElementById('livePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 运行控制 ----------
function waitDone(){
  return new Promise(function(resolve){
    var settled = false;
    function finish(){ if (settled) return; settled = true; clearInterval(t); doneResolve = null; resolve(); }
    // 兜底轮询：若引擎异常退出没写 done 事件，状态接口里 running 消失也算结束
    var t = setInterval(async function(){
      var st = await loadState();
      if (st && !st.runningId) finish();
    }, 3000);
    doneResolve = finish;
  });
}
async function runScenario(id){
  var sc = null;
  for (var i = 0; i < scenarios.length; i++) if (scenarios[i].id === id) sc = scenarios[i];
  if (!sc) return;
  var res = await fetch('/api/run/' + encodeURIComponent(id), { method: 'POST' });
  if (res.status === 409) { toast('已有场景正在运行，请等待其完成'); return; }
  if (!res.ok) { toast('启动失败：HTTP ' + res.status); return; }
  runStartTs = Date.now();
  connect(sc.out);
  await loadState();
  await waitDone();
  var st = await loadState();
  // 绿框高亮刚跑完的场景卡片，明确"是这一个场景更新了结果"，其余卡片仍是历史结果
  var card = grid.querySelector('.sc[data-id="' + id + '"]');
  if (card) { card.classList.add('fresh'); setTimeout(function(){ card.classList.remove('fresh'); }, 8000); }
  // 运行结束后若退出码非 0 且无新报告，展示引擎输出尾部辅助排查
  if (st) {
    for (var j = 0; j < st.scenarios.length; j++) {
      var s2 = st.scenarios[j];
      if (s2.id === id && s2.last && s2.last.exit !== 0 && s2.last.errTail) {
        errBox.style.display = 'block';
        errBox.innerHTML = '⚠️ 执行引擎退出码 ' + s2.last.exit + '，输出尾部：<pre>' + esc(s2.last.errTail) + '</pre>';
      }
    }
  }
}
runAllBtn.addEventListener('click', async function(){
  runAllBtn.disabled = true;
  runAllBtn.textContent = '⏳ 正在依次运行全部场景…';
  var order = ['a', 'b', 'c-healthy', 'c-alert', 'd', 'e'];
  for (var i = 0; i < order.length; i++) {
    await runScenario(order[i]);
    await loadState();
  }
  runAllBtn.textContent = '▶ 一键运行全部场景';
  runAllBtn.disabled = false;
  toast('✅ 全部场景运行完成');
});
grid.addEventListener('click', function(e){
  var t = e.target.closest('[data-act]');
  if (!t) return;
  var id = t.getAttribute('data-id');
  var sc = null;
  for (var i = 0; i < scenarios.length; i++) if (scenarios[i].id === id) sc = scenarios[i];
  if (!sc) return;
  if (t.getAttribute('data-act') === 'run') { if (!runningId) runScenario(id); }
  else connect(sc.out);
});
document.getElementById('refreshBtn').addEventListener('click', async function(){
  this.disabled = true;
  await loadState();
  this.disabled = false;
  toast('状态已刷新');
});
loadState();
setInterval(loadState, 5000);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE + CLIENT_JS);
  }

  // 场景与运行状态
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(statePayload()));
  }

  // 触发场景运行（白名单）
  const runMatch = url.pathname.match(/^\/api\/run\/([\w-]+)$/);
  if (runMatch && req.method === 'POST') {
    const sc = byId[runMatch[1]];
    if (!sc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '未知场景' }));
    }
    if (!startRun(sc)) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '已有场景正在运行', runningId: running?.id }));
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, out: sc.out }));
  }

  // SSE 实时事件流（tail report/.live-<run>.ndjson，先回放历史再增量推送）
  if (url.pathname === '/events') {
    const run = url.searchParams.get('run') || '';
    if (!/^[\w-]+$/.test(run)) {
      res.writeHead(400);
      return res.end('bad run');
    }
    const file = path.join(REPORT_DIR, `.live-${run}.ndjson`);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    let offset = 0;
    const pushNewLines = () => {
      let buf;
      try {
        buf = fs.readFileSync(file, 'utf8');
      } catch {
        return;
      }
      if (buf.length < offset) offset = 0; // 文件被新一轮运行截断重建 → 从头回放，否则会丢掉新运行的前 N 字节
      if (buf.length <= offset) return;
      const chunk = buf.slice(offset);
      offset = buf.length;
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          sendSSE(res, JSON.parse(t));
        } catch {
          /* 忽略半行 JSON */
        }
      }
    };
    pushNewLines();
    const timer = setInterval(pushNewLines, 500);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // 直接打开生成的报告 HTML，便于「查看报告」跳转
  if (/^\/[\w.-]+\.html$/.test(url.pathname)) {
    const file = path.join(REPORT_DIR, url.pathname.slice(1));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(file));
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`🎬 AI 测试官 · 功能展示控制台已启动：http://${HOST}:${PORT}`);
  console.log('   打开页面即可一键运行五场景，并实时观看 Think→Act→Observe 执行过程。');
});
