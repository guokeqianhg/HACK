// TestScope · EdgeOne Makers Agent 入口
// 部署形态：Agents（agents/test-officer/index.ts + edgeone.json）
//
// ⚠️ 平台硬规则：agents/ 内禁止读 process.env / process.cwd()
//
// ── 架构（正确版）────────────────────────────────────────
// Makers 沙箱是空白环境。部署时把引擎文件（agent/*.mjs，零依赖）写入沙箱，
// case1 电商 demo 从公开仓库 clone。评审测自己仓库时走前端输入框传 repoUrl。
//
import { ENGINE_BUNDLE } from './_engine-bundle';

// 公开 demo 仓库地址（含 case1 / case2 两套内置示例与演示分支）：

// 可通过 params.caseRepo 覆盖，或在 Makers 环境变量设 DEMO_CASE_REPO。
const DEMO_CASE_REPO_DEFAULT = 'https://github.com/guokeqianhg/HACK_case.git';

const WORK = '/tmp/officer';
const DASHBOARD_PORT = 5177;

// 沙箱配额（GB-秒）耗尽时的统一友好提示。
const QUOTA_MSG =
  '⚠️ Makers 沙箱本月免费额度（GB-秒）已用尽，暂时无法创建运行环境。\n' +
  '请等待下月配额重置，或在腾讯云 EdgeOne 控制台为本项目提升 / 购买沙箱配额后重试。';
function isQuotaError(msg: string): boolean {
  return /SANDBOX_LIMIT_EXCEEDED|LimitExceeded|quota\s*exceeded/i.test(String(msg || ''));
}

type DemoCaseKey = 'case1' | 'case2';

const DEMO_CASES: Record<DemoCaseKey, { repoSubdir: string; scenarioDefaults: Record<string, any> }> = {
  case1: {
    repoSubdir: 'case1',
    scenarioDefaults: {
      A: { base: 'main', target: 'feature/coupon-bug' },
      B: { base: 'main', target: 'main', requirement: 'case1/docs/requirement.md' },
      C: { base: 'main', target: 'feature/coupon-bug' },
      D: { base: 'feature/coupon-bug', target: 'main', requirement: 'case1/docs/requirement.md' },
      E: { base: 'main', target: 'feature/coupon-refund-guard', merge: 'feature/coupon-floor-guard' },
    },
  },
  case2: {
    repoSubdir: 'case2',
    scenarioDefaults: {
      A: { base: 'main', target: 'feature/free-window-bug' },
      B: { base: 'main', target: 'main', requirement: 'case2/docs/requirement.md' },
      C: { base: 'main', target: 'feature/free-window-bug' },
      D: { base: 'feature/free-window-bug', target: 'fix/parking-pricing', requirement: 'case2/docs/requirement.md' },
      E: { base: 'main', target: 'feature/peak-member-pass', merge: 'feature/peak-analytics-guard' },
    },
  },
};

function normalizeDemoCase(value: any): DemoCaseKey {
  return value === 'case2' ? 'case2' : 'case1';
}

function buildEngineArgs(scenario: string, params: Record<string, any>, workDir: string, demoCase: DemoCaseKey) {
  const demo = DEMO_CASES[demoCase];
  const d = demo.scenarioDefaults[scenario] || demo.scenarioDefaults.A;
  const engineScript = `${workDir}/agent/run-test-officer.mjs`;

  const base = params.base || d.base;
  const target = params.target || d.target;
  const merge = params.merge || d.merge;
  const argv = ['node', engineScript, '--scenario', scenario, '--base', base, '--target', target];

  const userRepoUrl = params.repoUrl && String(params.repoUrl).trim();
  if (userRepoUrl) {
    argv.push('--repo-url', userRepoUrl);
    if (params.repoSubdir) argv.push('--repo-subdir', String(params.repoSubdir));
    if (params.uiStart) { argv.push('--ui-start', String(params.uiStart)); if (params.uiSpec) argv.push('--ui-spec', String(params.uiSpec)); if (params.uiReady) argv.push('--ui-ready', String(params.uiReady)); }
    else { argv.push('--ui-off'); }
  } else {
    argv.push('--repo', `${workDir}/demo-repo/${demo.repoSubdir}`);
  }

  if (merge) argv.push('--merge', merge);
  if (params.pr) { argv.push('--pr', String(params.pr)); if (params.prProject) argv.push('--pr-project', String(params.prProject)); }
  if (params.webhook) argv.push('--webhook', String(params.webhook));
  if (params.__reqPath) argv.push('--requirement', String(params.__reqPath));
  else if (!userRepoUrl && d.requirement) argv.push('--requirement', `${workDir}/demo-repo/${d.requirement}`);


  const out = `makers-${scenario}-${Math.floor(Math.random() * 1e5)}`;
  argv.push('--out', out);
  return { argv, out };
}

