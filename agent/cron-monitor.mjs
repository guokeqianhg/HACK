// AI 测试官 · 场景 C 持续巡检 + 企微推送
// 零依赖：定时/一次性对目标分支做全量回归，异常时通过企微机器人 webhook 推送，状态文件去重避免刷屏。
//
// 用法：
//   node agent/cron-monitor.mjs --branch main                 # 一次性巡检（适合被 automation 定时调用）
//   node agent/cron-monitor.mjs --branch main --interval 3600 # 自循环模式（自带定时器）
//   node agent/cron-monitor.mjs --branch feature/coupon-bug   # 对指定分支巡检（demo 看告警）
//   WEBHOOK_URL=https://qyapi.weixin.qq.com/... node agent/cron-monitor.mjs --branch main
//
// 说明：
//   - base=target 时执行引擎跑「纯全量回归」（无 diff），适合持续监控某分支健康度
//   - 无 WEBHOOK_URL 进入 dry-run：把将要推送的 markdown 写到 report/.monitor-last-message.md 并打印，不真正发请求
//   - 用 report/.monitor-state.json 记录上次状态，仅在 健康↔异常切换 / 异常项变化 / 异常超 reAlert 小时未推送 时推送

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REPORT_JSON = path.join(ROOT, 'report', 'report.json');
const STATE_PATH = path.join(ROOT, 'report', '.monitor-state.json');
const MSG_PATH = path.join(ROOT, 'report', '.monitor-last-message.md');

const args = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) m[a.slice(2)] = arr[i + 1];
  return m;
}, {});
const branch = args.branch || 'main';
const repo = args.repo || 'sample-app';
const intervalSec = Number(args.interval || 0);
const reAlertHours = Number(args.reAlert || 6);
const webhook = args.webhook || process.env.WEBHOOK_URL || '';
const once = !intervalSec;

function run(cwd, cmd, cmdArgs) {
  return new Promise((res) => {
    const p = spawn(cmd, cmdArgs, { cwd, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => res({ code, out }));
  });
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function checkOnce() {
  // 1) 调用执行引擎对目标分支做全量回归（base=target → 无 diff，纯回归）
  const r = await run(ROOT, 'node', [
    path.join(__dirname, 'run-test-officer.mjs'),
    '--repo', repo,
    '--base', branch,
    '--target', branch,
    '--scenario', 'C',
    '--triggeredBy', `场景C 定时巡检@${branch}`,
  ]);
  if (r.code !== 0) console.error('⚠️ 执行引擎非零退出：\n' + r.out.slice(-800));

  // 2) 读报告
  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  } catch (e) {
    throw new Error('无法读取 report/report.json：' + e.message);
  }
  const { summary, results, impact } = report;
  const failItems = results.filter((x) => x.status === 'fail');
  const status = summary.fail > 0 ? 'unhealthy' : 'healthy';

  // 3) 去重判断
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  const curFailNames = failItems.map((x) => x.name).sort().join('|');
  const now = Date.now();
  const sinceLastPush = prev?.lastPushAt ? now - new Date(prev.lastPushAt).getTime() : Infinity;
  const needPush =
    status === 'unhealthy'
      ? !prev || prev.status !== 'unhealthy' || curFailNames !== prev.failNames || sinceLastPush > reAlertHours * 3600 * 1000
      : !prev || prev.status !== status; // 健康：仅在 异常→健康 切换时通知一次

  // 4) 构造企微 markdown 消息
  const title = status === 'unhealthy'
    ? '🚨 **AI 测试官 · 场景C 异常巡检**'
    : '✅ **AI 测试官 · 场景C 巡检正常**';
  const lines = [
    title,
    `> 仓库：${report.meta.repo}　分支：${branch}`,
    `> 时间：${fmtTime(report.meta.generatedAt)}`,
    `> 状态：**${status === 'unhealthy' ? `异常（${summary.fail} 失败 / ${summary.total} 总）` : `健康（${summary.pass} 通过 / ${summary.total} 总）`}**`,
  ];
  if (status === 'unhealthy') {
    lines.push('', '**失败用例（前 10）：**');
    for (const f of failItems.slice(0, 10)) {
      lines.push(`- [${f.severity}] ${f.name}`);
      if (f.rootCause && f.rootCause !== '-') lines.push(`  \`${f.rootCause.slice(0, 160)}\``);
    }
    if (failItems.length > 10) lines.push(`- …其余 ${failItems.length - 10} 项`);
    if (impact?.selectionReason) lines.push('', `**选测：** ${impact.selectionReason}`);
    lines.push('', '**建议：** 修复后复测通过方可合入/发布。详见 report/index.html');
  } else {
    lines.push('', '全部用例通过，无异常。');
  }
  const content = lines.join('\n');

  // 5) 推送（或 dry-run）
  let pushed = false;
  let note;
  if (needPush) {
    if (webhook) {
      try {
        const resp = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
        });
        const j = await resp.json().catch(() => ({}));
        pushed = resp.ok && j.errcode === 0;
        note = pushed ? '已推送企微' : `推送失败 HTTP ${resp.status} ${JSON.stringify(j)}`;
      } catch (e) {
        note = '推送异常：' + e.message;
      }
    } else {
      pushed = true;
      note = 'dry-run（未配置 WEBHOOK_URL，消息已落盘）';
    }
    fs.writeFileSync(MSG_PATH, content, 'utf8');
  } else {
    note = '状态未变，跳过推送（去重）';
  }

  // 6) 更新状态（pushed 才刷新 lastPushAt，避免未发送却重置重发计时）
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    status,
    failCount: summary.fail,
    failNames: curFailNames,
    lastRunAt: report.meta.generatedAt,
    lastPushAt: pushed ? report.meta.generatedAt : prev?.lastPushAt || null,
  }, null, 2), 'utf8');

  console.log(`场景C 巡检完成：${status === 'unhealthy' ? '异常' : '健康'} ${summary.pass}通过/${summary.fail}失败 → ${note}`);
  return { status, needPush, pushed };
}

async function main() {
  if (once) {
    await checkOnce();
  } else {
    console.log(`场景C 自循环巡检：每 ${intervalSec}s 一次，分支 ${branch}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await checkOnce(); } catch (e) { console.error('巡检异常：', e.message); }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
