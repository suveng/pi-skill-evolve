# Changelog

## [0.1.28] - 2026-11-11

- 详情页「评审结论」那行加上「重写 N 次」：一眼看出这版是第几次重写才过的（0 = 一次就过）

## [0.1.27] - 2026-11-11

- 新：**评审不通过自动重写提案，最多 3 次**（用户：「复盘不通过的时候，应该有 3 次重写这个提案的机会」）。verdict=reject/revise 时按 `03-review.json` 的 blocking 起一次重写 Agent，改完立刻重评；次数用完仍不通过才判 rejected
- 每一版都留档：`attempts/attempt-0N/`（提案 + diff + candidate + 当轮评审），重写日志 `agent-rewrite-N.log` 在详情页「Agent 会话 · 重写 Agent」直接点开
- 重写次数可配：`config.json` 的 `maxRewrites`（默认 3，0 = 不重写 = 旧行为），经 `SKILL_EVOLVE_MAX_REWRITES` 传给督导
- 重写没写出新提案 / 子进程失败 → 立刻按当前结论收尾，不再空等；日志写不进磁盘也不影响评审
- 测试：726 → 729（新增「reject → 重写一次后通过」「三次都用满后 rejected」「重写无产物立刻收尾」）

## [0.1.26] - 2026-11-11

- 修：督导不再为「判定不需要改」的 run 空等 15 分钟。`analyzed` / `failed` / `rejected` / `superseded` / `abandoned` 且没有 `02-proposal.json` 时，`waitForProposal` 立刻收工，`03-review.json` 记 `reason=analyzed-no-proposal`
- 修：`collectPanelState` 的「复盘中」不再把这种终态算进去（实测面板头写「复盘中 1」，列表却写「已结束 1」）

## [0.1.25] - 2026-11-11

- 修：`analyzed` 且没有 `02-proposal.json` 的 run（分析判定不需要改）原本挂「复盘报告」页，该页删掉后它在**任何 tab 里都看不到**（实测 run ce43f48b-1794363796）。现在归「已结束」，原因写「分析判定不需要改（终态）」，证据给 `run.json` / `01-findings.json`
- `originOfRun` 新增 `hasProposal` 入参；列表聚合与详情页都按磁盘上有没有 `02-proposal.json` 判
- 测试：724 → 726

## [0.1.24] - 2026-11-11

- 修：`scripts/panel.mjs` 传给子进程的 `promptTemplate` 少了一层目录（`<runtime>/lib/web/prompts/`），子进程读不到模板就退回内置最小指令 → 改成 `<runtime>/prompts/复盘.md`（实测重启后派发不再出现「复盘模板读取失败」）
- 实测：重启桥接后新派发的复盘跑满全程（child.log 8 行、状态 analyzed），不再 1 秒被桥接 exit 带走

## [0.1.23] - 2026-11-11

复盘子进程会被飞书桥接「顺手杀掉」（实测 run 260928fa-1794361982 只输出一行就死）。

- 修：父进程带着 `PI_FEISHU_DAEMON=1` 时，子 pi 加载桥接扩展读到「已有 daemon 持有网关锁」就 `process.exit(0)` → 复盘被判「子进程已退出」。新增 `stripDaemonFlags` / `childEnvOf`（`lib/spawn-plan.ts`），派发复盘子进程与督导传给评审 Agent 的 env 都摘掉该开关，其余变量原样保留
- 修：`scripts/panel.mjs start --port` 指定端口与现有面板不同时先停再起（原来会直接复用旧端口，用户以为换了实际没换）
- 测试：722 → 724

## [0.1.22] - 2026-11-11

面板脱离 pi 进程，可以单独重启（用户：「做成你也可以重启的吧」）。

- 新增 `lib/web/spawn-panel.ts`：`decidePanel` 按「有没有记录 / 活着没 / 版本同不同 / 端口同不同」决定复用、换版本、救活或新起；`materializeExtension` 把扩展目录按版本复制到 `.pi/evolution/runtime/panel-v<版本>/`
- 新增 `lib/web/child-main.ts`：独立进程入口，自己 `createEvolution` 后接六个写操作（与 TUI 同一份实现），写 `locks/web.json`，SIGTERM 先关监听再退出
- 新增 `scripts/panel.mjs`：`status / start / stop / restart`，人和 agent 都能用，不必重启 pi 会话
- `locks/web.json` 增加可选 `version` 字段；老记录没有该字段按「版本未知」处理，会主动换新
- 修：`startWebPanel` 的 `server.unref()` 让独立进程在 `runChild` 返回后立刻退出（端口只活 100ms）→ 新增 `keepAlive` 选项，子进程传 `true`
- 测试：713 → 722（新增 `test/spawn-panel.test.ts` 9 条）

## [0.1.15] - 2026-11-09

两处面板口径按用户实测反馈调整。

- 新增流水线状态 `ended`（页面写「终态」，符号 `■`）：表示「前一格的结论就是没有下一步」，与 `skipped`（这一格本来就不跑）区分开。用在：分析判定不需要改 / 督导等提案超时 / 评审驳回后的采纳
- 终态会向后传染：提案段是终态时，评审与采纳也标终态，不再显示「等待」并催「下一步：评审」
- `03-review.json` 里 `status: "skipped"`（督导等提案超时）不再渲染成「完成 / skipped」，改判终态并写明「没等到提案，跳过评审（proposal-timeout）」
- 移除 `.cursor` stub 检查（用户：「缺 .cursor stub 这个不需要检查」）：技能管理页不再挂「缺 .cursor stub」标签，新建技能的闸 3 只校验 AGENTS.md 索引行，周报不再报 stub 有/缺
- 测试：690 → 691

