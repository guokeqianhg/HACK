// AI 测试官 · 实时执行看板服务器
// 用法：node report/live-server.mjs [--port 5177] [--host 127.0.0.1]
// 打开 http://127.0.0.1:<port>/ 后，运行 run-test-officer.mjs / demo.mjs 即可在页面上实时看到
// Think → Act → Observe 的执行过程（阶段时间线 + 逐条日志），无需刷新页面。
//
// 实现：纯 node:http + Server-Sent Events（SSE），零第三方依赖。
// 页面加载时先读取当前已存在的 .live-<run>.ndjson 全部历史行「回放」，之后 tail -f 式增量推送新行，
// 保证「看板晚启动 / 页面刷新」都能补看到从头的完整过程，不会丢事件。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = arr[i + 1];
    m[k] = v === undefined || v.startsWith('--') ? true : v;
  }
  return m;
}, {});
const PORT = Number(args.port || process.env.LIVE_PORT || 5177);
const HOST = args.host || process.env.LIVE_HOST || '127.0.0.1';
// 可视化数据目录（问题四：不再写死 report/）。支持 --dir <path> 或 LIVE_DIR 指向任意目录，
// 看板会扫描该目录下的 .live-*.ndjson 事件流与 *.html 报告，实现"任意路径自动适配"。
const REPORT_DIR = args.dir ? path.resolve(process.cwd(), String(args.dir)) : __dirname;

