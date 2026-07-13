// AI 测试官 · 轻量 ReAct Agent 运行时（类 LangGraph 的 Think→Act→Observe 状态机）
//
// 设计理念（对应命题要求的经典 Agent 架构）：
//   - Prompt Engineering：每个 Agent 有独立的 system 角色定义与任务约束。
//   - Chain-of-Thought：捕获推理模型的 reasoning_content，作为"思考轨迹"透明展示。
//   - Function Calling：工具以 OpenAI tools schema 注册，模型可自主调用真实动作（跑测/取日志/扩面）。
//   - ReAct 循环：思考 → 调用工具 → 观察结果 → 再思考 … 直至给出最终结论（或达步数上限）。
//
// 该运行时与业务无关，仅负责"带工具的对话循环"。领域工具由调用方通过 makeTools(ctx) 注入。

import { chat } from './llm.mjs';

/**
 * 定义一个工具。
 * @param {string} name        工具名（需符合 ^[a-zA-Z0-9_-]+$）
 * @param {string} description 给模型看的自然语言描述（决定模型是否调用）
 * @param {object} parameters  JSON Schema（OpenAI function.parameters 结构）
 * @param {(args:object)=>Promise<string|object>} handler 执行体，返回字符串或可被 JSON 化的对象
 */
export function defineTool({ name, description, parameters = { type: 'object', properties: {} }, handler }) {
  return { name, description, parameters, handler };
}

/**
 * 运行一个 ReAct Agent。
 * @param {object} opt
 *   system      : 系统提示词（角色 + 规则 + 输出格式约束）
 *   task        : 初始用户任务（会被作为首条 user 消息；若已传 messages 可省略）
 *   messages    : 预置对话（可选，如历史上下文）；与 task 二选一或叠加
 *   tools       : defineTool() 数组
 *   maxSteps    : 最大思考-行动轮次（防止失控），默认 8
 *   temperature / maxTokens / model : 透传 chat
 *   onStep      : (step)=>void 每步回调，便于实时展示（step: {type, ...}）
 * @returns {{answer:string, reasoning:string, steps:Array}}
 *   steps 元素：{type:'reason',text} | {type:'action',tool,args,result} | {type:'answer',text}
 */
export async function runAgent({
  system,
  task,
  messages = [],
  tools = [],
  maxSteps = 8,
  temperature = 0.2,
  maxTokens = 1500,
  model = null,
  onStep = null,
} = {}) {
  const conv = [...messages];
  // 把 system 作为首条系统消息（最兼容的方式）
  conv.unshift({ role: 'system', content: system });
  if (task) conv.push({ role: 'user', content: task });

  const toolDefs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const steps = [];
  const emit = (s) => {
    steps.push(s);
    if (onStep) {
      try {
        onStep(s);
      } catch {}
    }
  };

  for (let i = 0; i < maxSteps; i++) {
    const { content, toolCalls, reasoning } = await chat({
      messages: conv,
      tools: toolDefs.length ? toolDefs : null,
      temperature,
      maxTokens,
      model,
    });

    if (reasoning) emit({ type: 'reason', text: reasoning });

    // —— Act：存在工具调用则执行，并把结果作为 observation 回灌 ——
    if (toolCalls && toolCalls.length) {
      conv.push({
        role: 'assistant',
        content: content || '',
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      });
      for (const tc of toolCalls) {
        const tool = tools.find((t) => t.name === tc.name);
        let result;
        try {
          result = tool ? await tool.handler(tc.arguments ?? {}) : '未知工具：' + tc.name;
        } catch (e) {
          result = '工具执行出错：' + e.message;
        }
        emit({ type: 'action', tool: tc.name, args: tc.arguments, result });
        conv.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        });
      }
      continue; // 观察后进入下一轮思考
    }

    // —— 无工具调用 → 最终结论 ——
    emit({ type: 'answer', text: content });
    return {
      answer: content,
      reasoning: steps.filter((s) => s.type === 'reason').map((s) => s.text).join('\n'),
      steps,
    };
  }

  emit({ type: 'answer', text: '（已达到最大步数上限，提前结束）' });
  return {
    answer: '（已达到最大步数上限，提前结束）',
    reasoning: steps.filter((s) => s.type === 'reason').map((s) => s.text).join('\n'),
    steps,
  };
}
