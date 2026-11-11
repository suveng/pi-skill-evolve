# pi-skill-evolve

pi 的「技能进化」扩展：盯着你自己的 `SKILL.md`，回答三个问题——**这轮用了哪些技能、为什么该用的没被用、要不要改/合并/删掉**。附本机 Web 管理面板。

零第三方依赖，全部逻辑跑在本机；除「自动复盘」会派生子进程外不发任何网络请求。

## 安装

```bash
pi install npm:pi-skill-evolve@0.1.0     # 钉版本，升级是你主动的决定
pi install -l npm:pi-skill-evolve@0.1.0  # 只装到当前项目

# 也可以用 git 源，但它每次启动 / reload 都会跟远端分支走，不适合生产
pi install git:github.com/suveng/pi-skill-evolve
```

装完 `/reload`。默认行为：**Web 面板随 pi 启动**（`127.0.0.1:7788`），**采集与自动复盘默认关闭**——面板起来不等于开始花 token。

## 命令

| 命令 | 作用 |
|---|---|
| `/skill-evolve web [--port N] [--once]` | 起本机管理面板 |
| `/skill-evolve collect on\|off` | 只开关遥测采集（写本地 jsonl，不花 token） |
| `/skill-evolve review on\|off` | 只开关自动复盘（会派生子进程，花 token） |
| `/skill-evolve on\|off` | 两者一起开关 |
| `/skill-evolve run` | 立刻复盘，跳过去抖与次数上限 |
| `/skill-evolve status` / `report` / `queue` | 状态、周报、待批队列 |
| `/skill-evolve approve <runId>` / `reject <runId>` | 采纳 / 否决提案 |
| `/skill-evolve baseline [--reset]` | 存量债基线 |
| `/skill-evolve config` | 选模型（提案 / 评审） |

## 面板

`http://127.0.0.1:7788` —— 四个流程 tab：待处理 / 待审批 / 已采纳 / 已结束，外加技能管理 / 设置。
同一份 run 只出现在一个 tab（归属由 `lib/web/tab-origin.ts` 唯一判定），详情页顶部写明「现在在 / 为什么 / 证据」。

只绑 `127.0.0.1`、零鉴权、写操作带 CSRF 与同源校验；远程看用 `ssh -L 7788:127.0.0.1:7788`。

### 面板是独立进程（可单独重启）

面板不再跑在 pi 进程里：`session_start` 时由 `lib/web/spawn-panel.ts` 拉起一个独立 node 子进程，
`locks/web.json` 记 `{pid, url, version}`。装上新版本后下次会话启动会自动换进程，
也可以完全不碰 pi 会话，直接运维：

```bash
node scripts/panel.mjs status      # 谁在跑、什么版本
node scripts/panel.mjs restart     # 重启（换版本后就是这条）
node scripts/panel.mjs stop        # 停掉
```

子进程的代码复制到 `.pi/evolution/runtime/panel-v<版本>/` 再跑 —— node 拒绝对 `node_modules`
里的 `.ts` 做类型剥离，不复制就起不来。

### 流水线

每条 run 都走五段，run 详情页顶部会画出这五格（状态词 + 明细 + 时刻 + 一句话 hint）：

| 段 | 完成的标志 | 卡住时谁接手 |
|---|---|---|
| 派发 | `run.json` | — |
| 分析 | `01-findings.json` | 子进程退出没产物 → 卡死判定收尾 |
| 提案 | `02-proposal.json` | 分析已结束却没提案 = 判定「不该改」，正常结束 |
| 评审 | `03-review.json` | 提案在、督导不在 → 下次会话起点自动重挂 |
| 采纳 | `04-decision.json` | 自动采纳关着 → 面板待审批页批准 |

### 一个工作区开两个 pi

同时开两个 pi 窗口（或一个在跑、另开一个）时：

- **复盘派发**：`locks/dispatch` 原子锁，任意时刻只有一个 run 在跑，另一个只写一条 `skipped(busy)`
- **重挂督导**：`locks/supervisor` + 抢到锁后复核 `supervisorPid`，只有一边起督导，另一边记「另一个 pi 实例正在重挂督导」
- **扫队列 / 采纳**：`locks/apply` 独占，「读-改-写 `queue.json`」与应用 diff 不会被两边同时做；抢不到的那一边跳过，下次 `settle` / 会话起点再来
- **Web 面板**：`locks/web.json` 记持有者，第二个实例不抢端口，只在日志里说「由 pid N 持有」；`/skill-evolve status` 在任何一边都能看到面板地址

### 重启恢复

`/reload` 或重启会丢掉内存里的收尸逻辑（`watchRunChild` 的回调），所以 `session_start` 会跑一次恢复：补 `analyzed` 状态、重挂被带走的督导、其余不动。**永不重跑复盘**（花 token 且会覆盖已有产物），有动作时用一行通知说明补了什么。

## 配置

`.pi/evolution/config.json`（建议 gitignore，开关是本机偏好）：

```json
{
  "enabled": false,
  "telemetry": false,
  "web": { "enabled": true, "port": 7788 },
  "idleMs": 90000,
  "maxRuntimeMs": 1200000,
  "perSessionCap": 20
}
```

## 数据落在哪

全在**被管理的工作区**的 `.pi/evolution/`：

```
config.json          开关（建议 gitignore）
telemetry/*.jsonl    采集流水账（建议 gitignore）
runs/<runId>/        每次复盘：01-findings / 02-proposal / 03-review / 04-decision / child.log
queue.json           待批 / 已采纳 / 回滚（建议 gitignore）
baseline.json        存量违规基线（建议入库）
logs/                扩展日志（建议 gitignore）
```

建议在目标仓库 `.gitignore`：

```
.pi/evolution/{config.json,telemetry,logs,locks,queue.json,metrics.jsonl,runs/*/{child.log,supervisor.log,run-error.json,00-session,candidate}}
```

## 安全边界

- 面板只监听 `127.0.0.1`，无远程访问面
- 提案永远只写到 `runs/<runId>/candidate/`，不直接改 `.pi/skills`
- 采纳需过五道闸，任何写前有备份，可回滚
- 「自动复盘」会启动 `pi -p` 子进程（独立进程、独立上下文），可在面板或命令里随时关掉

## 来源

本包是 `vkk_client_flutter` 仓库内 `.pi/extensions/skill-evolve` 的镜像，源码与测试以该仓库为准。
