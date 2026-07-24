// AI 测试官 · 离线一键 Demo（串起场景 A / B / C / D / E）
// 零依赖：纯本地 git + node --test + node smoke/api-smoke.mjs，评审现场可直接跑。
//
// 运行：node agent/demo.mjs
// 产物：
//   report/report-A.html        场景 A：代码改动 → 针对性测试
//   report/report-B.html        场景 B：需求文档 → 覆盖度报告
//   report/report-C-healthy.html 场景 C：定时巡检（健康基线）
//   report/report-C-alert.html    场景 C：定时巡检（异常告警）
//   report/report-D.html        场景 D：Bug 修复闭环验证
//   report/report-E.html        场景 E：合并冲突检测（语义冲突）
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
  const pct = s.total ? Math.round((s.pass / s.total) * 100) : 0;
  // 措辞说明：ok=false 时不是"这个 Demo 场景跑失败了"，而是"AI 测试官在这个场景里真的抓到了 bug"——
  // 用"发现 N 个问题"而非"N 失败"，避免被误读为工具本身运行出错。
  const badge = !s.total ? '—' : ok ? '✅ 未发现异常' : `🐞 发现 ${s.fail} 个问题`;
  return `
  <a class="sc ${ok ? 'sc-ok' : 'sc-bad'}" href="./${base}.html">
    <div class="scrow"><div class="sctitle">${title}</div><div class="scstatus ${ok ? 'ok' : 'bad'}">${badge}</div></div>
    <div class="scsub">${sub}</div>
    <div class="scbar"><i style="width:${pct}%;background:${ok ? '#3ddc97' : '#ff6b81'}"></i></div>
    <div class="scnum">${s.pass ?? 0} 符合预期 / ${s.total ?? 0} 总验证项（${pct}%）</div>
  </a>`;
}

