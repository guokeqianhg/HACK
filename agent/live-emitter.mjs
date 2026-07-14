// AI 测试官 · 实时事件发射器（供 run-test-officer.mjs 在执行过程中上报进度）
//
// 设计目标：让「理解 → 规划 → 执行 → 报告」的过程能被实时看到，而不是等跑完才看到一份静态 HTML。
// 实现选择「写 NDJSON 文件 + 独立看板服务器 tail 该文件推送 SSE」而非直连 WebSocket/HTTP 上报，理由：
//   1. 零依赖：不引入 ws 等第三方包，纯 node:fs/node:http。
//   2. 解耦：run-test-officer.mjs 完全不知道有没有人在看板订阅，看板服务器可以不存在、可以随时重启，
//      都不影响主流程（写文件失败也只是静默忽略，不阻断跑测）。
//   3. 可回放：NDJSON 文件本身就是一份完整的执行过程记录，看板刷新/晚启动都能补看到从头的事件。
//
// 事件 schema：{ seq, ts, type, phase?, status?, title?, detail? }
//   type: 'meta'（运行元信息）| 'phase'（阶段开始/结束）| 'log'（细粒度信息）| 'done'（整体结束）
//   status: 'start' | 'done' | 'warn' | 'error'

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
export const LIVE_DIR = path.join(ROOT, 'report');

export function liveFilePath(runId) {
  return path.join(LIVE_DIR, `.live-${runId}.ndjson`);
}

/**
 * 创建一个绑定到某次运行（runId，通常即 --out 名）的事件发射器。
 * 会先清空同名旧事件文件，避免上一次运行的历史事件残留在本次时间线前面造成误读。
 */
export function makeLiveEmitter(runId) {
  const file = liveFilePath(runId);
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
  } catch {
    /* 写不了就静默降级：实时看板不可用，但不影响主流程 */
  }
  let seq = 0;
  const emit = (event) => {
    seq += 1;
    const line = JSON.stringify({ seq, ts: Date.now(), ...event }) + '\n';
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* 忽略 */
    }
  };
  // 语法糖：常用的阶段开始/结束一步到位
  emit.phase = (phase, title, detail, status = 'start') => emit({ type: 'phase', phase, title, detail, status });
  emit.done = (summary) => emit({ type: 'done', status: 'done', detail: summary });
  return emit;
}
