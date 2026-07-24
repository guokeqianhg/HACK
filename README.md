# 方向二【AI测试官】全链路自动化测试 Agent

一个能**理解变更 → 规划策略 → 执行验证 → 产出可决策报告**的测试 Agent，覆盖后端逻辑到前端体验（Playwright UI 冒烟，需安装 Playwright 后生效）。

## 仓库结构
```
f:/HACK
├── sample-app/            # 被测对象 SUT（迷你电商：下单/优惠券 全栈）
│   ├── src/               # 后端逻辑（coupon/inventory/order）+ 服务器 + 前端共享逻辑
│   ├── public/            # 前端 SPA（购物车→结算）
│   ├── tests/             # 零依赖单测（node:test）
│   ├── smoke/             # api-smoke（离线兜底）/ ui-smoke（Playwright）
│   └── docs/requirement.md# 场景 B 需求输入
├── agent/                 # AI 测试官引擎 + MCP Server
│   ├── run-test-officer.mjs  # 执行引擎（理解→规划→真实跑测→报告）
│   ├── mcp-server.mjs        # ⭐ MCP Server 包裹（stdio + HTTP/SSE，供 Box/任意 MCP 客户端调度）
│   ├── cron-monitor.mjs      # 场景 C 定时巡检 + 企微推送
│   ├── demo.mjs              # 一键串五场景
│   └── llm.mjs / agent.mjs / officer-tools.mjs / select-tests.mjs / live-emitter.mjs
├── .codebuddy/commands/   # /test-officer 快捷命令
├── report/                # generate-report.mjs + report.json → index.html 看板
└── mcp.json               # TGit/TAPD/Playwright/企微 MCP 配置示例
```

## 五场景映射（启发式命题 + 自主扩展）
| 场景 | 触发 | 关键动作 | 交付 |
|---|---|---|---|
| A 代码改动 | 指令/读 diff | 影响面分析 → 跑相关单测+API冒烟 → 报告 | 针对性测试报告 |
| B 需求文档 | 传需求 | 拆解测试点 → 源码结构核对实现 + 测试覆盖度 → 缺口/不达标标注 | 需求覆盖度报告 |
| C 持续巡检 | 定时/automation | 走核心路径冒烟 → 异常收集根因 → 推送 | 定时巡检+异常推送 |
| D Bug修复验证 | 传缺陷ID+修复分支 | 读缺陷 → 缺陷基线复现 → 修复分支跑测 → 以 fail→pass 证据判定是否修好+引入回归 | 修复就绪度报告 |
| E 合并冲突检测 | 传两个待合并分支 | 各自全量 → 模拟合并跑测 → 对比：各自通过但合并后失败的 = 语义冲突 → AI解释根因 | 语义冲突报告 |

场景 D/E 为参赛者从真实工作痛点出发自主扩展：**D** 解决"修了 bug 真的修好了吗？"的验证盲区；**E** 解决 git merge 无法检测的语义冲突（改不同行但逻辑互相覆盖），只有真实跑测才能发现。

## AI 语义能力（LLM 接入 · 可选但推荐）
「理解变更 / 规划策略 / 根因推理」由大模型驱动，而非仅正则 / 导入图。引擎通过 `agent/llm.mjs` 调用 **OpenAI 兼容 Chat Completions** 协议，配置环境变量即可启用；**未配置则自动回退确定性逻辑，离线 Demo 不受影响**。

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `LLM_API_KEY` | 模型 API Key（不填则关闭 AI 语义层）| 无（回退）|
| `LLM_BASE_URL` | 兼容端点，可指向混元 / DeepSeek / 本地 ollama 等 | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型名 | `gpt-4o-mini` |

启用后：场景 A/C 的「理解变更」会输出改动意图、风险等级、受影响业务流程与建议验证重点（自然语言，并写入报告时间线）；失败用例的 `rootCause` 由模型结合 diff + 日志做语义归因而非正则提取。

### 运行档位与用法（五场景各自独立触发，不必一起跑）
五个场景对应五个不同的触发时机（提交代码 / 拿到需求 / 定时巡检 / 修完 bug / 合并前），**现实中各自独立触发**，MCP 的 `run_test_officer` 也是一次一个场景。因此推荐**分场景单独跑**，不必用一键六场景（那只是演示聚合页）。三档运行模式：

