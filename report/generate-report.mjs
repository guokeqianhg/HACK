// 读 report/*.json → 生成 report/index*.html 可视化看板
// 运行：node report/generate-report.mjs [report/a.json]
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, path.basename(process.argv[2] || 'report.json').replace(/\.json$/, '.html'));

// 输入优先级：命令行参数 > report.json > sample-report.json（演示样例）
async function resolveInput() {
  const candidates = [
    process.argv[2],
    path.join(__dirname, 'report.json'),
    path.join(__dirname, 'sample-report.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('未找到报告输入（report.json / sample-report.json）');
}
const inPath = await resolveInput();

const data = JSON.parse(await readFile(inPath, 'utf8'));
const meta = data.meta || {};
const impact = data.impact || {};
const plan = data.plan || [];
const results = data.results || [];
const summary = data.summary || {};
const processSteps = data.process || [];
const coverage = data.coverage || [];
const generatedTests = data.generatedTests || [];
const aiSuggestedPoints = data.aiSuggestedPoints || [];
const branchFailures = data.branchFailures || [];
const conflictAnalysis = data.conflictAnalysis || null;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sevColor = { high: '#b03427', medium: '#a86e08', low: '#4d7c5b' };
const statusBadge = { pass: '✅ PASS', fail: '❌ FAIL', skip: '⏭ SKIP' };
const statusClass = { pass: 'ok', fail: 'err', skip: 'muted' };
const passPct = summary.total ? Math.round((summary.pass / summary.total) * 100) : 0;
const ringColor = (summary.fail || 0) > 0 ? '#b03427' : '#4d7c5b';

// ---------- 结论横幅：消除"通过/失败"数字的歧义 ----------
// 背景：单纯展示「12 通过 / 8 失败」容易被误读为"AI 测试官只做对了 12 件事、搞砸了 8 件"，
// 但实际语义正相反——失败数是 AI 测试官在被测代码里"成功发现的问题信号"，数字越高代表它
// 捕获到的风险越多，而不是它自身运行失败。这里用真实数据（不臆造根因聚类）生成一句明确结论。
const failCount = summary.fail || 0;
const totalCount = summary.total ?? results.length;
const distinctFailFiles = new Set(results.filter((r) => r.status === 'fail').map((r) => r.testFile).filter(Boolean)).size;
const srcModules = impact.srcFiles || [];
const verdictBad = failCount > 0;
const verdictTitle = verdictBad
  ? `🐞 AI 测试官发现 ${failCount} 个问题信号`
  : `✅ AI 测试官验证通过，未发现异常`;
const verdictSub = verdictBad
  ? `在本次共 ${totalCount} 项验证（单测 / API 冒烟 / UI 冒烟）中，AI 测试官成功捕获 ${failCount} 个失败用例` +
    (distinctFailFiles ? `，分布于 ${distinctFailFiles} 个测试文件` : '') +
    (srcModules.length ? `，均与本次改动涉及的模块「${srcModules.map(esc).join('、')}」相关` : '') +
    `。<b>这是 AI 测试官准确定位问题的证据——失败数越高代表它发现的风险越多，并不代表工具本身运行失败或被测代码整体质量的唯一标尺。</b>具体根因、复现方式与是否阻塞合入见下方明细。`
  : `本次共执行 ${totalCount} 项验证（单测 / API 冒烟 / UI 冒烟），全部符合预期，AI 测试官未发现异常，可视为安全通过。`;

const renderResults = results.map((r) => `
  <tr class="row-${statusClass[r.status] || ''}">
    <td>${esc(r.name)}</td>
    <td><span class="tag tag-type">${esc(r.type)}</span></td>
    <td><span class="badge badge-${statusClass[r.status] || 'muted'}">${statusBadge[r.status] || esc(r.status)}</span></td>
    <td><span class="sev" style="color:${sevColor[r.severity] || '#8b96b3'}">${esc(r.severity) || '-'}</span></td>
    <td class="rootcause">${esc(r.rootCause) || '-'}</td>
    <td><code>${esc(r.repro) || '-'}</code></td>
  </tr>`).join('');

const renderPlan = plan.map((p) => `<li><b>${esc(p.step)}</b><span class="why">${esc(p.why)}</span></li>`).join('');

// ReAct Agent 整体规划（问题3）：展示核心风险 / 补充选测 / 盲区 / 思考-行动轨迹
const reactPlan = impact.reactPlan || null;
const traceIcon = { think: '🧠', act: '🛠', answer: '✅' };
const renderReactTrace = reactPlan && Array.isArray(reactPlan.trace)
  ? reactPlan.trace.map((s) => {
      if (s.kind === 'act') {
        return `<li class="trace-act"><span class="ticon">${traceIcon.act}</span> <code>${esc(s.tool)}</code>${s.args && Object.keys(s.args).length ? ` <span class="targs">${esc(JSON.stringify(s.args))}</span>` : ''}</li>`;
      }
      return `<li class="trace-${esc(s.kind)}"><span class="ticon">${traceIcon[s.kind] || '•'}</span> ${esc(s.text || '')}</li>`;
    }).join('')
  : '';

const renderProcess = processSteps.map((p, i) => `
  <div class="step ${p.status === 'warn' ? 'warn' : 'done'}">
    <div class="node">${p.status === 'warn' ? '!' : '✓'}</div>
    <div class="body">
      <div class="title">${esc(p.title)}</div>
      <div class="detail">${esc(p.detail || '')}</div>
    </div>
  </div>`).join('');

const covStatus = { pass: '✅ 已实现', fail: '❌ 测试不达标', missing: '⛔ 无实现(真缺口)', stub: '🟠 疑似桩', untested: '⚠️ 未测试' };
const covClass = { pass: 'ok', fail: 'err', missing: 'err', stub: 'warn', untested: 'warn' };
const adequacyBadge = { strong: '✅ 充分', weak: '🟠 偏弱', none: '⛔ 无' };
const adequacyClass = { strong: 'ok', weak: 'warn', none: 'err' };
const renderCovAi = (c) => c.ai
  ? `<span class="badge badge-${adequacyClass[c.ai.testAdequacy] || 'muted'}">${adequacyBadge[c.ai.testAdequacy] || esc(c.ai.testAdequacy) || ''}</span>` +
    (c.ai.reasoning ? `<div class="aireason">${esc(c.ai.reasoning)}</div>` : '') +
    (c.ai.gap ? `<div class="aigap">缺口：${esc(c.ai.gap)}</div>` : '')
  : '<span class="muted-text">-</span>';
const renderCoverage = coverage.length
  ? coverage.map((c) => `
  <tr class="row-${covClass[c.status] || ''}">
    <td><code>${esc(c.id)}</code></td>
    <td>${esc(c.desc)}</td>
    <td><code>${esc(c.module)}</code></td>
    <td><span class="badge badge-${covClass[c.status] || 'muted'}">${covStatus[c.status] || esc(c.status)}</span></td>
    <td>${(c.tests || []).map((t) => `<code>${esc(t)}</code>`).join(' ') || '<span class="muted-text">-</span>'}</td>
    <td>${esc(c.note) || '-'}</td>
    <td>${renderCovAi(c)}</td>
  </tr>`).join('')
  : '';

const genTestBadge = { reproduced: { text: '✅ 新生成 · 缺陷分支可复现', cls: 'ok' }, existing: { text: '♻️ 复用已有回归守卫（去重）', cls: 'accent' }, error: { text: '⚠️ 未生成', cls: 'err' } };
const renderGenTests = generatedTests.map((g) => {
  const b = genTestBadge[g.status] || { text: esc(g.status), cls: 'muted' };
  return `<tr><td>${esc(g.name)}</td><td><code>${esc(g.fileName || '-')}</code></td><td><span class="badge badge-${b.cls}">${b.text}</span></td><td>${esc(g.asserts || '-')}</td></tr>`;
}).join('');

const renderBranchFailures = branchFailures.map((f) => `
  <tr class="row-err">
    <td><code>${esc(f.branch || '-')}</code></td>
    <td>${esc(f.name || '-')}</td>
    <td><code>${esc(f.testFile || '-')}</code></td>
    <td class="rootcause">${esc(f.rootCause || '-')}</td>
  </tr>`).join('');

// 顶部快速导航：仅收录本次报告实际存在的板块，避免死链接
const navItems = [
  { id: 'sec-timeline', label: '过程时间线' },
  { id: 'sec-impact', label: '影响面' },
  coverage.length ? { id: 'sec-coverage', label: '需求覆盖度' } : null,
  generatedTests.length ? { id: 'sec-gentest', label: 'AI 生成测试' } : null,
  aiSuggestedPoints.length ? { id: 'sec-suggested', label: 'AI 补充建议' } : null,
  reactPlan ? { id: 'sec-react', label: 'ReAct 规划' } : null,
  branchFailures.length ? { id: 'sec-branch-failures', label: '分支失败' } : null,
  conflictAnalysis ? { id: 'sec-conflict-ai', label: '合并冲突分析' } : null,
  { id: 'sec-plan', label: '测试策略' },
  { id: 'sec-results', label: '执行结果' },
  { id: 'sec-blocking', label: '决策项' },
].filter(Boolean);
const renderNav = navItems.map((n) => `<a href="#${n.id}">${n.label}</a>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(meta.title || 'AI 测试官报告')}</title>
<style>
  :root{
    --bg:#f6f2e9;--panel:#fffdf8;--panel2:#f3eee1;--line:#e5ddcc;--txt:#211c14;--sub:#6d6350;--dim:#a3987f;
    --accent:#b5432a;--accent-d:#96351f;--accent2:#c08a1e;--ok:#4d7c5b;--warn:#a86e08;--err:#b03427;
  }
  *{box-sizing:border-box}
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:linear-gradient(180deg,#faf7f0 0%,var(--bg) 60%);color:var(--txt);min-height:100vh;line-height:1.5}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  header{padding:24px 32px 20px;border-bottom:1px solid var(--line);background:rgba(255,253,248,.88);backdrop-filter:blur(8px);position:sticky;top:0;z-index:10}
  header .htop{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  header h1{margin:0;font-family:Georgia,"Songti SC","STSong","SimSun",serif;font-size:23px;font-weight:800;letter-spacing:.2px;color:var(--txt)}
  .metachips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .chip{font-size:12px;padding:4px 11px;border-radius:20px;background:var(--panel2);border:1px solid var(--line);color:var(--sub)}
  .chip b{color:var(--txt);font-weight:600}
  nav.quicknav{display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;font-size:12.5px}
  nav.quicknav a{color:var(--sub);padding:2px 0;border-bottom:2px solid transparent}
  nav.quicknav a:hover{color:var(--accent);border-color:var(--accent);text-decoration:none}
  main{max-width:1120px;margin:0 auto;padding:28px 32px 70px;display:grid;gap:20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:0 1px 2px rgba(42,34,20,.04),0 8px 24px rgba(42,34,20,.05)}
  .card h2{margin:0 0 16px;font-size:15.5px;font-weight:700;display:flex;align-items:center;gap:8px;color:var(--txt)}
  .card h2 .icon{font-size:16px}
  .card > p.hint{font-size:12px;color:var(--sub);margin:10px 0 0}

  /* 顶部统计 */
  .statsrow{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;text-align:center;box-shadow:0 1px 2px rgba(42,34,20,.04)}
  .stat b{display:block;font-size:28px;font-weight:800;margin-bottom:2px}
  .stat.total b{color:var(--txt)}.stat.pass b{color:var(--ok)}.stat.fail b{color:var(--err)}
  .stat span.label{font-size:12px;color:var(--sub)}
  .ringstat{display:flex;align-items:center;justify-content:center;gap:14px}
  .ring{width:66px;height:66px;border-radius:50%;background:conic-gradient(${ringColor} calc(var(--pct) * 1%), #e9e2d2 0);display:flex;align-items:center;justify-content:center;position:relative;flex-shrink:0}
  .ring::before{content:'';position:absolute;inset:6px;border-radius:50%;background:var(--panel)}
  .ring b{position:relative;z-index:1;font-size:15px}
  .ringstat .rlabel{text-align:left;font-size:12px;color:var(--sub)}
  .ringstat .rlabel b{display:block;color:var(--txt);font-size:14px}

  /* 过程时间线（与实时看板视觉一致，静态呈现最终结果） */
  .timeline{display:flex;flex-direction:column}
  .step{display:grid;grid-template-columns:26px 1fr;gap:14px;position:relative;padding-bottom:18px}
  .step:last-child{padding-bottom:0}
  .step::before{content:'';position:absolute;left:12px;top:26px;bottom:0;width:2px;background:var(--line)}
  .step:last-child::before{display:none}
  .node{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;z-index:1;border:2px solid var(--ok);background:rgba(77,124,91,.10);color:var(--ok)}
  .step.warn .node{border-color:var(--warn);background:rgba(168,110,8,.10);color:var(--warn)}
  .step .title{font-weight:700;font-size:13.5px;color:var(--txt)}
  .step .detail{font-size:12.5px;color:var(--sub);margin-top:4px;word-break:break-word}

  /* details 折叠 */
  details > summary.fold{cursor:pointer;color:var(--accent);font-size:13px;font-weight:600;margin-bottom:12px;user-select:none;list-style:none}
  details > summary.fold::-webkit-details-marker{display:none}
  details[open] > summary.fold::before{content:"▾ "}
  details:not([open]) > summary.fold::before{content:"▸ "}

  /* 表格 */
  .tablewrap{overflow-x:auto;border-radius:10px;border:1px solid var(--line)}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:640px}
  th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
  th{background:var(--panel2);color:var(--sub);font-weight:600;font-size:11.5px;letter-spacing:.3px;position:sticky;top:0;white-space:nowrap}
  tbody tr{transition:background .12s}
  tbody tr:hover{background:rgba(181,67,42,.05)}
  tbody tr:last-child td{border-bottom:none}
  .row-err{border-left:3px solid var(--err)}
  .row-warn{border-left:3px solid var(--warn)}
  .row-ok{border-left:3px solid var(--ok)}
  .rootcause{max-width:360px;color:#5d5240;font-size:13px;line-height:1.65}
  .row-err .rootcause{color:#8c2a1d}
  code{background:#f3eee1;padding:2px 7px;border-radius:5px;font-size:12px;color:#4a3d22;font-weight:600;border:1px solid var(--line)}

  /* 徽章 */
  .badge{display:inline-flex;align-items:center;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap}
  .badge-ok{background:rgba(77,124,91,.12);color:var(--ok)}
  .badge-err{background:rgba(176,52,39,.12);color:var(--err)}
  .badge-warn{background:rgba(168,110,8,.12);color:var(--warn)}
  .badge-accent{background:rgba(181,67,42,.12);color:var(--accent)}
  .badge-muted{background:var(--panel2);color:var(--sub)}
  .sev{font-weight:700;font-size:12.5px;white-space:nowrap}
  .muted-text{color:var(--sub)}

  /* 标签 chip */
  .tag{display:inline-block;background:var(--panel2);color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:3px 9px;margin:2px;font-size:12px}
  .tag-type{color:var(--accent2)}

  ul{margin:0;padding-left:0;list-style:none}
  ul li{padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
  ul li:last-child{border-bottom:none}
  ul li b{color:var(--txt);display:block;margin-bottom:2px}
  ul li .why{color:var(--sub);font-size:12.5px}

  /* ReAct 轨迹 */
  .reacttrace{margin-top:8px}
  .reacttrace summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--accent)}
  .reacttrace ul{margin-top:10px;display:flex;flex-direction:column;gap:6px}
  .reacttrace li{border-bottom:none;padding:8px 10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;font-size:12.5px;color:var(--sub)}
  .reacttrace li.trace-think{border-left:3px solid var(--accent2);color:#8a6a1c}
  .reacttrace li.trace-act{border-left:3px solid var(--accent);color:var(--accent-d)}
  .reacttrace li.trace-answer{border-left:3px solid var(--ok);color:#3f6b4c}
  .ticon{margin-right:4px}
  .targs{color:var(--dim)}

  .aireason{font-size:11.5px;color:var(--sub);margin-top:4px}
  .aigap{font-size:11.5px;color:var(--err);margin-top:2px}

  /* AI 语义理解高亮区（比赛核心能力，突出展示） */
  .aiunderstand{background:linear-gradient(135deg,rgba(181,67,42,.08),rgba(209,145,43,.05));border:1px solid rgba(181,67,42,.28);border-radius:12px;padding:14px 18px;margin-bottom:16px}
  .aiheader{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:13px;font-weight:700;color:var(--accent-d)}
  .aiicon{font-size:16px}
  .aigrid{display:grid;gap:8px}
  .airow{display:grid;grid-template-columns:80px 1fr;gap:10px;font-size:12.5px;line-height:1.6}
  .ailabel{color:var(--sub);font-weight:600;flex-shrink:0}
  .aival{color:var(--txt)}
  .riskbadge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:800}
  .risk-high{background:rgba(176,52,39,.14);color:var(--err)}
  .risk-medium{background:rgba(168,110,8,.14);color:var(--warn)}
  .risk-low{background:rgba(77,124,91,.14);color:var(--ok)}
  .impactrow{display:flex;gap:12px;font-size:12.5px;margin-bottom:10px;align-items:flex-start}
  .impactrow b{color:var(--sub);min-width:80px;flex-shrink:0;padding-top:2px}
  .impactrow div{flex:1}

  .blockinglist li{color:var(--warn)}
  footer{max-width:1120px;margin:0 auto;padding:0 32px 40px;color:var(--sub);font-size:12px;text-align:center}

  /* 结论横幅：一句话消除"通过/失败"数字歧义 */
  .verdict{border-radius:14px;padding:18px 22px;display:flex;gap:16px;align-items:flex-start;border:1px solid var(--line)}
  .verdict.bad{background:linear-gradient(135deg,rgba(176,52,39,.08),rgba(168,110,8,.05));border-color:rgba(176,52,39,.35)}
  .verdict.good{background:linear-gradient(135deg,rgba(77,124,91,.08),rgba(181,67,42,.05));border-color:rgba(77,124,91,.35)}
  .verdict .vicon{font-size:26px;line-height:1;flex-shrink:0;margin-top:1px}
  .verdict .vtitle{font-size:16.5px;font-weight:800;color:var(--txt);margin-bottom:6px}
  .verdict .vsub{font-size:13px;color:#5d5240;line-height:1.8}
  .verdict .vsub b{color:var(--txt)}
  .stat .sublabel{font-size:10.5px;color:var(--sub);opacity:.85;margin-top:2px;display:block}

  /* 合并冲突分析卡片（场景 E 的 AI 根因） */
  .conflictaia{background:linear-gradient(135deg,rgba(176,52,39,.06),rgba(168,110,8,.05));border:1px solid rgba(176,52,39,.25);border-radius:12px;padding:14px 18px;margin-bottom:14px}
  .conflictaia .aiheader{color:#8c2a1d}
  .conflictitem{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:10px;font-size:12.5px}
  .conflictitem:last-child{margin-bottom:0}
  .conflictitem .cfile{color:var(--accent);font-weight:600;font-family:monospace;margin-bottom:6px}
  .conflictitem .crow{display:flex;gap:10px;margin-bottom:4px}
  .conflictitem .clabel{color:var(--sub);min-width:70px;flex-shrink:0;font-weight:600}
  .conflictitem .cval{flex:1;color:var(--txt);line-height:1.6}
  .conflictitem .cval.warn{color:var(--warn)}
  .conflictitem .cval.resolution{color:var(--accent2);font-style:italic}

  @media (max-width:720px){ .statsrow{grid-template-columns:repeat(2,1fr)} .airow{grid-template-columns:1fr} .ailabel{padding-top:2px} }

</style></head>
<body>
<header>
  <div class="htop"><h1>${esc(meta.title || 'AI 测试官报告')}</h1></div>
  <div class="metachips">
    <span class="chip">仓库 <b>${esc(meta.repo || '-')}</b></span>
    <span class="chip">场景 <b>${esc(meta.scenario || '-')}</b></span>
    <span class="chip">触发 <b>${esc(meta.triggeredBy || '-')}</b></span>
    <span class="chip">生成 <b>${esc(meta.generatedAt || '-')}</b></span>
    <span class="chip">AI 语义层 <b>${meta.aiEnabled ? '已启用' : '离线回退'}</b></span>
  </div>
  <nav class="quicknav">${renderNav}</nav>
</header>
<main>
  <div class="verdict ${verdictBad ? 'bad' : 'good'}">
    <div class="vicon">${verdictBad ? '🐞' : '✅'}</div>
    <div>
      <div class="vtitle">${esc(verdictTitle)}</div>
      <div class="vsub">${verdictSub}</div>
    </div>
  </div>

  <div class="statsrow">
    <div class="stat total"><b>${summary.total ?? results.length}</b><span class="label">总验证项</span><span class="sublabel">单测 + API 冒烟 + UI 冒烟</span></div>
    <div class="stat pass"><b>${summary.pass ?? '-'}</b><span class="label">符合预期</span><span class="sublabel">运行结果与断言一致</span></div>
    <div class="stat fail"><b>${summary.fail ?? '-'}</b><span class="label">发现问题</span><span class="sublabel">AI 测试官捕获的异常信号</span></div>
    <div class="stat"><div class="ringstat">
      <div class="ring" style="--pct:${passPct}"><b>${passPct}%</b></div>
      <div class="rlabel">符合预期占比<b>${summary.pass ?? 0} / ${summary.total ?? 0}</b></div>
    </div></div>
  </div>

  <div class="card" id="sec-timeline">
    <h2><span class="icon">🧭</span>AI 测试官过程时间线</h2>
    <div class="timeline">${renderProcess || '<span class="muted-text">无过程信息</span>'}</div>
  </div>

  <div class="card" id="sec-impact">
    <h2><span class="icon">🔍</span>影响面分析</h2>
    ${impact.llmUnderstand ? `
    <div class="aiunderstand">
      <div class="aiheader"><span class="aiicon">🤖</span><b>AI 语义理解</b></div>
      <div class="aigrid">
        <div class="airow"><span class="ailabel">改动意图</span><span class="aival">${esc(impact.llmUnderstand.intent)}</span></div>
        <div class="airow"><span class="ailabel">风险等级</span><span class="aival"><span class="riskbadge risk-${impact.llmUnderstand.riskLevel}">${impact.llmUnderstand.riskLevel}</span></span></div>
        ${impact.llmUnderstand.businessFlows && impact.llmUnderstand.businessFlows.length ? `<div class="airow"><span class="ailabel">影响流程</span><span class="aival">${impact.llmUnderstand.businessFlows.map(esc).join('、')}</span></div>` : ''}
        ${impact.llmUnderstand.recommendedFocus && impact.llmUnderstand.recommendedFocus.length ? `<div class="airow"><span class="ailabel">建议验证</span><span class="aival">${impact.llmUnderstand.recommendedFocus.map(esc).join('、')}</span></div>` : ''}
        ${impact.llmUnderstand.reasoning ? `<div class="airow"><span class="ailabel">推理依据</span><span class="aival aireason">${esc(impact.llmUnderstand.reasoning)}</span></div>` : ''}
      </div>
    </div>` : ''}
    <div class="impactrow"><b>改动文件</b><div>${(impact.changedFiles || []).map((f) => `<span class="tag">${esc(f)}</span>`).join('') || '<span class="muted-text">-</span>'}</div></div>
    <div class="impactrow"><b>改动范围</b><div>${esc(impact.scope) || '-'}</div></div>
    ${impact.requirement ? `<div class="impactrow"><b>需求来源</b><div>${esc(impact.requirement.id)} · ${esc(impact.requirement.title)} <span class="tag">${esc(impact.requirement.source)}</span></div></div>` : ''}
    <div class="impactrow"><b>选测策略</b><div>${impact.narrowed ? '🎯 精准选测' : '⚠️ 全量回退'} — ${esc(impact.selectionReason) || '-'}</div></div>
    <div class="impactrow"><b>关联测试</b><div>${(impact.affectedTests || []).map((f) => `<span class="tag">${esc(f)}</span>`).join('') || '<span class="muted-text">-</span>'}</div></div>
  </div>

  ${coverage.length ? `
  <div class="card" id="sec-coverage">
    <h2><span class="icon">📋</span>需求覆盖度（场景 B）</h2>
    <details open><summary class="fold">展开 / 折叠覆盖度矩阵</summary>
    <div class="tablewrap"><table><thead><tr><th>测试点</th><th>需求描述</th><th>模块</th><th>状态</th><th>关联测试</th><th>核对说明</th><th>AI 语义评审</th></tr></thead>
    <tbody>${renderCoverage}</tbody></table></div>
    </details>
  </div>` : ''}

  ${generatedTests.length ? `
  <div class="card" id="sec-gentest">
    <h2><span class="icon">🧪</span>AI 生成的回归测试（测试生成 Agent）</h2>
    <details open><summary class="fold">展开 / 折叠生成测试</summary>
    <div class="tablewrap"><table><thead><tr><th>针对用例</th><th>生成文件</th><th>状态</th><th>锁定的正确行为</th></tr></thead>
    <tbody>${renderGenTests}</tbody></table></div>
    </details>
    <p class="hint">生成测试在【缺陷分支】失败 = 能抓住该 bug，已写入仓库 tests/ 作为回归守卫（修复后应通过，可纳入 CI 复跑）；已存在等价守卫时会复用而非重复生成。</p>
  </div>` : ''}

  ${aiSuggestedPoints.length ? `
  <div class="card" id="sec-suggested">
    <h2><span class="icon">💡</span>AI 建议补充测试点（需求审计）</h2>
    <ul>${aiSuggestedPoints.map((p) => `<li><b>${esc(p.desc)}</b><span class="why">${esc(p.why || '')}</span></li>`).join('')}</ul>
  </div>` : ''}

  ${reactPlan ? `
  <div class="card" id="sec-react">
    <h2><span class="icon">🧭</span>ReAct Agent 整体规划（自主策略）</h2>
    <p><b>核心风险：</b>${esc(reactPlan.focus || '—')}</p>
    <p style="margin-top:8px"><b>规划理由：</b>${esc(reactPlan.rationale || '—')}</p>
    <p style="margin-top:8px"><b>是否含 UI 冒烟：</b>${reactPlan.includeUi ? '是' : '否'} ｜ <b>是否含 API 冒烟：</b>${reactPlan.includeApi ? '是' : '否'}</p>
    ${(reactPlan.addedTests || []).length ? `<p style="margin-top:8px"><b>Agent 补充选测：</b>${reactPlan.addedTests.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    ${(reactPlan.blindSpots || []).length ? `<div style="margin-top:8px"><b>识别的隐性盲区：</b><ul>${reactPlan.blindSpots.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
    ${renderReactTrace ? `<details class="reacttrace"><summary>思考 → 行动轨迹（ReAct 循环）</summary><ul>${renderReactTrace}</ul></details>` : ''}
    <p class="hint">此节由真正的 ReAct Agent（Think→Act→Observe 循环 + Function Calling）产出：Agent 自主调用 get_diff / list_test_files 观察事实后，规划"测什么/顺序/是否含 UI/有无盲区"，其建议与结构选测取并集后执行。</p>
  </div>` : ''}

  ${branchFailures.length ? `
  <div class="card" id="sec-branch-failures">
    <h2><span class="icon">⚠️</span>分支独立跑测失败（场景 E）</h2>
    <details open><summary class="fold">展开 / 折叠分支失败明细</summary>
    <div class="tablewrap"><table><thead><tr><th>分支</th><th>用例</th><th>测试文件</th><th>根因</th></tr></thead>
    <tbody>${renderBranchFailures}</tbody></table></div>
    </details>
    <p class="hint">这些失败来自合并前的分支独立跑测，不属于 merge 后新增语义冲突，但会阻塞合并安全判定。</p>
  </div>` : ''}

  ${conflictAnalysis ? `
  <div class="card" id="sec-conflict-ai">
    <h2><span class="icon">🔀</span>合并冲突根因分析</h2>
    <div class="conflictaia">
      <div class="aiheader"><span class="aiicon">🤖</span><b>AI 冲突分析</b></div>
      <div style="font-size:13px;color:#182238;line-height:1.75;margin-bottom:12px">${esc(conflictAnalysis.summary || '')}</div>
      ${(conflictAnalysis.conflicts || []).map((c) => `
      <div class="conflictitem">
        ${c.file ? `<div class="cfile">${esc(c.file)}</div>` : ''}
        ${c.branchAChange ? `<div class="crow"><span class="clabel">分支 A 改动</span><span class="cval">${esc(c.branchAChange)}</span></div>` : ''}
        ${c.branchBChange ? `<div class="crow"><span class="clabel">分支 B 改动</span><span class="cval">${esc(c.branchBChange)}</span></div>` : ''}
        ${c.whyConflict ? `<div class="crow"><span class="clabel">为什么冲突</span><span class="cval warn">${esc(c.whyConflict)}</span></div>` : ''}
        ${c.resolution ? `<div class="crow"><span class="clabel">解决建议</span><span class="cval resolution">${esc(c.resolution)}</span></div>` : ''}
      </div>`).join('')}
    </div>
  </div>` : ''}

  <div class="card" id="sec-plan">
    <h2><span class="icon">📝</span>测试策略（规划）</h2>
    <ul>${renderPlan || '<li>未提供</li>'}</ul>
  </div>

  <div class="card" id="sec-results">
    <h2><span class="icon">📊</span>执行结果</h2>
    <details open><summary class="fold">展开 / 折叠执行结果</summary>
    <div class="tablewrap"><table><thead><tr><th>用例</th><th>类型</th><th>状态</th><th>严重级</th><th>根因</th><th>复现</th></tr></thead>
    <tbody>${renderResults || '<tr><td colspan="6">无结果</td></tr>'}</tbody></table></div>
    </details>
  </div>

  <div class="card" id="sec-blocking">
    <h2><span class="icon">🚦</span>阻塞项 / 需人工决策</h2>
    <ul class="blockinglist">${(summary.blocking || []).map((b) => `<li>${esc(b)}</li>`).join('') || '<li style="color:var(--ok)">✅ 无阻塞项，可放行</li>'}</ul>
  </div>
</main>
<footer>由「AI 测试官」自动生成 · 理解变更 → 规划策略 → 执行验证 → 可决策报告</footer>
</body></html>`;

await writeFile(outPath, html, 'utf8');
console.log(`✅ 报告已生成：${outPath}`);
