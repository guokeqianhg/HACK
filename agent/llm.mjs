import path from 'node:path';
import { fileURLToPath } from 'node:url';

// AI 测试官 · LLM 接入层（OpenAI 兼容 Chat Completions 协议 + 原生 Function Calling）
//
// 设计目标：
//   1. 让引擎「理解变更 / 规划策略 / 根因推理」真正由大模型完成，而非仅正则/导入图。
//   2. 原生支持 Function Calling（工具调用），为 ReAct Agent 提供"真实动作"能力。
//   3. 捕获 reasoning_content（推理模型的思维链 CoT 轨迹），用于透明化与报告展示。
//   4. 未配置 API Key 时整层自动失效，引擎回退确定性逻辑，保证离线可演示。
//
// 环境变量（兼容两套命名）：
//   OPENAI_API_KEY  / LLM_API_KEY        必填（不填则 isLLMEnabled()=false，全部回退）
//   OPENAI_BASE_URL / LLM_BASE_URL       可选，默认 https://api.openai.com/v1（可指向混元/DeepSeek/内部代理等兼容端点）
//   OPENAI_MODEL    / LLM_MODEL          可选，文本推理模型，默认 kimi-k2.5
//   OPENAI_FAST_MODEL / LLM_FAST_MODEL   可选，判定类快模型（语义理解/覆盖度/需求审计/自适应旁白），不填则共用推理模型
//
// 协议兼容性：不强制 response_format=json_object（部分本地/代理模型不支持），
// 改为在 system 提示中要求「只输出 JSON」，再用 extractJSON 鲁棒抽取。

// ---------- 配置（惰性读取，确保 .env 在任何时刻加载都生效）----------
function cfg() {
  return {
    key: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
    base: (process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    textModel: process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'kimi-k2.5',
    // 快模型（判定类任务：语义理解 / 覆盖度 / 需求审计 / 自适应旁白），缺省回退到文本推理模型
    fastModel: process.env.LLM_FAST_MODEL || process.env.OPENAI_FAST_MODEL || '',
  };
}

export function isLLMEnabled() {
  return !!cfg().key;
}

// 判定类轻任务用的快模型；未单独配置时回退到文本推理模型
export function fastModel() {
  const c = cfg();
  return c.fastModel || c.textModel;
}

// 是否显式配置了独立快模型（用于决定是否值得为"旁白"发起一次 LLM 调用）
export function hasFastModel() {
  return !!(process.env.LLM_FAST_MODEL || process.env.OPENAI_FAST_MODEL);
}

// ---------- 极简 .env 加载（仅本地开发用，避免把密钥写进代码；.env 已被 gitignore）----------
// 支持 `KEY="value # with #"` 与 `KEY=value` 两种写法；# 注释仅在行首/空白后且未引用时生效。
export async function loadEnv(dotEnvPath) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = dotEnvPath || path.resolve(here, '..', '.env');
  let txt;
  try {
    const fs = await import('node:fs');
    txt = fs.readFileSync(p, 'utf8');
  } catch {
    return false;
  }
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
  return true;
}

// ---------- LLM 调用统计（用于性能评估，不影响逻辑）----------
export let _llmStats = { calls: 0, ms: 0 };

// ---------- 底层对话：支持 tools / reasoning_content / 重试 ----------
/**
 * 调用 LLM（OpenAI 兼容）。messages 为完整消息数组（可含 system/tool 角色）。
 * @returns {{content:string, toolCalls:Array, reasoning:string, raw:object}}
 */
export async function chat({ messages, tools = null, temperature = 0.2, maxTokens = 1200, model = null, retries = 2, stats = true } = {}) {
  const { key, base, textModel } = cfg();
  if (!key) throw new Error('LLM API Key 未配置');
  const m = model || textModel;
  const url = `${base}/chat/completions`;
  const body = { model: m, temperature, max_tokens: maxTokens, messages };
  if (tools && tools.length) body.tools = tools;
  const t0 = Date.now();

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(to);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status >= 500 && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: safeParseJSON(tc.function?.arguments || '{}'),
          }))
        : [];
      if (stats) {
        _llmStats.calls++;
        _llmStats.ms += Date.now() - t0;
        console.error(`[llm-debug] model=${m} ms=${Date.now() - t0}`);
      }
      return {
        content: msg.content || '',
        toolCalls,
        reasoning: msg.reasoning_content || '',
        raw: data,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

// 兼容旧调用：callLLM(system, user)
export async function callLLM(system, user, { temperature = 0.2, maxTokens = 1000 } = {}) {
  const { content } = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    maxTokens,
  });
  return content;
}

// ---------- 工具函数 ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function safeParseJSON(s) {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * 从模型文本中鲁棒抽取 JSON（兼容模型多嘴前后缀、markdown 围栏、
 * 以及答案写在 reasoning_content 里、且其中又引用了带括号的证据导致"首个括号"误切的情况）。
 * 策略：从【最后一个】[ 或 { 出发，做括号平衡匹配，取匹配到的完整片段——
 * 因为模型通常在推理/解释之后才输出最终 JSON，最后一个定界符最可能是答案起点。
 * @returns {object|Array|null}
 */
export function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  // 去掉可能出现的 markdown 代码围栏（```json ... ```）
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 整段直接解析（模型偶尔会干净地只输出 JSON）
  try { return JSON.parse(t); } catch { /* ignore */ }
  // 扫描所有平衡的 { } / [ ] 片段（尊重字符串与转义），返回「能解析的最大片段」：
  // 顶层容器通常最大，且对象会包住内部数组，因此对象优先于其内嵌数组被选中。
  const spans = [];
  const scan = (open, close) => {
    let inStr = false, esc = false, depth = 0, start = -1;
    for (let j = 0; j < t.length; j++) {
      const ch = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) {
        if (depth === 0) start = j;
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0 && start >= 0) {
          spans.push(t.slice(start, j + 1));
          start = -1;
        }
      }
    }
  };
  scan('{', '}');
  scan('[', ']');
  let best = null;
  for (const s of spans) {
    try {
      const v = JSON.parse(s);
      if (!best || s.length > best.len) best = { val: v, len: s.length };
    } catch { /* 该片段非法，跳过 */ }
  }
  return best ? best.val : null;
}