| 档位 | 开关 | 单场景耗时（实测，端点 60 RPM） | 适用 |
|---|---|---|---|
| **离线** | `LLM_OFF=1` | 秒级 | 评审现场、纯验证链路（结论与在线完全一致，因结论由真实跑测决定，不靠 LLM） |
| **默认（AI 增强）** | 不设开关 | 约 75s（3 次 LLM 调用） | 展示 AI 语义理解 / 根因归因 |
| **完整 Agent** | `ENABLE_REACT=1` | 约 115s（+ReAct 多轮自主规划） | 需展示 Agent 自主规划轨迹（Think→Act→Observe） |

- `FAST_MODE=1`（或 `--fast`）：等价于最少 LLM 调用（关 ReAct）。
- `LLM_TIMEOUT_MS`（默认 30000）：单次 LLM 调用超时；慢代理下早失败早回退。
- 性能来源说明：结论（有无 bug / 是否修复 / 是否语义冲突）100% 由 `git worktree` 里真实跑测决定，LLM 只做「可读性增强」（意图/风险/根因人话），故**离线也能得到完全正确的分析结论**。

> ⚠️ 不要用并行跑多场景来提速：LLM 端点通常有 RPM 限流（实测 60），并行会触发 429 限流退避反而更慢。分场景串行是正确用法。

## 自适应策略（P1 · 失败驱动的动态闭环）
引擎不再是「固定流水线跑完即结束」：首轮执行若出现失败，会自动进入自适应阶段，根据中间结果调整后续策略：
- **扩展选测（发现隐性影响面）**：从失败用例实际 import 的源码模块出发，沿导入图反向可达找出「首轮未覆盖、但共享同一依赖」的其它测试并补跑——弥补精准选测可能遗漏的间接影响。
- **深度复跑确认**：对失败单测 / API / UI 链路二次复跑，确认可复现并抓取完整根因（覆盖 `reproConfirmed` 标记），避免把偶发抖动误报为缺陷。
- **决策来源**：启用 LLM 时由模型判断 `expandScope / deepDive` 并给出理由（写入报告时间线「⑤ 自适应策略」）；离线时走确定性启发式（有失败即触发）。

## AI 生成回归测试（P2 · 防幻觉 + 去重）
失败用例暴露 bug 后，引擎会让 LLM 生成一个新的回归测试文件锁定「正确预期行为」，并在 worktree 中真实运行验证——只有「在缺陷分支确实失败」的生成测试才会落盘进 `tests/`，避免模型编造断言缺陷行为的假测试。
**去重**：同一失败用例被反复触发生成时（如多次跑 demo/巡检），引擎会先扫描 `tests/generated-*.test.js` 中是否已存在断言等价的回归测试，命中则直接复用（报告中标记为 `♻️ 复用已有回归守卫`），不再调用模型、不再新增文件，避免 `tests/` 目录无限膨胀。

## 场景 B · 自由文本需求的 AI 自主拆解
`docs/requirement.md` 采用「`## 模块：` + `### 测试点`」的结构化约定便于精确核对，但真实 TAPD 需求/缺陷大多是无结构自由文本。当需求文本不满足该约定格式时（规则解析降级为弱兜底），引擎会自动让 LLM **直接读需求原文**自主拆解出具体、可验证的测试点，并尝试把每个测试点归属到仓库中真实存在的源码模块（找不到真实模块时留空，不编造路径），更贴近赛题「不给测试清单，AI 自己读懂需求拆场景」的要求；解析失败或未启用 LLM 时自动回退规则兜底结果，不阻断流程。

## 实时执行看板（Think → Act → Observe 流式可视化）
`report/*.html` 是跑完之后生成的静态可决策报告；若想在**执行过程中**实时看到「理解 → 规划 → 执行 → 报告」每一步（包括 ReAct Agent 真实的 Think→Act→Observe 循环轨迹），另开一个终端起实时看板：
```bash
node report/live-server.mjs           # 启动看板服务器（默认 http://127.0.0.1:5177，可用 --port/--host 指定）
```
保持该进程运行，再在另一个终端正常执行 `node agent/run-test-officer.mjs ...` 或 `node agent/demo.mjs`，打开 `http://127.0.0.1:5177` 即可看到：
- 按阶段（理解变更 / 选测策略 / ReAct 规划 / 执行验证 / AI 根因推理 / 自适应策略 / AI 生成回归测试 / 生成报告）逐步点亮的时间线；
- ReAct 规划 Agent 真实调用 `get_diff` / `list_test_files` / `get_module_source` 等工具的完整 Think→Act→Observe 轨迹，逐条流式出现，而非等跑完才看到最终结论；
- 跑完后自动汇总通过/失败统计，并提供「查看完整报告」跳转到对应的 `report-*.html`。