## [0.1.14] - 2026-11-09

「已分析、判定不用改」的 run 是终态，却一直挂在待处理页（用户实测积到 7 条）。

- 修复：待处理页的「待评审」只在**真有 `02-proposal.json`** 时出现；分析完判定「不该改」的 run 不再占位（它在「复盘报告」页照常可见）
- 修复：流水线「提案」段在 `analyzed` + 无提案时判 `skipped`（明细「分析判定不需要改：本轮不出提案（终态）」），不再显示成 `waiting` 并催「下一步：提案」
- 状态仍是 `dispatched` 但 `01-findings.json` 已在时，提案段维持 `waiting`（恢复流程会先补状态）
- 测试：688 → 690（新增「analyzed 无提案不进待处理」「dispatched 有 findings 仍是 waiting」）

## [0.1.13] - 2026-11-09

同一个工作区开两个 pi（两个窗口 / 一个窗口执行中另开一个）时的两条竞态。

- 修复：两个实例的 `session_start` 都会重挂督导，单飞闸只认「已经写进 `run.json` 的活 pid」，两边 spawn 之间的空档会各起一个督导（双花 token、双写 `03-review.json`）。现在重挂前先抢 `locks/supervisor`，抢到后再复核一次 `supervisorPid`，后到者直接写 `respawn-blocked`「另一个 pi 实例正在重挂督导」
- 修复：两个实例同时扫队列采纳会互相覆盖 `queue.json`（读-改-写），同一份 diff 甚至可能被各应用一次。`session_start` / `settle` 的「扫队列 → 应用」整段现在抢 `locks/apply`，抢不到就跳过，下一次会话起点再来
- 新增：`lockDir(evolutionDir, name)` 支持多把锁（`dispatch` / `supervisor` / `apply`，缺省仍是 `dispatch`，老行为不变）；`withLock()` 跨进程互斥执行，异常也保证释放
- 测试：685 → 688（新增「两个 pi 同时恢复只起一个督导」「两把锁互不干扰」「withLock 忙时让位 + 抛错也释放」）；另用两个真实 node 进程并发跑恢复验证：`spawn` 计数 1，一个 `supervisor-respawned`、一个 `respawn-blocked`

## [0.1.12] - 2026-11-09

按 npm 包安装时「评审 → 采纳」整条链原本一次都跑不起来，这个版本修掉它，并把每轮复盘画成五段流水线。

- 修复（事故）：`review-supervisor` 在 `node_modules` 里被 `node --experimental-strip-types` 拒绝（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），督导一起就崩。新增 `lib/supervisor-runtime.ts`：把督导依赖闭包先复制到 `.pi/evolution/runtime/supervisor/<版本-指纹>/`（排除 `*.test.*`、`.ready` 标记、升级清旧目录），搬不动回退原路径只记日志
- 修复：督导「起来但什么都不做，退出码 0」——`import.meta.url` 与 `process.argv[1]` 直接比字符串，macOS `/tmp` 软链（`/private/tmp`）会判成「不是直接运行」。改 `isDirectInvocation()` 用 `realpathSync` 双向比对
- 新增：`lib/pipeline.ts` 五段流水线（派发 → 分析 → 提案 → 评审 → 采纳），每段状态取 `done/running/waiting/blocked/failed/skipped`，只看磁盘产物与 pid，不猜进度；卡住那段直接写「下次会话起点自动重挂」之类的接手方式
- 面板：run 详情页顶部新增「流水线」一排格子（状态色 + 明细 + 时刻 + 一句话 hint），排在概要之前；待处理页的「正在跑」条目多一行 `流水线：派发✓ 分析… 提案· 评审· 采纳·`
- 新增：`lib/recover.ts` 重启 / `/reload` 后自动接手 —— 分析产物在而状态还是 `dispatched` 就补成 `analyzed`；有提案但督导已死就重挂督导；复盘子进程还活着则不打扰；**绝不重跑复盘**
- 会话起点（`session_start`）会调 `recover()`，有动作时用一行通知说明补了什么
- 测试：664 → 685 条（新增 `supervisor-runtime`、`recover`、`pipeline` 三组用例）

## [0.1.0] - 2026-11-08

首个可用版本。

- 采集：每轮记录技能曝光（system prompt 快照）、真实加载（`read` 命中 `SKILL.md`）、未加载、派发与跳过原因
- 复盘：`agent_settled` 去抖后异步派生子进程，读原始会话 + 索引，产出发现
- 提案：只出 unified diff（±40 行上限），写入 `runs/<id>/candidate/`，不直接改 `.pi/skills`
- 评审：独立子进程、独立上下文、结构化输出，blocking 必须带证据
- 采纳：三级权限 + 五道闸（授权核对 / 判据校验 / 原子写 / 复验 / 备份），可回滚
- 面板：`/skill-evolve web` 起在 `127.0.0.1:7788`，六个 tab（待处理/待审批/已采纳/已处理/复盘报告/技能管理）、提案 diff 视图、操作审计