// 列出当前所有实时事件文件（.live-<run>.ndjson），供页面下拉选择正在跑的是哪个场景
function listRuns() {
  try {
    return fs.readdirSync(REPORT_DIR)
      .filter((f) => /^\.live-.*\.ndjson$/.test(f))
      .map((f) => f.replace(/^\.live-/, '').replace(/\.ndjson$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function sendSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>AI 测试官 · 实时执行看板</title>
<style>
  :root{--bg:#0b0e17;--panel:#12172a;--panel2:#161c33;--line:#232a45;--txt:#e7eaf6;--sub:#8993b8;--accent:#6d8dff;--accent2:#9b7dff;--ok:#3ddc97;--warn:#ffb86b;--err:#ff6b81}
  *{box-sizing:border-box}
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:radial-gradient(1200px 600px at 20% -10%,#1a2148 0%,var(--bg) 55%);color:var(--txt);min-height:100vh}
  header{padding:22px 28px;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--line);background:rgba(18,23,42,.6);backdrop-filter:blur(6px);position:sticky;top:0;z-index:5}
  header h1{margin:0;font-size:18px;font-weight:700;letter-spacing:.3px}
  header .dot{width:9px;height:9px;border-radius:50%;background:var(--sub);box-shadow:0 0 0 0 rgba(61,220,151,.6)}
  header .dot.live{background:var(--ok);animation:pulse 1.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(61,220,151,.55)}70%{box-shadow:0 0 0 9px rgba(61,220,151,0)}100%{box-shadow:0 0 0 0 rgba(61,220,151,0)}}
  select,button{background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer}
  select:hover,button:hover{border-color:var(--accent)}
  main{max-width:1080px;margin:0 auto;padding:26px 28px 60px;display:grid;gap:20px}
  .hint{color:var(--sub);font-size:13px;line-height:1.7}
  .hint code{background:#0d1120;padding:2px 7px;border-radius:5px;color:#b9c3ff}
  .timeline{display:flex;flex-direction:column;gap:0}
  .step{display:grid;grid-template-columns:28px 1fr;gap:14px;position:relative;padding-bottom:22px}
  .step:last-child{padding-bottom:0}
  .step::before{content:'';position:absolute;left:13px;top:28px;bottom:0;width:2px;background:var(--line)}
  .step:last-child::before{display:none}
  .node{width:28px;height:28px;border-radius:50%;background:var(--panel2);border:2px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:12px;z-index:1;transition:.25s}
  .step.start .node{border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 4px rgba(109,141,255,.15)}
  .step.done .node{border-color:var(--ok);background:rgba(61,220,151,.12);color:var(--ok)}
  .step.warn .node{border-color:var(--warn);background:rgba(255,184,107,.12);color:var(--warn)}
  .step.error .node{border-color:var(--err);background:rgba(255,107,129,.12);color:var(--err)}
  .step .body{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .step.start .body{border-color:rgba(109,141,255,.35)}
  .step .title{font-weight:700;font-size:14.5px;display:flex;align-items:center;gap:8px}
  .badge{font-size:10.5px;padding:2px 8px;border-radius:20px;font-weight:600;letter-spacing:.2px}
  .badge.start{background:rgba(109,141,255,.16);color:var(--accent)}
  .badge.done{background:rgba(61,220,151,.16);color:var(--ok)}
  .step .detail{color:#c3cbef;font-size:13px;margin-top:6px;word-break:break-word;line-height:1.6}
  .loglist{margin-top:10px;display:flex;flex-direction:column;gap:6px}
  .logline{font-size:12.5px;color:var(--sub);padding:6px 10px;background:#0d1120;border-radius:8px;border-left:3px solid var(--line);word-break:break-word;animation:fadeIn .25s ease}
  .logline.think{border-left-color:var(--accent2);color:#c9baff}
  .logline.act{border-left-color:var(--accent);color:#b7c6ff}
  .logline.answer{border-left-color:var(--ok);color:#a9f2d2}
  @keyframes fadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
  .empty{color:var(--sub);text-align:center;padding:60px 0;font-size:14px}
  .empty .big{font-size:40px;margin-bottom:10px}
  .footer-stat{display:flex;gap:12px;flex-wrap:wrap}
  .fs{flex:1;min-width:110px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center}
  .fs b{display:block;font-size:24px;margin-bottom:2px}
  .fs.pass b{color:var(--ok)}.fs.fail b{color:var(--err)}
  a.reportlink{display:inline-flex;align-items:center;gap:6px;color:var(--accent);text-decoration:none;font-size:13px;font-weight:600}
  a.reportlink:hover{text-decoration:underline}
</style></head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>🤖 AI 测试官 · 实时执行看板</h1>
  <select id="runSelect"></select>
  <button id="refreshBtn">刷新运行列表</button>
</header>
<main>
  <div class="hint">
    实时订阅 <code>run-test-officer.mjs</code> / <code>cron-monitor.mjs</code> 执行过程中写出的事件流（Think → Act → Observe），无需刷新页面。
    先在终端跑一次 <code>node agent/run-test-officer.mjs --scenario A --out report-A</code>（或 <code>node agent/demo.mjs</code>），再回到本页选择对应运行即可看到实时进度。
  </div>
  <div id="timeline" class="timeline"><div class="empty"><div class="big">🛰️</div>等待运行开始…<br/>在终端执行 AI 测试官命令后，这里会实时出现执行过程</div></div>
  <div class="footer-stat" id="footerStat" style="display:none"></div>
</main>
<script>
const runSelect = document.getElementById('runSelect');
const timeline = document.getElementById('timeline');
const dot = document.getElementById('dot');
const footerStat = document.getElementById('footerStat');
let es = null;
let phaseNodes = new Map(); // phase -> DOM element

function iconFor(status){
  if (status === 'done') return '✓';
  if (status === 'warn') return '!';
  if (status === 'error') return '✕';
  return '…';
}

// 报告链接自动适配：完整 URL（http/https）原样跳转，否则按看板目录内相对路径打开
function reportHref(f){
  if (!f) return '#';
  return /^https?:\/\//i.test(f) ? f : ('./' + f);
}

function ensurePhaseEl(ev){
  const key = ev.phase || ('log-' + ev.seq);
  if (phaseNodes.has(key)) return phaseNodes.get(key);
  timeline.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'step ' + (ev.status || 'start');
  el.innerHTML = '<div class="node">' + iconFor(ev.status) + '</div><div class="body">'
    + '<div class="title"><span class="titletext"></span><span class="badge ' + (ev.status === 'done' ? 'done' : 'start') + '">' + (ev.status === 'done' ? '完成' : '进行中') + '</span></div>'
    + '<div class="detail"></div>'
    + '<div class="loglist"></div>'
    + '</div>';
  timeline.appendChild(el);
  phaseNodes.set(key, el);
  return el;
}

function renderEvent(ev){
  if (ev.type === 'meta') {
    document.title = 'AI 测试官 · ' + (ev.title || '实时看板');
    return;
  }
  if (ev.type === 'phase') {
    const el = ensurePhaseEl(ev);
    el.className = 'step ' + (ev.status || 'start');
    el.querySelector('.node').textContent = iconFor(ev.status);
    el.querySelector('.titletext').textContent = ev.title || ev.phase;
    el.querySelector('.badge').className = 'badge ' + (ev.status === 'done' ? 'done' : 'start');
    el.querySelector('.badge').textContent = ev.status === 'done' ? '完成' : '进行中';
    el.querySelector('.detail').textContent = ev.detail || '';
    return;
  }
  if (ev.type === 'log') {
    // 挂到对应 phase 的日志列表下；找不到 phase 就挂到最后一个节点
    let el = ev.phase ? phaseNodes.get(ev.phase) : null;
    if (!el) el = [...phaseNodes.values()].pop();
    if (!el) { el = ensurePhaseEl({ phase: ev.phase || 'log', status: 'start', title: '过程日志' }); }
    const line = document.createElement('div');
    line.className = 'logline ' + (ev.kind || '');
    line.textContent = ev.detail || '';
    el.querySelector('.loglist').appendChild(line);
    return;
  }
  if (ev.type === 'done') {
    dot.classList.remove('live');
    const s = (ev.detail && ev.detail.summary) || {};
    footerStat.style.display = 'flex';
    footerStat.innerHTML =
      '<div class="fs"><b>' + (s.total ?? '-') + '</b>总用例</div>' +
      '<div class="fs pass"><b>' + (s.pass ?? '-') + '</b>通过</div>' +
      '<div class="fs fail"><b>' + (s.fail ?? '-') + '</b>失败</div>' +
      '<div class="fs" style="display:flex;align-items:center;justify-content:center"><a class="reportlink" href="' + reportHref(ev.detail?.reportFile) + '" target="_blank">📊 查看完整报告 →</a></div>';
  }
}

function connect(run){
  if (es) es.close();
  timeline.innerHTML = '<div class="empty"><div class="big">🛰️</div>连接中…</div>';
  footerStat.style.display = 'none';
  phaseNodes = new Map();
  if (!run) return;
  dot.classList.add('live');
  es = new EventSource('/events?run=' + encodeURIComponent(run));
  es.onmessage = (m) => { try { renderEvent(JSON.parse(m.data)); } catch {} };
  es.onerror = () => { dot.classList.remove('live'); };
}

async function loadRuns(preferSelect){
  const res = await fetch('/runs');
  const runs = await res.json();
  const prev = runSelect.value;
  runSelect.innerHTML = runs.map((r) => '<option value="' + r + '">' + r + '</option>').join('') || '<option value="">（暂无运行记录）</option>';
  const pick = preferSelect || (runs.includes(prev) ? prev : runs[runs.length - 1]);
  if (pick) { runSelect.value = pick; connect(pick); }
}

runSelect.addEventListener('change', () => connect(runSelect.value));
document.getElementById('refreshBtn').addEventListener('click', () => loadRuns());
loadRuns();
// 轮询运行列表（新运行出现时自动可选），不影响当前 SSE 连接
setInterval(() => loadRuns(runSelect.value), 4000);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  if (url.pathname === '/runs') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(listRuns()));
  }

  if (url.pathname === '/events') {
    const run = url.searchParams.get('run') || 'report';
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
      if (buf.length <= offset) return;
      const chunk = buf.slice(offset);
      offset = buf.length;
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          sendSSE(res, JSON.parse(t));
        } catch {
          /* 忽略半行 JSON（正好读到写入中途） */
        }
      }
    };
    pushNewLines(); // 立即回放已有历史事件
    const timer = setInterval(pushNewLines, 500);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // 允许直接打开生成的报告 HTML（相对当前目录），方便看板里点「查看完整报告」跳转
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
  console.log(`🛰️  AI 测试官实时看板已启动：http://${HOST}:${PORT}`);
  console.log(`   数据目录：${REPORT_DIR}${args.dir ? '（--dir 指定）' : '（默认，可用 --dir <path> 指向任意目录）'}`);
  console.log(`   保持此进程运行，另开终端执行 node agent/run-test-officer.mjs ... 或 node agent/demo.mjs 即可实时观察。`);
});
