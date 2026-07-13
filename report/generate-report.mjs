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
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sevColor = { high: '#c0392b', medium: '#e67e22', low: '#2b8a3e' };
const statusBadge = { pass: '✅ PASS', fail: '❌ FAIL', skip: '⏭ SKIP' };
const passPct = summary.total ? Math.round((summary.pass / summary.total) * 100) : 0;

const renderResults = results.map((r) => `
  <tr>
    <td>${r.name}</td>
    <td>${r.type}</td>
    <td><b>${statusBadge[r.status] || r.status}</b></td>
    <td style="color:${sevColor[r.severity] || '#555'}">${r.severity || '-'}</td>
    <td>${r.rootCause || '-'}</td>
    <td><code>${r.repro || '-'}</code></td>
  </tr>`).join('');

const renderPlan = plan.map((p) => `<li><b>${p.step}</b> — ${p.why}</li>`).join('');

// ReAct Agent 整体规划（问题3）：展示核心风险 / 补充选测 / 盲区 / 思考-行动轨迹
const reactPlan = impact.reactPlan || null;
const traceIcon = { think: '🧠 思考', act: '🛠 调用工具', answer: '✅ 结论' };
const renderReactTrace = reactPlan && Array.isArray(reactPlan.trace)
  ? reactPlan.trace.map((s) => {
      if (s.kind === 'act') {
        return `<li><b>${traceIcon.act}</b> <code>${esc(s.tool)}</code>${s.args && Object.keys(s.args).length ? ` <span style="color:#888">${esc(JSON.stringify(s.args))}</span>` : ''}</li>`;
      }
      return `<li><b>${traceIcon[s.kind] || s.kind}</b> ${esc(s.text || '')}</li>`;
    }).join('')
  : '';

const renderProcess = processSteps.map((p, i) => `
  <div class="phase ${p.status}">
    <div class="pdot">${p.status === 'warn' ? '!' : i + 1}</div>
    <div class="ptitle">${p.title}</div>
    <div class="pdetail">${p.detail || ''}</div>
  </div>`).join('');

const covStatus = { pass: '✅ 已实现', fail: '❌ 测试不达标', missing: '⛔ 无实现(真缺口)', stub: '🟠 疑似桩', untested: '⚠️ 未测试' };
const adequacyBadge = { strong: '✅ 充分', weak: '🟠 偏弱', none: '⛔ 无' };
const renderCovAi = (c) => c.ai
  ? `<b style="color:${c.ai.testAdequacy === 'strong' ? '#2b8a3e' : c.ai.testAdequacy === 'weak' ? '#e67e22' : '#c0392b'}">${adequacyBadge[c.ai.testAdequacy] || c.ai.testAdequacy || ''}</b>` +
    (c.ai.reasoning ? `<div style="font-size:11px;color:#555">${esc(c.ai.reasoning)}</div>` : '') +
    (c.ai.gap ? `<div style="font-size:11px;color:#c0392b">缺口：${esc(c.ai.gap)}</div>` : '')
  : '-';
