// 读 report/report.json → 生成 report/index.html 可视化看板
// 运行：node report/generate-report.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inPath = path.join(__dirname, 'report.json');
const outPath = path.join(__dirname, 'index.html');

const data = JSON.parse(await readFile(inPath, 'utf8'));
const meta = data.meta || {};
const impact = data.impact || {};
const plan = data.plan || [];
const results = data.results || [];
const summary = data.summary || {};

const sevColor = { high: '#c0392b', medium: '#e67e22', low: '#2b8a3e' };
const statusBadge = { pass: '✅ PASS', fail: '❌ FAIL', skip: '⏭ SKIP' };

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

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${meta.title || 'AI 测试官报告'}</title>
<style>
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:#f5f6f8;color:#1f2329}
  header{background:#2b5fff;color:#fff;padding:18px 24px}
  header h1{margin:0;font-size:20px}
  .meta{opacity:.85;font-size:13px;margin-top:6px}
  main{max-width:1080px;margin:0 auto;padding:24px;display:grid;gap:18px}
  .card{background:#fff;border:1px solid #e5e6eb;border-radius:10px;padding:16px}
  .summary{display:flex;gap:14px}
  .stat{flex:1;text-align:center;border-radius:8px;padding:12px;color:#fff}
  .stat.total{background:#34495e}.stat.pass{background:#2b8a3e}.stat.fail{background:#c0392b}
  .stat b{display:block;font-size:26px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}
  th{background:#fafafa}
  code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#2b5fff;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px}
  ul{margin:0;padding-left:18px}
</style></head>
<body>
<header><h1>🤖 ${meta.title || 'AI 测试官报告'}</h1>
<div class="meta">仓库：${meta.repo || '-'} ｜ 场景：${meta.scenario || '-'} ｜ 触发：${meta.triggeredBy || '-'} ｜ 生成：${meta.generatedAt || '-'}</div>
</header>
<main>
  <div class="summary">
    <div class="stat total"><b>${summary.total ?? results.length}</b>总用例</div>
    <div class="stat pass"><b>${summary.pass ?? '-'}</b>通过</div>
    <div class="stat fail"><b>${summary.fail ?? '-'}</b>失败</div>
  </div>

  <div class="card">
    <h2>影响面分析</h2>
    <div>${(impact.changedFiles || []).map((f) => `<span class="tag">${f}</span>`).join('')}</div>
    <p><b>风险：</b>${impact.risk || '-'}</p>
    <p><b>可能受影响：</b>${(impact.affectedScenarios || []).map((s) => `<span class="tag">${s}</span>`).join('') || '-'}</p>
  </div>

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
