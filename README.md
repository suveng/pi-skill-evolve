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

`http://127.0.0.1:7788` —— 六个 tab：待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告 / 技能管理。

只绑 `127.0.0.1`、零鉴权、写操作带 CSRF 与同源校验；远程看用 `ssh -L 7788:127.0.0.1:7788`。

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
