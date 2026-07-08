# 方向二【AI测试官】全链路自动化测试 Agent

一个能**理解变更 → 规划策略 → 执行验证 → 产出可决策报告**的测试 Agent，覆盖后端逻辑到前端体验。

## 仓库结构
```
f:/HACK
├── sample-app/            # 被测对象 SUT（迷你电商：下单/优惠券 全栈）
│   ├── src/               # 后端逻辑（coupon/inventory/order）+ 服务器 + 前端共享逻辑
│   ├── public/            # 前端 SPA（购物车→结算）
│   ├── tests/             # 零依赖单测（node:test）
│   ├── smoke/             # api-smoke（离线兜底）/ ui-smoke（Playwright）
│   └── docs/requirement.md# 场景 B 需求输入
├── agent/                 # AI 测试官系统提示词
├── .codebuddy/commands/   # /test-officer 快捷命令
├── report/                # generate-report.mjs + report.json → index.html 看板
└── mcp.json               # TGit/TAPD/Playwright/企微 MCP 配置示例
```

## 三场景映射
| 场景 | 触发 | 关键动作 | 交付 |
|---|---|---|---|
| A 代码改动 | 指令/读 diff | 影响面分析 → 跑相关单测+API冒烟 → 报告 | 针对性测试报告 |
| B 需求文档 | 传需求 | 拆解测试点 → 读代码核对实现 → 缺口标注 | 需求覆盖度报告 |
| C 持续巡检 | 定时/automation | 走核心路径冒烟 → 异常收集根因 → 推送 | 定时巡检+异常推送 |

## 快速开始（零依赖、离线可跑）
```bash
cd sample-app
npm test                 # 运行后端单测（node --test）
node smoke/api-smoke.mjs # 离线 API 冒烟（场景 C 兜底）
npm start                # 启动 SUT（http://localhost:3000）可用 Playwright 验证 UI
```
生成报告看板：
```bash
node report/generate-report.mjs   # 读取 report/report.json → report/index.html
```

## 演示「代码改动→针对性测试」(场景 A)
仓库含 `main`（正确）与 `feature/coupon-bug`（故意引入折扣券 bug）两个分支。

**一键真实闭环**（推荐）：执行引擎自动 `git diff` → 用 worktree 在目标分支真实跑测 → 生成 `report/report.json` → 渲染 `report/index.html`，全程不切分支、不污染工作树：
```bash
node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
# 输出：影响面分析 + 真实跑测结果 + 报告看板 report/index.html
```
手动验证分支差异：
```bash
cd sample-app
git diff main feature/coupon-bug   # 查看改动（单文件：折扣券 9 折算成 1 折）
```
真实可跑：AI 测试官读取 diff → 影响分析 → 运行 `node --test` 与 `node smoke/api-smoke.mjs` → 生成含严重级别/根因/复现的报告。
（在 `main` 上跑结果为 14 通过 / 0 失败；在 `feature/coupon-bug` 上为 14 通过 / 4 失败，暴露资损 bug。）

## 平台能力（Box/CodeBuddy）
- **TGit/工蜂 MCP**：读 PR/MR diff（场景 A）
- **TAPD MCP**：读需求/缺陷/用例（场景 B/C）
- **Playwright MCP**：驱动真实浏览器（前端体验）
- **automation 定时任务 + 企微 webhook**：场景 C 持续巡检与异常推送
- 离线兜底：本地 git + 本地测试 + 本地 HTML 报告，确保评审现场真实可跑。