// 执行调度：默认串行（并发 1）。
// 说明：LLM 端点有 RPM 限流（实测 60 RPM），而每个场景本身就有 6+ 次 LLM 调用，
//   并行多场景会瞬间超限触发 429，反而因退避重试大幅变慢——故默认串行最稳。
//   仅在「离线模式（未配 LLM Key）」或明确知道端点无限流时，才值得用 DEMO_CONCURRENCY>1 提速。
async function runPool(jobs, concurrency) {
  const results = new Array(jobs.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const i = cursor++;
      const job = jobs[i];
      console.log(`▶ ${job.label}`);
      results[i] = await runNode(job.args);
      console.log(`✓ ${job.label} 完成（exit ${results[i]}）`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

async function main() {
  console.log('\n========== AI 测试官 · 离线五场景一键 Demo ==========\n');
  const concurrency = Number(process.env.DEMO_CONCURRENCY || 1);
  console.log(`（并发度 ${concurrency}；默认串行避免 LLM 限流，离线模式可设 DEMO_CONCURRENCY=3 提速）\n`);

  // 六个场景任务（互相独立，各写各的 report-*.json）
  // 沙箱 clone 后 sample-app 在 case1/ 下；本地兼容两个目录名
  const localRepo = (() => {
    const root = path.join(__dirname, '..');
    for (const d of ['case1', 'sample-app']) { try { if (fs.statSync(path.join(root, d)).isDirectory()) return d; } catch { /* 不存在 */ } }
    return 'case1';
  })();
  const jobs = [
    { label: '场景 A：代码改动 → 针对性测试（feature/coupon-bug）',
      args: ['agent/run-test-officer.mjs', '--repo', localRepo, '--base', 'main', '--target', 'feature/coupon-bug', '--scenario', 'A', '--out', 'report-A', '--triggeredBy', 'Demo · 场景A 代码改动'] },
    { label: '场景 B：需求文档 → 覆盖度报告',
      args: ['agent/run-test-officer.mjs', '--repo', localRepo, '--base', 'main', '--target', 'main', '--scenario', 'B', '--requirement', `${localRepo}/docs/requirement.md`, '--out', 'report-B', '--triggeredBy', 'Demo · 场景B 需求驱动'] },
    { label: '场景 C：定时巡检（健康基线 @main）',
      args: ['agent/cron-monitor.mjs', '--branch', 'main', '--out', 'report-C-healthy', '--triggeredBy', 'Demo · 场景C 巡检'] },
    { label: '场景 C：定时巡检（异常告警 @feature/coupon-bug）',
      args: ['agent/cron-monitor.mjs', '--branch', 'feature/coupon-bug', '--out', 'report-C-alert', '--triggeredBy', 'Demo · 场景C 巡检'] },
    { label: '场景 D：Bug 修复闭环验证（feature/coupon-bug → main）',
      args: ['agent/run-test-officer.mjs', '--repo', localRepo, '--base', 'feature/coupon-bug', '--target', 'main', '--scenario', 'D', '--requirement', `${localRepo}/docs/requirement.md`, '--out', 'report-D', '--triggeredBy', 'Demo · 场景D 修复验证'] },
    { label: '场景 E：合并冲突检测（refund-guard + floor-guard）',
      args: ['agent/run-test-officer.mjs', '--repo', localRepo, '--base', 'main', '--target', 'feature/coupon-refund-guard', '--merge', 'feature/coupon-floor-guard', '--scenario', 'E', '--out', 'report-E', '--triggeredBy', 'Demo · 场景E 合并冲突检测'] },
  ];
  await runPool(jobs, concurrency);
  console.log('\n所有场景执行完毕，生成聚合总览页…\n');


  // 聚合总览页
  const a = readReport('report-A');
  const b = readReport('report-B');
  const ch = readReport('report-C-healthy');
  const ca = readReport('report-C-alert');
  const d = readReport('report-D');
  const e = readReport('report-E');

  const cards = [
    scenarioCard('场景 A · 代码改动', '读 diff → 精准选测 → 真实跑测', 'report-A', a),
    scenarioCard('场景 B · 需求驱动', '读需求 → 拆解测试点 → 覆盖度', 'report-B', b),
    scenarioCard('场景 C · 巡检基线', '定时全量回归（健康）', 'report-C-healthy', ch),
    scenarioCard('场景 C · 异常告警', '定时全量回归（发现 bug）', 'report-C-alert', ca),
    scenarioCard('场景 D · Bug修复验证', '缺陷基线 fail → 修复分支 pass → 判定是否修好', 'report-D', d),
    scenarioCard('场景 E · 合并冲突检测', '两个分支各自通过 → 合并后语义冲突', 'report-E', e),
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
  :root{--bg:#0b0e17;--panel:#12172a;--panel2:#161c33;--line:#232a45;--txt:#e7eaf6;--sub:#8993b8;--accent:#6d8dff;--accent2:#9b7dff;--ok:#3ddc97;--err:#ff6b81}
  *{box-sizing:border-box}
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:radial-gradient(1200px 620px at 15% -10%,#1a2148 0%,var(--bg) 55%);color:var(--txt);min-height:100vh}
  header{padding:32px 32px 26px;border-bottom:1px solid var(--line);background:rgba(18,23,42,.4)}
  header h1{margin:0;font-size:25px;font-weight:800;background:linear-gradient(135deg,#c9d4ff,#e8d9ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  header p{opacity:.85;margin:10px 0 0;font-size:13.5px;color:var(--sub);max-width:680px;line-height:1.7}
  .livebadge{display:inline-flex;align-items:center;gap:7px;margin-top:14px;font-size:12.5px;padding:7px 14px;border-radius:20px;background:rgba(109,141,255,.12);border:1px solid rgba(109,141,255,.35);color:var(--accent)}
  .livebadge .lb-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:pulse 1.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(61,220,151,.55)}70%{box-shadow:0 0 0 7px rgba(61,220,151,0)}100%{box-shadow:0 0 0 0 rgba(61,220,151,0)}}
  main{max-width:1080px;margin:0 auto;padding:30px 32px 60px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
  .sc{display:block;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;text-decoration:none;color:inherit;transition:.18s}
  .sc:hover{transform:translateY(-3px);box-shadow:0 10px 26px rgba(0,0,0,.35)}
  .sc-ok:hover{border-color:var(--ok)}
  .sc-bad:hover{border-color:var(--err)}
  .scrow{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .sctitle{font-size:15.5px;font-weight:700}
  .scsub{font-size:12.5px;color:var(--sub);margin:8px 0 12px}
  .scstatus{font-size:12px;font-weight:700;padding:4px 11px;border-radius:20px;white-space:nowrap}
  .scstatus.ok{background:rgba(61,220,151,.14);color:var(--ok)}
  .scstatus.bad{background:rgba(255,107,129,.14);color:var(--err)}
  .scbar{height:6px;background:var(--line);border-radius:6px;overflow:hidden}
  .scbar i{display:block;height:100%;border-radius:6px}
  .scnum{font-size:11.5px;color:var(--sub);margin-top:7px}
  .note{margin-top:24px;padding:18px 20px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:12px;font-size:13px;color:#c3cbef;line-height:1.9}
  .note b{color:#f1f3ff}
  code{background:#0d1120;padding:2px 7px;border-radius:5px;color:#b9c3ff;border:1px solid var(--line);font-size:12px}
</style></head>
<body>
<header>
  <h1>🤖 AI 测试官 · 离线五场景 Demo 总览</h1>
  <p>零依赖本地闭环：理解变更 → 规划选测 → 真实跑测 → 可决策报告。点击下方任一卡片查看详细报告。</p>
  <div class="livebadge"><span class="lb-dot"></span>实时看板：另开终端执行 <code>node report/live-server.mjs</code> 后打开 <code>http://127.0.0.1:5177</code>，可实时观看 Think→Act→Observe 执行过程</div>
</header>
<main>
  <div class="grid">${cards}</div>
  <div class="note">
    <b>场景映射</b><br>
    • 场景 A（代码改动）：<code>run-test-officer --scenario A</code> —— diff 驱动，导入图反向可达精准选测<br>
    • 场景 B（需求驱动）：<code>run-test-officer --scenario B --requirement …</code> —— 需求点映射实现，产出覆盖度<br>
    • 场景 C（持续巡检）：<code>cron-monitor</code> —— 定时全量回归，异常经企微 webhook 推送（dry-run 落盘）<br>
    • 场景 D（Bug修复验证）：<code>run-test-officer --scenario D --bug …</code> —— 缺陷基线 fail → 修复分支 pass → 判定是否修好+引入回归<br>
    • 场景 E（合并冲突检测）：<code>run-test-officer --scenario E --merge …</code> —— 两个分支各自通过 → 模拟合并跑测 → 检测语义冲突<br><br>
    ${covLine ? `📋 ${covLine}<br>` : ''}
    🔗 所有报告均为真实执行结果（本地 git worktree + node --test + API 冒烟），未做任何 mock。
  </div>
</main>
</body></html>`;

  fs.writeFileSync(path.join(REPORT_DIR, 'index-demo.html'), html, 'utf8');
  console.log(`\n✅ Demo 完成，总览页：report/index-demo.html`);
  console.log('   分别打开 report-A.html / report-B.html / report-C-healthy.html / report-C-alert.html / report-D.html / report-E.html 查看各场景详情。');
}

main().catch((e) => {
  console.error('❌ Demo 失败:', e.message);
  process.exit(1);
});