const renderCoverage = coverage.length
  ? coverage.map((c) => `
  <tr class="cov-${c.status}">
    <td>${c.id}</td>
    <td>${esc(c.desc)}</td>
    <td><code>${esc(c.module)}</code></td>
    <td><b>${covStatus[c.status] || c.status}</b></td>
    <td>${(c.tests || []).map((t) => `<code>${esc(t)}</code>`).join(' ') || '-'}</td>
    <td>${esc(c.note) || '-'}</td>
    <td>${renderCovAi(c)}</td>
  </tr>`).join('')
  : '';

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${meta.title || 'AI 测试官报告'}</title>
<style>
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:#f5f6f8;color:#1f2329}
  header{background:linear-gradient(135deg,#2b5fff,#7b5fff);color:#fff;padding:18px 24px}
  header h1{margin:0;font-size:20px}
  .meta{opacity:.9;font-size:13px;margin-top:6px}
  main{max-width:1080px;margin:0 auto;padding:24px;display:grid;gap:18px}
  .card{background:#fff;border:1px solid #e5e6eb;border-radius:10px;padding:16px}
  .card h2{margin:0 0 12px;font-size:16px}
  .summary{display:flex;gap:14px;flex-wrap:wrap}
  .stat{flex:1;min-width:120px;text-align:center;border-radius:8px;padding:12px;color:#fff}
  .stat.total{background:#34495e}.stat.pass{background:#2b8a3e}.stat.fail{background:#c0392b}
  .stat b{display:block;font-size:26px}
  .bar{height:10px;background:#eee;border-radius:6px;overflow:hidden;margin-top:8px}
  .bar > i{display:block;height:100%;background:#2b8a3e}
  /* 过程时间线 */
  .timeline{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}
  .phase{flex:1;min-width:150px;background:#fafbff;border:1px solid #e5e6eb;border-radius:10px;padding:12px;position:relative}
  .phase.done{border-left:4px solid #2b8a3e}
  .phase.warn{border-left:4px solid #e67e22;background:#fff8f1}
  .pdot{width:22px;height:22px;border-radius:50%;background:#2b5fff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-bottom:8px}
  .phase.warn .pdot{background:#e67e22}
  .ptitle{font-weight:600;font-size:14px}
  .pdetail{font-size:12px;color:#555;margin-top:4px;word-break:break-all}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}
  th{background:#fafafa}
  code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#2b5fff;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px}
  ul{margin:0;padding-left:18px}
  .cov-pass td:nth-child(4){color:#2b8a3e}
  .cov-fail td:nth-child(4){color:#c0392b}
  .cov-missing td:nth-child(4){color:#c0392b}
  .cov-stub td:nth-child(4){color:#e67e22}
  .cov-untested td:nth-child(4){color:#e67e22}
</style></head>
<body>
<header><h1>🤖 ${meta.title || 'AI 测试官报告'}</h1>
<div class="meta">仓库：${meta.repo || '-'} ｜ 场景：${meta.scenario || '-'} ｜ 触发：${meta.triggeredBy || '-'} ｜ 生成：${meta.generatedAt || '-'}</div>
</header>
<main>
  <div class="card">
    <h2>AI 测试官过程时间线</h2>
    <div class="timeline">${renderProcess || '<span>无过程信息</span>'}</div>
  </div>

  <div class="summary">
    <div class="stat total"><b>${summary.total ?? results.length}</b>总用例</div>
    <div class="stat pass"><b>${summary.pass ?? '-'}</b>通过</div>
    <div class="stat fail"><b>${summary.fail ?? '-'}</b>失败</div>
    <div class="stat total" style="background:#7b5fff"><b>${passPct}%</b>通过率<div class="bar"><i style="width:${passPct}%"></i></div></div>
  </div>

  <div class="card">
    <h2>影响面分析</h2>
    <div><b>改动文件：</b>${(impact.changedFiles || []).map((f) => `<span class="tag">${f}</span>`).join('') || '-'}</div>
    <p><b>改动范围：</b>${impact.scope || '-'}</p>
    ${impact.requirement ? `<p><b>需求来源：</b>${impact.requirement.id} · ${impact.requirement.title}<br><span class="tag">${impact.requirement.source}</span></p>` : ''}
    <p><b>选测策略：</b>${impact.narrowed ? '🎯 精准选测' : '⚠️ 全量回退'} — ${impact.selectionReason || '-'}</p>
    <p><b>关联测试文件：</b>${(impact.affectedTests || []).map((f) => `<span class="tag">${f}</span>`).join('') || '-'}</p>
  </div>

  ${coverage.length ? `
  <div class="card">
    <h2>需求覆盖度（场景 B）</h2>
    <table><thead><tr><th>测试点</th><th>需求描述</th><th>模块</th><th>状态</th><th>关联测试</th><th>核对说明</th><th>AI 语义评审</th></tr></thead>
    <tbody>${renderCoverage}</tbody></table>
  </div>` : ''}

  ${generatedTests.length ? `
  <div class="card">
    <h2>AI 生成的回归测试（测试生成 Agent）</h2>
    <table><thead><tr><th>针对用例</th><th>生成文件</th><th>状态</th><th>锁定的正确行为</th></tr></thead>
    <tbody>${generatedTests.map((g) => `<tr><td>${esc(g.name)}</td><td><code>${esc(g.fileName || '-')}</code></td><td><b style="color:${g.status === 'reproduced' ? '#2b8a3e' : '#c0392b'}">${g.status === 'reproduced' ? '✅ 缺陷分支可复现' : '⚠️ 未生成'}</b></td><td>${esc(g.asserts || '-')}</td></tr>`).join('')}</tbody></table>
    <p style="font-size:12px;color:#555">生成测试在【缺陷分支】失败 = 能抓住该 bug，已写入仓库 tests/ 作为回归守卫（修复后应通过，可纳入 CI 复跑）。</p>
  </div>` : ''}

  ${aiSuggestedPoints.length ? `
  <div class="card">
    <h2>AI 建议补充测试点（需求审计）</h2>
    <ul>${aiSuggestedPoints.map((p) => `<li><b>${esc(p.desc)}</b> — ${esc(p.why || '')}</li>`).join('')}</ul>
  </div>` : ''}

  ${reactPlan ? `
  <div class="card">
    <h2>🧭 ReAct Agent 整体规划（自主策略）</h2>
    <p><b>核心风险：</b>${esc(reactPlan.focus || '—')}</p>
    <p><b>规划理由：</b>${esc(reactPlan.rationale || '—')}</p>
    <p><b>是否含 UI 冒烟：</b>${reactPlan.includeUi ? '是' : '否'} ｜ <b>是否含 API 冒烟：</b>${reactPlan.includeApi ? '是' : '否'}</p>
    ${(reactPlan.addedTests || []).length ? `<p><b>Agent 补充选测：</b>${reactPlan.addedTests.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    ${(reactPlan.blindSpots || []).length ? `<div><b>识别的隐性盲区：</b><ul>${reactPlan.blindSpots.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
    ${renderReactTrace ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">思考 → 行动轨迹（ReAct 循环）</summary><ul style="margin-top:8px">${renderReactTrace}</ul></details>` : ''}
    <p style="font-size:12px;color:#555">此节由真正的 ReAct Agent（Think→Act→Observe 循环 + Function Calling）产出：Agent 自主调用 get_diff / list_test_files 观察事实后，规划"测什么/顺序/是否含 UI/有无盲区"，其建议与结构选测取并集后执行。</p>
  </div>` : ''}

  <div class="card">
    <h2>测试策略（规划）</h2>
    <ul>${renderPlan || '<li>未提供</li>'}</ul>
  </div>

  <div class="card">
    <h2>执行结果</h2>
    <table><thead><tr><th>用例</th><th>类型</th><th>状态</th><th>严重级</th><th>根因</th><th>复现</th></tr></thead>
    <tbody>${renderResults || '<tr><td colspan="6">无结果</td></tr>'}</tbody></table>
  </div>

  <div class="card">
    <h2>阻塞项 / 需人工决策</h2>
    <ul>${(summary.blocking || []).map((b) => `<li>${b}</li>`).join('') || '<li>无</li>'}</ul>
  </div>
</main>
</body></html>`;

await writeFile(outPath, html, 'utf8');
console.log(`✅ 报告已生成：${outPath}`);
