// AI 测试官 · 离线一键 Demo（串起场景 A / B / C）
// 零依赖：纯本地 git + node --test + node smoke/api-smoke.mjs，评审现场可直接跑。
//
// 运行：node agent/demo.mjs
// 产物：
//   report/report-A.html        场景 A：代码改动 → 针对性测试
//   report/report-B.html        场景 B：需求文档 → 覆盖度报告
//   report/report-C-healthy.html 场景 C：定时巡检（健康基线）
//   report/report-C-alert.html    场景 C：定时巡检（异常告警）
//   report/index-demo.html     本总览页（聚合入口）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'report');

function runNode(args) {
  return new Promise((res) => {
    const p = spawn('node', args, { cwd: ROOT, windowsHide: true });
    p.stdout.on('data', (d) => process.stdout.write(d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', (c) => res(c));
  });
}

function readReport(base) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${base}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function scenarioCard(title, sub, base, report) {
  const s = report?.summary || {};
  const ok = s.fail === 0;
  const badge = !s.total ? '—' : ok ? '✅ 通过' : `❌ ${s.fail} 失败`;
  return `
  <a class="sc" href="./${base}.html">
    <div class="sctitle">${title}</div>
    <div class="scsub">${sub}</div>
    <div class="scstatus ${ok ? 'ok' : 'bad'}">${badge} <span>${s.pass ?? 0}通过 / ${s.total ?? 0}总</span></div>
  </a>`;
}

async function main() {
  console.log('\n========== AI 测试官 · 离线三场景一键 Demo ==========\n');

  console.log('▶ 场景 A：代码改动 → 针对性测试（feature/coupon-bug）');
  await runNode(['agent/run-test-officer.mjs', '--repo', 'sample-app', '--base', 'main', '--target', 'feature/coupon-bug', '--scenario', 'A', '--out', 'report-A', '--triggeredBy', 'Demo · 场景A 代码改动']);

  console.log('\n▶ 场景 B：需求文档（Markdown requirement.md）→ 覆盖度报告');
  await runNode(['agent/run-test-officer.mjs', '--repo', 'sample-app', '--base', 'main', '--target', 'feature/coupon-bug', '--scenario', 'B', '--requirement', 'sample-app/docs/requirement.md', '--out', 'report-B', '--triggeredBy', 'Demo · 场景B 需求驱动']);

  console.log('\n▶ 场景 C：定时巡检（健康基线 @main）');
  await runNode(['agent/cron-monitor.mjs', '--branch', 'main', '--out', 'report-C-healthy', '--triggeredBy', 'Demo · 场景C 巡检']);
  console.log('\n▶ 场景 C：定时巡检（异常告警 @feature/coupon-bug）');
  await runNode(['agent/cron-monitor.mjs', '--branch', 'feature/coupon-bug', '--out', 'report-C-alert', '--triggeredBy', 'Demo · 场景C 巡检']);

  // 聚合总览页
  const a = readReport('report-A');
  const b = readReport('report-B');
  const ch = readReport('report-C-healthy');
  const ca = readReport('report-C-alert');

  const cards = [
    scenarioCard('场景 A · 代码改动', '读 diff → 精准选测 → 真实跑测', 'report-A', a),
    scenarioCard('场景 B · 需求驱动', '读需求 → 拆解测试点 → 覆盖度', 'report-B', b),
    scenarioCard('场景 C · 巡检基线', '定时全量回归（健康）', 'report-C-healthy', ch),
    scenarioCard('场景 C · 异常告警', '定时全量回归（发现 bug）', 'report-C-alert', ca),
  ].join('');

  // 注意：computeCoverage 实际产出的状态值是 pass/fail/untested/stub/missing（无 'gap'），
  // 缺口 = missing（无实现）+ stub（疑似桩）+ untested（有实现无测试）之和
  const cov = b?.coverage || [];
  const gapCount = cov.filter((c) => ['missing', 'stub', 'untested'].includes(c.status)).length;
  const covLine = cov.length
    ? `需求覆盖度：${cov.filter((c) => c.status === 'pass').length} 已覆盖 / ${gapCount} 缺口 / ${cov.filter((c) => c.status === 'fail').length} 不达标`
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>AI 测试官 · 离线 Demo 总览</title>
<style>
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:#0f1320;color:#e8eaed}
  header{background:linear-gradient(135deg,#2b5fff,#7b5fff);color:#fff;padding:28px 32px}
  header h1{margin:0;font-size:24px}
  header p{opacity:.9;margin:8px 0 0}
  main{max-width:1080px;margin:0 auto;padding:28px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
  .sc{display:block;background:#1a1f30;border:1px solid #2a3148;border-radius:12px;padding:16px;text-decoration:none;color:inherit;transition:.15s}
  .sc:hover{border-color:#2b5fff;transform:translateY(-2px)}
  .sctitle{font-size:16px;font-weight:700}
  .scsub{font-size:12px;color:#9aa3b2;margin:6px 0 12px}
  .scstatus{display:inline-flex;gap:8px;align-items:center;font-size:13px;font-weight:600;padding:4px 10px;border-radius:20px}
  .scstatus.ok{background:#14361f;color:#5fd98a}
  .scstatus.bad{background:#3a1717;color:#ff8a8a}
  .note{margin-top:22px;padding:14px 18px;background:#1a1f30;border-left:4px solid #7b5fff;border-radius:8px;font-size:13px;color:#c3c9d6;line-height:1.7}
  code{background:#0f1320;padding:2px 6px;border-radius:4px}
</style></head>
<body>
<header><h1>🤖 AI 测试官 · 离线三场景 Demo 总览</h1>
<p>零依赖本地闭环：理解变更 → 规划选测 → 真实跑测 → 可决策报告。点击下方任一卡片查看详细报告。</p></header>
<main>
  <div class="grid">${cards}</div>
  <div class="note">
    <b>场景映射</b><br>
    • 场景 A（代码改动）：<code>run-test-officer --scenario A</code> —— diff 驱动，导入图反向可达精准选测<br>
    • 场景 B（需求驱动）：<code>run-test-officer --scenario B --requirement …</code> —— 需求点映射实现，产出覆盖度<br>
    • 场景 C（持续巡检）：<code>cron-monitor</code> —— 定时全量回归，异常经企微 webhook 推送（dry-run 落盘）<br><br>
    ${covLine ? `📋 ${covLine}<br>` : ''}
    🔗 所有报告均为真实执行结果（本地 git worktree + node --test + API 冒烟），未做任何 mock。
  </div>
</main>
</body></html>`;

  fs.writeFileSync(path.join(REPORT_DIR, 'index-demo.html'), html, 'utf8');
  console.log(`\n✅ Demo 完成，总览页：report/index-demo.html`);
  console.log('   分别打开 report-A.html / report-B.html / report-C-healthy.html / report-C-alert.html 查看各场景详情。');
}

main().catch((e) => {
  console.error('❌ Demo 失败:', e.message);
  process.exit(1);
});
