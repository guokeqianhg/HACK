import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8088);
const DEMO_CASE_REPO_DEFAULT = process.env.DEMO_CASE_REPO || 'https://github.com/guokeqianhg/HACK_case.git';

const DEMO_CASES = {
  case1: {
    repoSubdir: 'case1',
    scenarioDefaults: {
      A: { base: 'main', target: 'feature/coupon-bug' },
      B: { base: 'main', target: 'main' },
      C: { base: 'main', target: 'feature/coupon-bug' },
      D: { base: 'feature/coupon-bug', target: 'main' },
      E: { base: 'main', target: 'feature/coupon-refund-guard', merge: 'feature/coupon-floor-guard' },
    },
  },
  case2: {
    repoSubdir: 'case2',
    scenarioDefaults: {
      A: { base: 'main', target: 'feature/free-window-bug' },
      B: { base: 'main', target: 'main' },
      C: { base: 'main', target: 'feature/free-window-bug' },
      D: { base: 'feature/free-window-bug', target: 'fix/parking-pricing' },
      E: { base: 'main', target: 'feature/peak-member-pass', merge: 'feature/peak-analytics-guard' },
    },
  },
};

// 有界并发：每次运行天然隔离（独立子进程/临时目录/报告文件/动态端口），
// 限的是机器资源与 LLM 网关 RPM。默认 3，可用 MAX_CONCURRENCY 调整。
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 3));
let runningCount = 0;

function normalizeDemoCase(value) {
  return value === 'case2' ? 'case2' : 'case1';
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function tailLines(text, maxLines = 40) {
  return String(text || '').split('\n').slice(-maxLines).join('\n');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(text);
}

function serveFile(res, filePath, contentType) {
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    sendText(res, 404, 'Not Found');
  }
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function runEngine({ scenario, params, conversationId }) {
  const demoCase = normalizeDemoCase(params.demoCase);
  const demo = DEMO_CASES[demoCase];
  const defaults = demo.scenarioDefaults[scenario] || demo.scenarioDefaults.A;
  const base = params.base || defaults.base;
  const target = params.target || defaults.target;
  const merge = params.merge || defaults.merge;
  const userRepoUrl = params.repoUrl && String(params.repoUrl).trim();
  const outName = `anydev-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const argv = [
    path.join(ROOT, 'agent', 'run-test-officer.mjs'),
    '--scenario', scenario,
    '--base', String(base),
    '--target', String(target),
    '--out', outName,
  ];

  let tempRequirementPath = '';
  if (userRepoUrl) {
    argv.push('--repo-url', userRepoUrl, '--ui-off');
    if (params.repoSubdir) argv.push('--repo-subdir', String(params.repoSubdir));
    if (params.uiStart) {
      argv.push('--ui-start', String(params.uiStart));
      if (params.uiSpec) argv.push('--ui-spec', String(params.uiSpec));
      if (params.uiReady) argv.push('--ui-ready', String(params.uiReady));
    }
  } else {
    argv.push('--repo-url', DEMO_CASE_REPO_DEFAULT, '--repo-subdir', demo.repoSubdir, '--ui-off');
  }

  if (merge) argv.push('--merge', String(merge));
  if (params.pr) argv.push('--pr', String(params.pr));
  if (params.prProject) argv.push('--pr-project', String(params.prProject));
  if (params.webhook) argv.push('--webhook', String(params.webhook));

  if (params.requirementText && String(params.requirementText).trim()) {
    tempRequirementPath = path.join(os.tmpdir(), `anydev-req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`);
    fs.writeFileSync(tempRequirementPath, String(params.requirementText), 'utf8');
    argv.push('--requirement', tempRequirementPath);
  }

  const env = {
    ...process.env,
    FAST_MODE: process.env.FAST_MODE || '1',
  };

  const stdoutChunks = [];
  const stderrChunks = [];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));
    child.on('error', reject);
    child.on('close', resolve);
  });

  if (tempRequirementPath) {
    try { fs.unlinkSync(tempRequirementPath); } catch { /* ignore */ }
  }

  const reportJsonPath = path.join(ROOT, 'report', `${outName}.json`);
  const reportHtmlPath = path.join(ROOT, 'report', `${outName}.html`);
  const report = readJsonIfExists(reportJsonPath);
  const reportHtmlContent = readTextIfExists(reportHtmlPath);
  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');

  if (!report) {
    return {
      ok: false,
      error: `执行引擎未产出报告（exit=${exitCode}）`,
      engineStdoutTail: tailLines(stdout),
      engineStderrTail: tailLines(stderr),
    };
  }

  return {
    ok: true,
    scenario,
    conversationId,
    reportName: outName,
    repoMode: userRepoUrl ? 'user-repo' : `demo-${demoCase}`,
    demoCase: userRepoUrl ? '' : demoCase,
    summary: report.summary || null,
    reportHtml: `/report/${outName}.html`,
    reportHtmlContent,
    engineStdoutTail: tailLines(stdout),
    engineStderrTail: tailLines(stderr),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveFile(res, path.join(ROOT, 'web', 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, running: runningCount > 0, runningCount, maxConcurrency: MAX_CONCURRENCY, service: 'anydev-preview-server' });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/report/')) {
    const fileName = path.basename(url.pathname);
    const filePath = path.join(ROOT, 'report', fileName);
    const contentType = fileName.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8';
    return serveFile(res, filePath, contentType);
  }

  if (req.method === 'POST' && url.pathname === '/test-officer') {
    const conversationId = String(req.headers['makers-conversation-id'] || '').trim();
    if (!conversationId) return sendJson(res, 400, { ok: false, error: 'conversationId is required.' });
    if (runningCount >= MAX_CONCURRENCY) return sendJson(res, 409, { ok: false, error: `当前已有 ${runningCount} 个场景在运行（上限 ${MAX_CONCURRENCY}），请稍后再试。` });

    try {
      const raw = await readRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const scenario = ['A', 'B', 'C', 'D', 'E'].includes(body.scenario) ? body.scenario : 'A';
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      runningCount++;
      const result = await runEngine({ scenario, params, conversationId });
      return sendJson(res, result.ok === false ? 500 : 200, result);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
    } finally {
      runningCount--;
    }
  }

  sendText(res, 404, 'Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 AnyDev preview server ready: http://${HOST}:${PORT}`);
});
