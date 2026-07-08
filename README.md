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
（在 `main` 上跑结果为 18 通过 / 0 失败；在 `feature/coupon-bug` 上为 14 通过 / 4 失败，暴露资损 bug。）

## 演示「持续巡检 + 异常推送」(场景 C)
场景 C 不依赖代码改动，而是**定时对目标分支做全量回归**，发现失败用例时通过企微机器人 webhook 推送告警，并用状态文件去重避免刷屏。

```bash
# 一次性巡检（最适合被 automation 定时调用）：对 main 全量回归
node agent/cron-monitor.mjs --branch main
# 自循环模式（脚本自带定时器，无需外部调度）：每 3600s 一次
node agent/cron-monitor.mjs --branch main --interval 3600
# demo 看告警：对含 bug 的分支巡检 → 生成异常推送
node agent/cron-monitor.mjs --branch feature/coupon-bug
```

- 推送内容：企微 markdown 卡片（状态/失败用例+根因/风险/建议），消息同时落盘 `report/.monitor-last-message.md` 便于查看。
- 去重策略：`健康↔异常切换` 或 `异常项变化` 或 `异常超过 6h 未推送` 才推送；健康态持续则不刷屏。
- 真实推送：设置环境变量 `WEBHOOK_URL`（企微机器人地址）即走真实 HTTP 推送；**未设置则 dry-run**（仅落盘+打印），保证评审现场零依赖可演示。

**CodeBuddy automation（平台能力）**：在 IDE 自动化面板创建定时任务，配置如下即可——

| 字段 | 值 |
|---|---|
| 名称 | `AI测试官-场景C定时巡检` |
| 触发 | 周期 FREQ=HOURLY;INTERVAL=1（每小时） |
| 工作目录 | `f:/HACK` |
| 提示词 | `执行 AI 测试官场景 C 持续巡检：在仓库 f:/HACK 运行 node agent/cron-monitor.mjs --once --branch main。脚本会全量回归并（若异常）经企微 webhook 推送告警、状态去重。运行后无需额外操作；若输出异常请简要汇总失败数与严重级。` |

> 注：当前 automation 桥接不可用时，可用系统调度器兜底——Windows `schtasks /create /tn "AICron" /tr "node f:/HACK/agent/cron-monitor.mjs --once --branch main" /sc hourly`；或 Linux/Mac 的 `crontab -e` 加 `0 * * * * cd /f/HACK && node agent/cron-monitor.mjs --once --branch main`。

## 离线一键 Demo（串起场景 A / B / C）
一条命令跑通三场景并生成聚合总览页，评审现场零依赖、可重复：
```bash
node agent/demo.mjs
# 产物：
#   report/index-demo.html        总览页（聚合入口，含场景卡片与覆盖度摘要）
#   report/report-A.html          场景 A：代码改动 → 精准选测 → 真实跑测
#   report/report-B.html          场景 B：需求文档 → 覆盖度报告
#   report/report-C-healthy.html  场景 C：定时巡检（健康基线）
#   report/report-C-alert.html     场景 C：定时巡检（异常告警）
```
也可单独运行任一场景：
```bash
# 场景 A：diff 驱动精准选测
node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
# 场景 B：需求驱动覆盖度（离线 fixture 模拟 TAPD 需求）
node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario B --requirement sample-app/docs/requirement-demo.json
# 场景 C：定时巡检（同 P4，见上）
node agent/cron-monitor.mjs --branch main
```

## 可视化报告
报告看板 `report/index*.html` 由 `report/generate-report.mjs` 渲染（纯内联 CSS/JS，离线可用），包含：
- **AI 测试官过程时间线**：理解变更 → 影响面分析 → 选测策略 → 执行验证 → 生成报告，逐步可视化（异常步高亮）。
- **通过率进度条**：总用例 / 通过 / 失败 + 通过率百分比。
- **需求覆盖度矩阵（场景 B）**：每个需求测试点的状态（✅ 已覆盖 / ❌ 不达标 / ⚠️ 测试缺口）与关联测试文件，直接暴露测试盲区。
- **执行结果表**：用例 / 类型 / 状态 / 严重级 / 根因 / 复现。

## 平台能力（Box/CodeBuddy）
- **TGit/工蜂 MCP**：读 PR/MR diff（场景 A）
- **TAPD MCP**：读需求/缺陷/用例（场景 B/C）
- **Playwright MCP**：驱动真实浏览器（前端体验）
- **automation 定时任务 + 企微 webhook**：场景 C 持续巡检与异常推送（见上）
- 离线兜底：本地 git + 本地测试 + 本地 HTML 报告，确保评审现场真实可跑。
