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
import { loadEnv, isLLMEnabled, chat, fastModel, extractJSON } from './llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 加载 .env（含 LLM 密钥）；未配置或 LLM_OFF=1 则巡检告警研判自动跳过，纯确定性推送不受影响。
await loadEnv();

// 轻量增强：巡检发现异常时，用 1 次快模型调用生成「告警研判」（一句影响判断 + 优先级建议）。
// 仅在 异常 && 需推送 时触发，健康巡检 0 次 LLM——保证高频定时巡检依旧快、稳、省。
// 失败/未启用则返回 null，推送正文回退为纯确定性内容。
async function aiTriageSummary({ branch, summary, failItems }) {
  if (!isLLMEnabled() || !failItems.length) return null;
  try {
    const failText = failItems.slice(0, 12)
      .map((f) => `- [${f.severity}] ${f.name}｜${String(f.rootCause || '').slice(0, 120)}`)
      .join('\n');
    const { content, reasoning } = await chat({
      messages: [
        { role: 'system', content: '你是「AI 测试官」的巡检研判助手。给定一次定时巡检发现的失败用例列表，请用中文输出一个 JSON：{"impact":"一句话研判受影响的核心能力/是否疑似资损或阻断级","priority":"P0|P1|P2","advice":"一句话处置建议"}。只输出 JSON，不要多余文字。' },
        { role: 'user', content: `分支：${branch}\n失败 ${summary.fail} / 共 ${summary.total} 项。\n失败用例：\n${failText}` },
      ],
      temperature: 0.2,
      maxTokens: 900,
      timeoutMs: 20000,
      retryOnEmpty: false,
      model: fastModel(),
    });
    const j = extractJSON(content) || extractJSON(reasoning);
    return j && (j.impact || j.advice) ? j : null;
  } catch {
    return null; // 研判失败不影响告警推送
  }
}

const args = process.argv.slice(2).reduce((m, a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = arr[i + 1];
    m[k] = v === undefined || v.startsWith('--') ? true : v;
  }
  return m;
}, {});

if (args.help) {
  console.log(`AI 测试官 · 场景 C 持续巡检 + 企微推送
用法：
  node agent/cron-monitor.mjs --branch <ref> [--repo <dir>] [--interval <秒>] [--reAlert <小时>]
                                [--out <name>] [--webhook <url>] [--once] [--help]

说明：
  --branch    巡检目标分支（默认 main）
  --interval  自循环间隔秒；省略则一次性（--once）
  --reAlert   异常持续超过该小时数未推送则重推（默认 6）
  --webhook   企微机器人地址；省略则 dry-run 落盘 report/.monitor-last-message.md
  --out       报告文件名前缀（默认 report），写 report/<out>.json

示例：
  node agent/cron-monitor.mjs --branch main
  node agent/cron-monitor.mjs --branch feature/coupon-bug --out report-C-alert
  node agent/cron-monitor.mjs --branch main --interval 3600`);
  process.exit(0);
}
const branch = args.branch || 'main';
const repo = args.repo || 'sample-app';
const intervalSec = Number(args.interval || 0);
const reAlertHours = Number(args.reAlert || 6);
const webhook = args.webhook || process.env.WEBHOOK_URL || '';
const outName = args.out || 'report';
const once = args.once === true || !intervalSec;

const REPORT_JSON = path.join(ROOT, 'report', `${outName}.json`);
const STATE_PATH = path.join(ROOT, 'report', '.monitor-state.json');
const MSG_PATH = path.join(ROOT, 'report', '.monitor-last-message.md');

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
    '--out', outName,
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
  // 轻量 AI 研判：仅在「异常 && 需推送」时调 1 次快模型（健康/去重跳过时不调），失败自动回退。
  const triage = (status === 'unhealthy' && needPush) ? await aiTriageSummary({ branch, summary, failItems }) : null;

  const title = status === 'unhealthy'
    ? '🚨 **AI 测试官 · 场景C 异常巡检**'
    : '✅ **AI 测试官 · 场景C 巡检正常**';
  const lines = [
    title,
    `> 仓库：${report.meta.repo}　分支：${branch}`,
    `> 时间：${fmtTime(report.meta.generatedAt)}`,
    `> 状态：**${status === 'unhealthy' ? `🐞 发现问题（${summary.fail} 个 / 共 ${summary.total} 项验证）` : `✅ 健康（${summary.pass} 项全部符合预期）`}**`,
  ];
  if (status === 'unhealthy') {
    if (triage) {
      lines.push('', `**🤖 AI 研判：** ${triage.impact || ''}${triage.priority ? `（${triage.priority}）` : ''}`);
      if (triage.advice) lines.push(`**处置建议：** ${triage.advice}`);
    }
    lines.push('', `**AI 测试官捕获的问题（前 10）：**`);
    for (const f of failItems.slice(0, 10)) {
      lines.push(`- [${f.severity}] ${f.name}`);
      if (f.rootCause && f.rootCause !== '-') lines.push(`  \`${f.rootCause.slice(0, 160)}\``);
    }
    if (failItems.length > 10) lines.push(`- …其余 ${failItems.length - 10} 项`);
    if (impact?.selectionReason) lines.push('', `**选测：** ${impact.selectionReason}`);
    // 报告链接：配置 PUBLIC_BASE_URL 时给可点击的完整 URL（AnyDev/HTTP 部署），否则退化为相对路径
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const reportLink = publicBase ? `${publicBase}/report/${outName}.html` : `report/${outName}.html`;
    lines.push('', `**建议：** 修复后复测通过方可合入/发布。详见 ${reportLink}`);
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

  console.log(`场景C 巡检完成：${status === 'unhealthy' ? `🐞 发现 ${summary.fail} 个问题` : '✅ 健康'}（符合预期 ${summary.pass} / 共 ${summary.total} 项）→ ${note}`);
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