function buildEngineEnv(env: Record<string, string | undefined> = {}) {
  // 引擎优先级：AI_GATEWAY_* > OPENAI_* > LLM_*
  // 若用户在 Makers 控制台显式配了 OPENAI_API_KEY（自备 BYOK 网关），说明想绕过平台内置网关，
  // 此时应删除平台注入的 AI_GATEWAY_* 占位值，否则引擎永远优先走平台内置网关（即使额度已耗尽）。
  const userHasOwnKey = !!(env.OPENAI_API_KEY || env.LLM_API_KEY);
  const gateKey = userHasOwnKey ? '' : env.AI_GATEWAY_API_KEY;
  const gateBase = userHasOwnKey ? '' : env.AI_GATEWAY_BASE_URL;

  return {
    ...env,
    AI_GATEWAY_API_KEY: gateKey,
    AI_GATEWAY_BASE_URL: gateBase,
    LLM_API_KEY: gateKey || env.OPENAI_API_KEY || env.LLM_API_KEY || '',
    LLM_BASE_URL: gateBase || env.OPENAI_BASE_URL || env.LLM_BASE_URL || '',
    LLM_MODEL: env.AI_GATEWAY_MODEL || env.OPENAI_MODEL || env.LLM_MODEL || 'kimi-k2.6',
    LLM_FAST_MODEL: env.AI_GATEWAY_SMALL_MODEL || env.OPENAI_FAST_MODEL || env.LLM_FAST_MODEL || '',
    FAST_MODE: env.FAST_MODE || '1',
  };
}

async function readSandboxJson(sandbox: any, p: string) {
  try { const raw = await sandbox.files.read(p); const r = typeof raw === 'string' ? JSON.parse(raw) : raw; return r && r.summary ? r.summary : (r || {}); } catch { return null; }
}
async function readSandboxText(sandbox: any, p: string) {
  try { const raw = await sandbox.files.read(p); return typeof raw === 'string' ? raw : ''; } catch { return ''; }
}

// 从 context.sandbox.files.read 读部署包里打包的文本文件内容
// 注：Makers Agent 部署时 agent/ 目录下的 .mjs 文件作为模块被 worker 加载，
// 但我们可以通过 import.meta 拿到绝对路径再让沙箱读。
// 更稳健的做法：运行时从 process.env（agent worker 内部可访问）获取部署根目录，
// 或者直接用 fs 读取当前模块同目录的文件内容，然后 sandbox.files.write 写进去。
// 因为 agents/ 里不能用 process.env，我们改用「把文件内容作为字符串常量嵌入」
// 或者利用 Makers 的部署根目录约定。
// 这里用一个折中：在本地 dev 时从本机文件系统读；部署后从 sandbox 自身能访问的路径读。
// 实际上 Makers agent-node 运行时 CWD 就是项目根，agent/ 文件可通过 fs 读到然后 sandbox.files.write。