实现零依赖（纯 `node:http` + Server-Sent Events，无需 WebSocket/第三方包）：执行引擎把每一步写成一行 NDJSON（`report/.live-<out>.ndjson`），看板服务器 tail 该文件并通过 SSE 推给浏览器；看板未启动也完全不影响主流程（写事件失败静默忽略），页面刷新/晚启动都能通过回放历史事件补看到从头的完整过程。

## 功能展示控制台（浏览器一键演示，评审推荐）
实时看板是「被动观看」——还需另开终端跑命令。若想**只开一个页面完成整场演示**，用展示控制台：
```bash
node report/demo-console.mjs            # 默认 http://127.0.0.1:5180，可用 --port/--host 指定
```
打开页面即可：
- 查看五场景（A/B/C健康/C告警/D/E）卡片与各自最近一次跑测结论（通过/发现问题、进度条、报告时间）；
- 点击场景卡片「▶ 运行」**在浏览器里真实触发执行引擎**（命令白名单与 `agent/demo.mjs` 一致，页面不能注入任意命令；全局单跑互斥，避免 worktree/端口冲突），或点「▶ 一键运行全部场景」依次跑完五场景；
- 下方实时面板同步呈现 Think→Act→Observe 流式时间线（复用 `.live-<out>.ndjson` 事件流，刷新可回放）；
- 跑完点「📊 查看报告」跳转对应 `report-*.html`；页面同时展示核心能力亮点与 AI 语义层启用状态（仅检测 Key 是否存在，不读取密钥内容）。

## 快速开始（核心零依赖、离线可跑）
```bash
cd sample-app
npm test                 # 运行后端单测（node --test）
node smoke/api-smoke.mjs # 离线 API 冒烟（场景 C 兜底）
npm start                # 启动 SUT（http://127.0.0.1:3000）可用 Playwright 验证 UI
```
**前端体验链路（可选，P0）**：在 `sample-app` 安装 Playwright 后，「AI 测试官」闭环会自动在 worktree 起 SUT 服务并用真实浏览器跑 `ui-smoke.spec.js`，把前端验证并入报告。
```bash
cd sample-app
npm i -D playwright        # 安装 @playwright/test（已写入 devDependencies）
npx playwright install chromium   # 安装 Chromium 浏览器
```
> 未安装 Playwright 时，闭环**不受影响**：前端 UI 冒烟在报告中以 `⏭ SKIP` 如实标注，后端单测 + API 冒烟照常产出报告（评审现场零依赖可演示）。

**演示前 UI 链路就绪自检**（避免评审机未装浏览器导致 UI 变 `SKIP`）：
```bash
node agent/check-ui-ready.mjs   # 校验 @playwright/test / Chromium 二进制 / ui-smoke.spec.js，输出 🟢 GO 或缺失项+修复命令
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
真实可跑：AI 测试官读取 diff → 影响分析 → 运行 `node --test`、API 冒烟 `node smoke/api-smoke.mjs`，并在安装 Playwright 后自动追加真实浏览器 UI 冒烟（结账/折扣券路径）→ 生成含严重级别/根因/复现的报告。
（口径：`feature/coupon-bug` 相对 `main` 为**单文件改动**——`src/coupon.js` 折扣券漏写 `(1 - )`，把「9 折」算成「1 折」的资损级 bug。在 `main` 上全量回归全部通过（0 失败）；在 `feature/coupon-bug` 上，该 bug 会引发一组同源失败（折扣券本身 + 叠加/下单/API/UI 链路，以及 AI 生成的回归守卫命中）。场景 A 走「精准选测 + 自适应扩展选测」只跑受影响测试及其隐性关联测试，当前实测约为 **19 符合预期 / 10 个问题**（含 UI 冒烟与 2 个 AI 生成回归守卫命中）。以上数字会随 `tests/generated-*.test.js` 回归守卫的增减而变化，属正常现象，可随时通过 `node agent/run-test-officer.mjs --scenario A` 或 `node agent/demo.mjs` 现场重新产出验证，不依赖手工维护。）

## 通用性：任意仓库 / 远端 URL / 任意可视化目录

引擎不绑定 `sample-app`——核心链路对任意 Node 仓库通用，输入来源与可视化路径均可配置：

**① 直接跑远端仓库（自动 clone，无需先有本地副本）**
```bash
# 给一个 git 地址，引擎自动 clone（含全部分支）后跑测，与本地仓库路径完全等价
node agent/run-test-officer.mjs --repo-url https://github.com/owner/repo.git \
  --base main --target feature/x --scenario A
