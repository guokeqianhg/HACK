// AI 测试官 · 领域工具集（供 ReAct Agent 调用）
//
// 工具遵循"读多于写"的克制原则：Agent 主要负责"理解 / 推理 / 决策"，
// 真实执行（跑测、扩面）仍由引擎确定性流水线完成，工具只提供"可被模型观察的事实"。
// 这样既能展示 Function Calling 的真实动作能力，又不破坏已验证的离线闭环。
//
// ctx（由 run-test-officer.mjs 注入，闭包捕获引擎状态）：
//   getDiff()            -> 完整 diff 文本
//   listTests()          -> [{rel, abs, kind}] 全部可运行测试
//   getFailureLog(name)  -> 某失败用例的完整日志片段（从首轮原始输出抽取）
//   expandScope(files)   -> 给定失败单测文件，返回隐性关联测试（相对路径数组）
//   getModuleSource(rel) -> 读取某源码模块全文（供生成 Agent 写对 import）
//   readTestFile(rel)    -> 读取某测试文件全文（供生成 Agent 借鉴写法）


import path from 'node:path';

export function makeOfficerTools(ctx) {
  return [
    {
      name: 'get_diff',
      description:
        '获取目标分支相对基准分支的完整代码 diff（用于理解"改了什么、为什么可能出问题"）。无参数。返回文本。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const d = ctx.getDiff ? ctx.getDiff() : '';
        if (!d) return '(无 diff)';
        return d.length > 12000 ? d.slice(0, 12000) + '\n…(已截断)' : d;
      },
    },
    {
      name: 'list_test_files',
      description:
        '列出仓库内所有可运行测试文件（含 unit/api/ui 三类及相对路径），用于规划要验证的范围。可选参数 kind 过滤类型。',
      parameters: {
        type: 'object',
        properties: { kind: { type: 'string', description: 'unit | api | ui，不填则返回全部' } },
      },
      handler: async ({ kind } = {}) => {
        const all = ctx.listTests ? ctx.listTests() : [];
        const filtered = kind ? all.filter((t) => t.kind === kind) : all;
        if (!filtered.length) return '(无测试文件)';
        return filtered.map((t) => `${t.kind}\t${t.rel}`).join('\n');
      },
    },
    {
      name: 'get_failure_log',
      description:
        '获取某个失败用例的完整执行日志 / 堆栈，用于根因定位。参数 testName 为失败用例名（与结果中的 name 一致）。',
      parameters: {
        type: 'object',
        properties: { testName: { type: 'string', description: '失败用例名' } },
        required: ['testName'],
      },
      handler: async ({ testName } = {}) => {
        const log = ctx.getFailureLog ? ctx.getFailureLog(testName) : '';
        return log || `(未找到用例「${testName}」的日志)`;
      },
    },
    {
      name: 'expand_test_scope',
      description:
        '给定一组失败的单测文件（相对或绝对路径），找出与之"共享源码依赖、但首轮未跑到"的其它测试（隐性影响面）。返回相对路径数组。',
      parameters: {
        type: 'object',
        properties: {
          failingFiles: { type: 'array', items: { type: 'string' }, description: '失败单测文件路径数组' },
        },
        required: ['failingFiles'],
      },
      handler: async ({ failingFiles } = {}) => {
        const rel = (failingFiles || []).map((f) => (path.isAbsolute(f) ? f : path.join(ctx.repoDir || '', f)));
        const out = ctx.expandScope ? ctx.expandScope(rel) : [];
        return out.length ? out : '(无更多可扩展的关联测试)';
      },
    },
    {
      name: 'get_module_source',
      description:
        '读取某个源码模块的全文（参数为相对仓库根的路径，如 src/coupon.js）。用于了解真实的函数签名与导出，以便生成可正确 import 的测试。',
      parameters: {
        type: 'object',
        properties: { relPath: { type: 'string', description: '源码模块相对仓库根的路径' } },
        required: ['relPath'],
      },
      handler: async ({ relPath } = {}) => {
        const src = ctx.getModuleSource ? ctx.getModuleSource(relPath) : '';
        return src || `(源码不存在：${relPath})`;
      },
    },
    {
      name: 'read_test_file',
      description:
        '读取某个已有测试文件的全文（参数为相对仓库根的路径，如 tests/coupon.test.js），供参考其断言写法与风格。',
      parameters: {
        type: 'object',
        properties: { relPath: { type: 'string', description: '测试文件相对仓库根的路径' } },
        required: ['relPath'],
      },
      handler: async ({ relPath } = {}) => {
        const src = ctx.readTestFile ? ctx.readTestFile(relPath) : '';
        return src || `(测试文件不存在：${relPath})`;
      },
    },
  ];
}
