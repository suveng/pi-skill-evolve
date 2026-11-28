# pi-skill-evolve（技能自演进）

npm 包 `pi-skill-evolve`：采集会话里的技能曝光 / 加载 → 异步复盘子进程生成提案 → 独立评审 → 过闸才落盘。

## 架构设计

- `extensions/skill-evolve/index.ts` 只做事件接线与命令注册：`before_agent_start` / `tool_call` / `tool_result` / `agent_settled` / `session_start` / `session_shutdown`；命令 `/skill-evolve`、`/skill-audit`。
- `lib/` 按流水线切：
  - 采集与门禁：`evolution` / `evolution-observe` / `evolution-model` / `evolution-views` / `evolution-apply` / `flags`
  - 聚合派生：`aggregate*` / `attribution` / `classify-action` / `detect` / `baseline`
  - 派发：`dispatch*` + `dispatch-queue` / `queue` / `drain-pending` / `lock` / `logfile`（抢锁 → 写 run.json → detached spawn → unref）
  - 落盘：`gate0` + `apply-gates`（授权核对 / 备份 / 原子写 / 复验 / 生效边界）、`apply*`、`diff-gen` / `diff-apply`、`apply-targets`
  - 规则与统计：`hard-rules`、`stale`、`weekly`、`metrics`、`review-retry`、`audit`、`model-config` / `child-env`
- `prompts/复盘.md` = 复盘子进程指令；`extensions/skill-evolve/scripts/replay.ts` = 回放；仓库根 `scripts/panel.mjs` = 本机 Web 面板。

## 代码偏好

- 主会话侧绝不阻塞：`dispatch()` 的长活儿全在 Promise 内部，错误内部吞掉，不惊动用户当前操作。
- 去抖而非叠加：窗口内再结束一轮只记 pending，窗口过后的下一次结算合并成一次派发。
- 机械与语义分开：`hard-rules` 只做「出现即 P0」的机械扫描，规则正文在运行工作区的 `.pi/evolution/rules/hard-rules.json`（不入本仓），逐条 try/catch，坏规则记 invalid 跳过、不拖垮链路。
- 闸0 授权核对只有一条判据：这段时间 `.pi/skills` 的 git status/diff 一个字节都不能变；变了就**不写盘**、只告警留证据，绝不自动还原别人的改动。
- 门禁层（如 `evolution.ts`）**不 import pi**：事件字段由 `index.ts` 拆成原始值传入，纯逻辑必须能被 `node --test` 直接跑。

## 代码约束

- 测试零依赖、外部依赖全注入（git / md-check / skills diagnostics）：**单测里绝不起真进程** —— M4 那次跑出 51 个督导进程就是这么来的，`test/fake-review-spawn.ts`、`test/*harness.ts` 就是为此存在。
- 改任一环必须补对应 `test/*.test.ts`（链路、去抖、锁、面板 pid、硬规则各有独立用例）；跑法见 `RELEASING.md` 与 `test/` 各文件头注释。
- 发版：`RELEASING.md` 规定走 npm 可信发布（OIDC，仓库不存 token），`package.json` 的 `pi.extensions` 指向 `./extensions/skill-evolve/index.ts`，改入口路径等于改加载方式；版本号与 CHANGELOG 同步。
