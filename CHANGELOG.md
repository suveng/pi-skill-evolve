# Changelog

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