# 被测项目在 monorepo 子目录时，加 --repo-subdir 指定：
node agent/run-test-officer.mjs --repo-url https://github.com/owner/mono.git \
  --repo-subdir packages/app --base main --target dev --scenario A
```
> `--repo`（本地目录）与 `--repo-url`（远端地址）二选一；后者 clone 到临时目录并为所有 `origin/*` 建本地分支，保证 `--base/--target/--merge` 可被 worktree 解析。

**② 前端 UI 冒烟解耦（换仓库不再写死 sample-app 的启动方式）**
```bash
node agent/run-test-officer.mjs --repo-url <url> --scenario A \
  --ui-start "npm run start:test" \   # 被测前端启动命令（默认 node src/server.js）
  --ui-spec  "e2e/smoke.spec.js" \    # Playwright spec 相对仓库根（默认 smoke/ui-smoke.spec.js）
  --ui-ready "/health"                # 就绪探活路径（默认 /api/products）
# 被测仓库无前端时，用 --ui-off 关闭 UI 冒烟（后端单测+API 冒烟照常）
```

**③ 可视化任意目录（不再写死 report/）**
```bash
# 看板扫描指定目录下的 .live-*.ndjson 与 *.html 报告，实现任意路径自动适配
node report/live-server.mjs --dir /path/to/any/reports --port 5177
```
> 报告链接自动适配：`done` 事件的 `reportFile` 为完整 URL 时直接跳转，否则按看板目录相对打开。

以上三项对 MCP 调用同样可用：`run_test_officer` 新增入参 `repoUrl` / `uiStart` / `uiSpec` / `uiReady` / `uiOff`。

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

## 离线一键 Demo（串起场景 A / B / C / D / E）
一条命令跑通五场景并生成聚合总览页，评审现场零依赖、可重复：
```bash
node agent/demo.mjs
# 产物：
#   report/index-demo.html        总览页（聚合入口，含场景卡片与覆盖度摘要）
#   report/report-A.html          场景 A：代码改动 → 精准选测 → 真实跑测
#   report/report-B.html          场景 B：需求文档 → 覆盖度报告
#   report/report-C-healthy.html  场景 C：定时巡检（健康基线）
#   report/report-C-alert.html     场景 C：定时巡检（异常告警）
#   report/report-D.html           场景 D：Bug 修复闭环验证（缺陷基线 fail → 修复分支 pass）
#   report/report-E.html           场景 E：合并冲突检测（Git 文本冲突 / 语义冲突分层报告）
```
也可单独运行任一场景：
```bash
# 场景 A：diff 驱动精准选测
node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A
# 场景 B：需求驱动覆盖度（离线 fixture 模拟 TAPD 需求）
node agent/run-test-officer.mjs --repo sample-app --base main --target main --scenario B --requirement sample-app/docs/requirement.md
# 需求可为 Markdown（docs/requirement.md，通用约定格式）或 JSON（requirement-demo.json）；TAPD MCP 取回后写出同结构亦可
# 场景 C：定时巡检（同 P4，见上）
node agent/cron-monitor.mjs --branch main
# 场景 D：Bug 修复验证（默认 --base 为缺陷基线；也可显式 --buggy/--before）
node agent/run-test-officer.mjs --repo sample-app --base feature/coupon-bug --target main --scenario D --requirement sample-app/docs/requirement.md
# 场景 E：合并冲突检测（文本冲突与语义冲突分层报告）
node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-refund-guard --merge feature/coupon-floor-guard --scenario E
```

## 可视化报告
报告看板 `report/index*.html` 由 `report/generate-report.mjs` 渲染（纯内联 CSS/JS，离线可用），包含：
- **AI 测试官过程时间线**：理解变更 → 影响面分析 → 选测策略 → 执行验证 → 生成报告，逐步可视化（异常步高亮）。
- **通过率进度条**：总用例 / 通过 / 失败 + 通过率百分比。
- **需求覆盖度矩阵（场景 B）**：对每个需求点做「源码结构核对（模块存在/非桩）+ 测试覆盖」，状态含 ✅ 已实现 / ❌ 测试不达标 / ⛔ 无实现 / 🟠 疑似桩 / ⚠️ 未测试；需求点可声明 `tests`（用例名子串）做**用例级精确核对**，避免同模块多需求点「一损俱损」误报，直接暴露实现缺口与测试盲区。
- **执行结果表**：用例 / 类型（unit/api/ui）/ 状态 / 严重级 / 根因 / 复现；前端 UI 未装 Playwright 时显示 `⏭ SKIP` 不计入通过率。

## 平台能力（Box/CodeBuddy）
- **AI 测试官 MCP Server（形态出口，见「接入 Box 平台」节）**：`agent/mcp-server.mjs` 把五场景封装为标准 MCP 工具（`list_scenarios` / `run_test_officer` / `get_report`），Box 平台以「命令」或「URL（MCP 连接器）」两种方式接入即可调度，无需改业务代码。
- **TGit/工蜂 MCP（已接入 `/test-officer`）**：场景 A 真实调用 `get_merge_request_diff` 取 PR/MR diff → 写 `report/.mcp-diff.txt` → `run-test-officer.mjs --diff` 喂入，闭环跑测。
- **TAPD MCP（已接入 `/test-officer`）**：场景 B 真实调用 `get_story`/`get_bug` 取需求/缺陷 → 整理为 fixture 写 `report/.mcp-req.json` → `run-test-officer.mjs --requirement` 喂入，产出覆盖度报告。
- **Playwright MCP**：驱动真实浏览器（前端体验）；或沿用引擎内置的 `@playwright/test` UI 冒烟。
- **automation 定时任务 + 企微/Knot webhook**：场景 C 持续巡检与异常推送（见上）。
- 离线兜底：MCP 不可用时，全部回退本地 `git diff` / 本地 `docs/requirement-demo.json` / 本地 HTML 报告，全链路仍成立。

## 真 MCP 闭环（直连 REST/HTTP，不依赖宿主编排）
MCP 工具由驱动本 Agent 的 LLM 宿主调用；为让「平台能力」从装饰变**真可用**，执行引擎同时内置直连 REST/HTTP 的真实路径——即使宿主不编排 MCP，真闭环依旧成立：

| 能力 | 真实路径（有凭据即生效） | 无凭据降级 |
|---|---|---|
| **场景 A 真实 MR diff** | `--pr <iid> [--pr-project owner/repo]` + `TGIT_TOKEN` → `fetchTGitMRDiff()` 直连 `GET {TGIT_API_BASE}/projects/{proj}/merge_requests/{iid}/changes` 拉真实改动 | 回退本地 `git diff base..target` |
| **MR 评论回写** | 同上凭据 → `commentToPR()` `POST .../merge_requests/{iid}/notes` 真写评论 | 写 `report/pr-comment.md`（dry-run） |
| **企微实时推送** | `--webhook <url>` 或 `WEBHOOK_URL` → `pushToWeChat()` `POST` 企微机器人 webhook，markdown 报告推送给值班/开发 | 跳过推送（保持零依赖） |

```bash
# 真闭环演示（评审环境配了工蜂/企微凭据时）：
node agent/run-test-officer.mjs --repo sample-app --base main --target feature/coupon-bug --scenario A \
  --pr 123 --pr-project owner/repo --webhook "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
# ① 引擎真实拉取 !123 的 MR diff（落盘 report/.mcp-diff.txt）
# ② 跑测后真实回写 MR 评论（有 TGIT_TOKEN 时）
# ③ 跑完真实把报告推送到企微（有 WEBHOOK_URL 时）
```
> 经本地 mock 工蜂 REST + 企微 webhook 验证：拉取/回写/推送三条 HTTP 路径均真实发起并已落盘，断言全 PASS。

## 接入 Box 平台（MCP 连接器 · 形态：Server）

赛题推荐用 Box 平台的「MCP 连接器」能力。`agent/mcp-server.mjs` 把整个执行引擎包成一个**标准 MCP Server**，让 Box（或任意 MCP 客户端）以「命令」或「URL」两种方式接入，从而把"AI 测试官"作为可被平台调度/编排的标准工具。已通过 stdio 端到端真跑场景 A、HTTP/SSE 完成握手 + 列工具两项验证。

**暴露的工具：**
- `list_scenarios` — 列出五场景语义与触发方式
- `run_test_officer` — 执行某场景（支持 `useDemoDefaults` 零配置体验；可传 `base/target/requirement/merge/pr/webhook` 等）
- `get_report` — 回放某次运行的报告结论

### 方式一：命令（stdio）— Box 以命令拉起（推荐本地 / 评审机）
在 Box MCP 连接器填：
```
command: node
args:    ["agent/mcp-server.mjs"]
cwd:     <仓库根 f:/HACK>
env:     LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（可选，不填自动回退确定性逻辑）
```

### 方式二：URL（HTTP/SSE）— Box 以 URL 注册（适合内网/评审访问）
先启动服务（默认本地，安全）：
```bash
node agent/mcp-server.mjs --http --port 3001
# 探活：http://127.0.0.1:3001/health
```
在 Box MCP 连接器填 URL：`http://<host>:3001/mcp`。
> ⚠️ **安全**：仅绑定 `127.0.0.1` 时任何人摸不到；若用 `--host 0.0.0.0` 对外暴露，**必须**加 `--token <secret>`，否则服务会直接拒绝启动（引擎会 spawn 进程跑测试，裸暴露等价于开放任意命令执行）。Box 侧在 URL 鉴权头填 `Authorization: Bearer <secret>`。

### 一键体验（给 Box / 评审同学）
调用 `run_test_officer` 时传 `{"scenario":"A","useDemoDefaults":true}`（或 B/C/D/E），无需任何分支参数即可看到真实测试报告——引擎会自动套用演示分支（如 `feature/coupon-bug`）并真实跑测，非 mock。

## 部署到 EdgeOne Makers（赛题"Box 平台"即指此）

赛题文档中的"Box 平台"对应 **EdgeOne Makers**（腾讯云边缘一站式部署控制台）。本作品以 **Agents** 形态部署：`agents/test-officer/index.ts` 导出 `onRequest(context)`，引擎在 `context.sandbox` 里真实跑（命令执行 / git worktree / 子进程全由沙箱承载），并后台起看板拿可访问预览链接。

> 本仓库的 `demo-console`/`live-server` 是 Web 服务，但 Makers 的 Web/Node Functions **禁止自行监听端口**，且部署 Agent 后才能拿到沙箱能力，故主部署选 Agent 形态。

### 静态首页（解决预览 404 · 一键演示入口）
纯 Agent 部署时根路径没有页面 → 打开预览链接是 404。为此新增静态首页 `web/index.html`（零依赖、内联 CSS/JS）：
- 展示五场景（A/B/C/D/E）卡片，点击「▶ 运行」→ 前端 `POST /test-officer`（带 `makers-conversation-id` 头）真实触发 Agent 跑测；
- 等待返回后展示 summary（用例总数 / 符合预期 / 发现问题 + 通过率进度条 + 阻断项）与运行日志；
- 「查看完整报告」直接用 Agent 随响应回传的报告 HTML 全文（`reportHtmlContent`）内嵌 iframe 渲染，**不依赖看板端口是否可达**。

`edgeone.json` 已把 `outputDirectory` 指到 `web/`，静态首页与 `POST /test-officer` Agent 端点在同一域名下共存（`/` 出页面、`/test-officer` 跑测）。本地联调：`$env:PAGES_SOURCE="skills"; edgeone makers dev`，浏览器打开 `http://127.0.0.1:8088/` 即见首页。

### 已就绪的文件（均按平台规范对齐）
- `agents/test-officer/index.ts` — Agent 入口（`.ts` 是平台约定扩展名）。解析 `scenario`/`params`，用 `context.sandbox.commands.run` 跑引擎，用 `context.sandbox.files.read` 读报告，用 `context.sandbox.getHost` 拿看板预览链接。**全程不碰 `process.env`/`process.cwd()`**（平台硬规则）。
- `edgeone.json` — 仅声明 `agents.framework: "claude-agent-sdk"`（必填，决定控制台图标与 `context.tools` 形态；本作品核心用 `context.sandbox`）。
- `package.json` — `"type":"module"`、`engines.node >=18`、`start`/`dev`/`build` 脚本。
- `agent/glob-shim.mjs` — **沙箱兼容关键**：`node:fs.globSync` 仅 Node ≥22 内置，垫片在旧版本回退同步递归实现，避免引擎在沙箱直接崩溃。
- `.env.example` — 必须含 `AI_GATEWAY_API_KEY=` / `AI_GATEWAY_BASE_URL=`，CLI 部署时据此**自动注入**平台内置模型网关（免费额度）。

### 部署步骤（按官方 Skill 流程）
> 环境变量 `PAGES_SOURCE=skills` 必须在**每条** `edgeone` 命令前带上（声明来自 AI Skill 上下文）。
> ⚠️ **Windows PowerShell 注意**：没有 `export` 命令，请用 `$env:PAGES_SOURCE="skills"` 设置，或写成内联：`$env:PAGES_SOURCE="skills"; edgeone makers deploy ...`。

```bash
# 0) 安装 CLI（≥ 1.6.0，否则非交互环境会卡死）
npm install -g edgeone@latest
edgeone -v

# 1) 设环境变量（PowerShell 写法；bash 用 export PAGES_SOURCE=skills）
$env:PAGES_SOURCE = "skills"

# 2) 登录（浏览器登录；选 China 或 Global 取决于你的腾讯云账号站点）
edgeone login --site china
#   若报 AuthFailure.UnauthorizedOperation（账号无 Makers 权限），见下方「登录失败对策」

# 3) 关联项目（自动创建）
edgeone makers link --name ai-test-officer

# 4) 拉取远端环境变量到本地 .env（供本地 dev 用，AI_GATEWAY_* 由平台注入）
edgeone makers env pull

# 5) 本地联调（后台启动 dev server）
edgeone makers dev --name ai-test-officer
#   浏览器打开 Makers 控制台，对 test-officer 说「跑场景 A」

# 6) 发布（非交互加 --json；比赛长期链接见下方收集表）
edgeone makers deploy -n ai-test-officer --json
```

### 免登录部署（推荐：绕过浏览器 OAuth 的 UnauthorizedOperation）
若 `edgeone login`（浏览器 OAuth 换 token）报 `AuthFailure.UnauthorizedOperation`，可改用控制台生成的 **API Token** 直接部署，无需本地登录：
1. 用浏览器登录 **EdgeOne Makers 控制台** → 「设置 / Settings」→「API Token」→「创建令牌」复制。
   （若网页控制台也进不去/创建不了，说明账号本身无 Makers 权限，需主账号在 CAM 挂 `QcloudEOFullAccess` 或先开通 EdgeOne。）
2. 直接部署：
```bash
$env:PAGES_SOURCE = "skills"
edgeone makers deploy -n ai-test-officer -t <控制台创建的Token> --json
```
> 注：`edgeone login` 没有 `--token` 参数；Token 只用于 `edgeone makers deploy -t`，用于无头/CI 场景。

### 环境变量说明
- `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL` 由 CLI **部署时自动注入**，无需手填（前提是 `.env.example` 已声明）。
- 引擎默认用平台内置模型网关跑「理解变更 / 根因推理」；若想用自己的模型，在控制台「项目设置 → 环境变量」里设 `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`（Agent 会优先映射过去）。
- 可选集成（工蜂 MR 回写 / TAPD 直连）的 `TGIT_*` / `TAPD_*` 同样在控制台环境变量里设。

### 调用约定
- 对话：在 Makers 控制台对 Agent 说「跑场景 A / B / C」。
- API：`POST /test-officer`，Body `{ "scenario": "A", "params": { "target": "feature/coupon-bug" } }`。平台自动注入请求头 `makers-conversation-id`（映射到 `context.conversation_id`）。
- 零配置体验：不传 `params` 时自动套用演示分支真实跑测（非 mock）。

### 预览链接时效（赛题特别说明）
默认预览链接有访问时效；比赛期间可填 [专用链接收集表](https://doc.weixin.qq.com/forms/AJEAIQdfAAoAVMAxAZlAFoCNNs69fqmPf) 申请长期可访问链接（每周一/四处理）。也可在 EdgeOne 加自定义域名实现长期访问。