// 把引擎文件写进沙箱。
// 引擎零依赖文件内容以 base64 内联在 _engine-bundle.ts（被 import → 一定随 Agent 打包），
// 运行时用 sandbox.files.write 解码写入沙箱。彻底不依赖部署后的文件系统布局。
async function writeEngineToSandbox(sandbox: any) {
  await sandbox.commands.run('mkdir -p ' + WORK + '/agent ' + WORK + '/report', { timeout: 10 });
  const written: string[] = [];
  const failed: string[] = [];
  for (const [rel, b64] of Object.entries(ENGINE_BUNDLE)) {
    try {
      const content = Buffer.from(b64 as string, 'base64').toString('utf-8');
      await sandbox.files.write(`${WORK}/${rel}`, content);
      written.push(rel);
    } catch (e: any) { failed.push(rel + ':' + (e && e.message ? e.message : e)); }
  }
  return { written, failed };
}

// ── SSE 流式响应（平台长任务标准协议）────────────────────────────
// 长耗时运行（1~3 分钟）绝不能「憋到最后一次性返回」：网关在等不到首字节约 15s 后
// 会判定 CLOUD_FUNCTION_INVOCATION_TIMEOUT（504）。按平台约定改为：
// 立即建立 text/event-stream 流 + 每 5s ping 心跳 + 关键节点进度事件 + 最终结果事件。
function sseEvent(data: Record<string, any>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(generator: (signal?: any) => AsyncGenerator<string>, signal?: any) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(sseEvent({ type: 'ping', ts: Date.now() }))); } catch { /* 流已关闭 */ }
      }, 5000);
      try {
        for await (const chunk of generator(signal)) {
          if (signal && signal.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e: any) {
        try { controller.enqueue(encoder.encode(sseEvent({ type: 'error_message', content: String(e && e.message || e) }))); } catch { /* ignore */ }
      } finally {
        clearInterval(heartbeat);
        try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// SSE 通道编排：带进度回调跑完整流程，进度事件实时转发到流里，结果/错误收尾
async function* runSse(context: any, signal?: any): AsyncGenerator<string> {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  const onProgress = (msg: string) => { queue.push(msg); if (wake) { const w = wake; wake = null; w(); } };

  let result: any = null; let err: any = null; let done = false;
  const task = (async () => {
    try { result = await onRequestInner(context, onProgress); }
    catch (e: any) { err = e; }
    finally { done = true; if (wake) { const w = wake; wake = null; w(); } }
  })();

  while (!done || queue.length) {
    if (signal && signal.aborted) break;
    if (queue.length) { yield sseEvent({ type: 'status', content: queue.shift() }); continue; }
    await new Promise<void>((r) => { wake = r; setTimeout(r, 300); });
  }
  await task;

  if (err) yield sseEvent({ type: 'error_message', content: String(err && err.message || err) });
  else yield sseEvent({ type: 'result', data: result });
}

function killSandbox(sb: any) {
  if (sb && typeof sb.kill === 'function') return sb.kill().catch(() => { /* 实例可能已被平台回收 */ });
  return Promise.resolve();
}

export async function onRequest(context: any) {
  // 沙箱按租约存活（extendTimeout 拉到 30 分钟），运行结束后若不主动释放，实例会空烧 GB-秒
  // 直到租约到期——这是月度沙箱配额快速耗尽的主要来源。无论成功/报错/异常，跑完立即 kill。
  // 对本架构安全：每次调用本就重写引擎 + 重新 clone，无跨请求状态依赖；
  // 报告 HTML 已通过 reportHtmlContent 读回，live-server 看板随实例销毁但内容不丢。
  const sb = context && context.sandbox;
  const headers = (context && context.request && context.request.headers) || {};
  const accept = String(headers['accept'] || headers['Accept'] || '');
  const signal = context && context.request && context.request.signal;

  // 前端带 Accept: text/event-stream → SSE 流式通道（心跳保活，规避网关首字节超时 504）
  if (accept.includes('text/event-stream')) {
    const gen = async function* () {
      try { yield* runSse(context, signal); }
      finally { await killSandbox(sb); }
    };
    return sseResponse(gen, signal);
  }

  // 兼容通道：普通 JSON 一次性返回（curl / 旧前端 / API 集成）
  try {
    return jsonResponse(await onRequestInner(context));
  } finally {
    await killSandbox(sb);
  }
}

async function onRequestInner(context: any, onProgress?: (msg: string) => void) {
  let scenario = 'A';
  let params: Record<string, any> = {};
  try {
    const body = (context && context.request && context.request.body) || {};
    if (body && typeof body === 'object') {
      scenario = body.scenario || (body.params && body.params.scenario) || 'A';
      params = body.params && typeof body.params === 'object' ? body.params : (body.params || {});
    }
  } catch { /* 用默认场景 A */ }
  if (!['A', 'B', 'C', 'D', 'E'].includes(scenario)) scenario = 'A';

  const sandbox = context && context.sandbox;
  if (!sandbox || !sandbox.commands) {
    return { ok: false, error: '当前运行环境没有 Makers 沙箱。请在 EdgeOne Makers 平台部署后调用。' };
  }

  // 【诊断】写引擎进沙箱 → 列目录 → 试运行引擎 --help 看真实报错
  if (params && (params as any).__diag) {
    let writeInfo: any = null;
    try { writeInfo = await writeEngineToSandbox(sandbox); } catch (e: any) { writeInfo = { error: e && e.message ? e.message : String(e) }; }
    const probe = [
      'echo "== node ==" && node -v',
      'echo "== ls WORK/agent ==" && ls -la ' + WORK + '/agent 2>&1',
      'echo "== run engine --help ==" && node ' + WORK + '/agent/run-test-officer.mjs --help 2>&1 | head -20',
    ].join(' ; ');
    try {
      const r = await sandbox.commands.run(probe, { timeout: 60 });
      return { ok: true, diag: true, writeInfo, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode };
    } catch (e: any) { return { ok: false, diag: true, writeInfo, error: e && e.message ? e.message : String(e) }; }
  }

  // 延长沙箱会话
  if (typeof sandbox.extendTimeout === 'function') {
    try { await sandbox.extendTimeout(1800); } catch { /* ignore */ }
  }

  // 1) 把引擎文件写进沙箱
  if (onProgress) onProgress('沙箱环境已就绪，正在写入引擎文件…');
  try { await writeEngineToSandbox(sandbox); } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    if (isQuotaError(msg)) return { ok: false, quota: true, error: QUOTA_MSG, raw: msg };
    return { ok: false, error: '写入引擎文件到沙箱失败：' + msg };
  }
  if (onProgress) onProgress('引擎文件写入完成');

  // 2) clone 公开 case 仓库（内置 demo）或用户指定仓库
  const caseRepo = (params.caseRepo && String(params.caseRepo).trim())
    || (context.env && context.env.DEMO_CASE_REPO)
    || DEMO_CASE_REPO_DEFAULT;
  const demoCase = normalizeDemoCase(params.demoCase);

  const userRepoUrl = params.repoUrl && String(params.repoUrl).trim();

  if (!userRepoUrl) {
    if (onProgress) onProgress('正在从 GitHub 克隆被测仓库…（网络波动时会自动重试）');
    let cloneErr = '';
    try {
      // 先确保目录干净（可能上次沙箱复用留了残留文件）
      await sandbox.commands.run('rm -rf ' + WORK + '/demo-repo 2>/dev/null; mkdir -p ' + WORK, { timeout: 10 });

      // 沙箱（北京节点）到 github.com 跨境网络抖动常见：clone 失败自动重试 3 次，
      // 并把 git 真实错误打印到 stdout 透出（平台只回传包装后的 exit code，看不出具体原因）。
      const cloneCmd =
        'ok=0; last=""; ' +
        'for i in 1 2 3; do ' +
          'rm -rf ' + WORK + '/demo-repo; ' +
          'last=$(git -c http.version=HTTP/1.1 clone "' + caseRepo + '" ' + WORK + '/demo-repo 2>&1); rc=$?; ' +
          'if [ $rc -eq 0 ]; then ok=1; break; fi; ' +
          'echo "clone 第 $i 次失败(exit=$rc)，3s 后重试…"; sleep 3; ' +
        'done; ' +
        'echo "$last"; ' +
        'if [ $ok -eq 1 ]; then ' +
          'cd ' + WORK + '/demo-repo && ' +
          'for r in $(git for-each-ref --format="%(refname:short)" refs/remotes/origin | grep -v "origin/HEAD"); do b=${r#origin/}; git branch "$b" "$r" 2>/dev/null || true; done; ' +
          'echo CLONE_DONE; ' +
        'else echo CLONE_FAILED; fi';
      const cr = await sandbox.commands.run(cloneCmd, { timeout: 360 });
      if (!/CLONE_DONE/.test(cr.stdout || '')) cloneErr = ((cr.stdout || '') + '\n' + (cr.stderr || '') || 'clone 未完成').slice(-800);
    } catch (e: any) { cloneErr = e && e.message ? e.message : String(e); }
    if (cloneErr) {
      if (isQuotaError(cloneErr)) return { ok: false, quota: true, error: QUOTA_MSG, raw: cloneErr };
      return { ok: false, error: '在沙箱克隆 case 仓库失败：' + cloneErr, hint: '请确认 DEMO_CASE_REPO 是公开可 clone 的地址。', caseRepo };
    }
    if (onProgress) onProgress('仓库克隆完成，正在准备测试环境…');
  }

  // 3) 需求文本写进沙箱
  if (params.requirementText && String(params.requirementText).trim()) {
    const reqPath = `${WORK}/req-${Math.floor(Math.random() * 1e5)}.md`;
    try { await sandbox.files.write(reqPath, String(params.requirementText)); params.__reqPath = reqPath; } catch { /* 退回内置需求 */ }
  }

  const { argv, out: outName } = buildEngineArgs(scenario, params, WORK, demoCase);


  // 4) 起实时看板（可选）
  let dashboardUrl = '';
  try {
    await sandbox.commands.run(`nohup node ${WORK}/report/live-server.mjs --host 0.0.0.0 --port ${DASHBOARD_PORT} > /tmp/live.log 2>&1 &`, { timeout: 15 });
    dashboardUrl = typeof sandbox.getHost === 'function' ? sandbox.getHost(DASHBOARD_PORT) : '';
  } catch { /* ignore */ }

  // 5) 真实跑引擎
  if (onProgress) onProgress('引擎执行中：AI 语义理解 → 精准选测 → 真实跑测…');
  let runOut = ''; let runErr = '';
  try {
    const res = await sandbox.commands.run(argv.map((a) => JSON.stringify(a)).join(' '), {
      cwd: WORK, timeout: 1500, env: buildEngineEnv(context.env),
    });
    runOut = res.stdout || ''; runErr = res.stderr || '';
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    if (isQuotaError(msg)) return { ok: false, quota: true, error: QUOTA_MSG, raw: msg };
    runErr = (runErr || '') + '\n[wrapper] engine run failed: ' + msg;
  }

  if (onProgress) onProgress('跑测完成，正在汇总报告…');
  const summary = await readSandboxJson(sandbox, `${WORK}/report/${outName}.json`);
  const reportHtmlContent = await readSandboxText(sandbox, `${WORK}/report/${outName}.html`);

  return {
    ok: true, scenario, conversationId: context.conversation_id || '', reportName: outName,
    repoMode: userRepoUrl ? 'user-repo' : `demo-${demoCase}`,
    demoCase: userRepoUrl ? '' : demoCase,
    summary, dashboardUrl: dashboardUrl || '',

    reportHtml: dashboardUrl ? `${dashboardUrl}/${outName}.html` : '',
    reportHtmlContent,
    engineStdoutTail: runOut.split('\n').slice(-40).join('\n'),
    engineStderrTail: runErr.split('\n').slice(-40).join('\n'),
  };
}

function jsonResponse(obj: any) {
  const body = JSON.stringify(obj, null, 2);
  if (typeof Response !== 'undefined') {
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return obj;
}
