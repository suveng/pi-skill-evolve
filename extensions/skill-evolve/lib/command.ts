/**
 * `/skill-evolve` 的子命令路由与补全：只产出展示文本，方便单测。
 */
import { runConfigCommand } from "./config-command.ts";
import type { ConfigFlag } from "./config.ts";
import type { Evolution } from "./evolution.ts";
import { COMMAND_FLAG, FLAG_EFFECT, FLAG_LABEL } from "./flags.ts";
import type { WebLaunchRequest } from "./web/autostart.ts";

export interface SubcommandItem {
  value: string;
  label: string;
  description: string;
}

export const SUBCOMMANDS: readonly SubcommandItem[] = [
  { value: "status", label: "status", description: "开关、去抖、锁、最近 run" },
  { value: "report", label: "report", description: "近 7 天曝光/加载/未命中；--week 出周报（含零加载候选）" },
  { value: "run", label: "run", description: "立即派发一次复盘（跳过去抖与上限，仍守全局锁）" },
  { value: "baseline", label: "baseline", description: "把当前 P0 命中全部接受为存量（--reset 清空清单）" },
  { value: "selftest", label: "selftest", description: "跑三个坏样本：评审器必须 reject/reject/revise，否则流水线停用" },
  { value: "approve", label: "approve", description: "采纳某条 run（走五道闸）；--prune 只生成删技能清单，不真删" },
  { value: "queue", label: "queue", description: "列采纳队列：pending / applied / rolled-back / failed / superseded" },
  { value: "web", label: "web", description: "启动本机 Web 面板（127.0.0.1:7788，--port N 换端口，--once 不写进配置）" },
  { value: "config", label: "config", description: "选提案/评审模型（inherit = 跟随主会话）" },
  { value: "collect", label: "collect", description: "只开/关遥测采集（on|off；只写本地日志，不花 token）" },
  { value: "review", label: "review", description: "只开/关自动复盘（on|off；会派生子进程，花 token）" },
  { value: "on", label: "on", description: "采集与派生一起打开" },
  { value: "off", label: "off", description: "采集与派生一起关闭" },
];

/** 补全：前缀命中就只给命中项；一个都没命中时给全量，避免用户看到空列表 */
export function matchSubcommand(prefix: string): SubcommandItem[] {
  const head = prefix.trim();
  const hit = SUBCOMMANDS.filter((item) => item.value.startsWith(head));
  return hit.length > 0 ? [...hit] : [...SUBCOMMANDS];
}

/** 命令需要知道「当前会话」才能手动派发，所以会话标识由调用方（index.ts）传入 */
export interface CommandTarget {
  sessionId: string;
  sessionFile?: string;
  /**
   * `/skill-evolve web` 的启动器：面板必须由扩展持有单例并在 session_shutdown 关掉，
   * 所以这里只注入一个回调，参数解析与文案留在本文件（可单测）。
   */
  web?: (request: WebLaunchRequest) => Promise<string>;
}

/** `web [--port N] [N] [--once]`：`--once` 表示只本次会话起、不写回配置 */
export function parseWebArgs(args: readonly string[]): WebLaunchRequest {
  const once = args.includes("--once");
  // `--port 7799` 与 `web 7799` 两种写法都认；`--port` / `--once` 本身不能当端口解析
  const port = parseWebPort(args.find((item) => item !== "--port" && item !== "--once"));
  return port === undefined ? { once } : { once, port };
}

/** `web [--port N]` / `web [N]`：只认 1~65535 的整数，其余返回 undefined 用默认端口 */
export function parseWebPort(arg: string | undefined): number | undefined {
  if (!arg) return undefined;
  const value = Number.parseInt(arg, 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
}

export async function runCommand(args: string, evo: Evolution, target: CommandTarget): Promise<string> {
  const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
  const [name, arg] = parts;
  const command = name && name.length > 0 ? name : "status";
  if (command === "report") {
    // `--week` 是 M6 的周报：加载率 / 归因分布 / 冲突密度 / 采纳率 / 回滚率 / 进化收益 + 零加载候选
    if (arg === "--week") return evo.observe.weekReportText();
    const days = Number.parseInt(arg ?? "", 10);
    return evo.reportText(Number.isFinite(days) && days > 0 ? days : 7);
  }
  if (command === "run") return evo.runNow(target);
  if (command === "baseline") return evo.acceptBaseline(arg === "--reset" ? "reset" : "accept");
  if (command === "selftest") return evo.model.selftestText();
  // 非 TUI 兜底：真正能交互选模型的路径在 index.ts（那里才拿得到 ctx.ui.select）
  if (command === "config") return runConfigCommand(null, evo.model, arg);
  if (command === "on" || command === "off") return evo.setEnabled(command === "on");
  // `collect on|off` 只动 telemetry、`review on|off` 只动 enabled：缺参数或写错就给用法，一概不改配置
  if (command === "collect" || command === "review") {
    const field: ConfigFlag = COMMAND_FLAG[command];
    const value = arg === "on" ? true : arg === "off" ? false : null;
    if (value === null) {
      return `用法：/skill-evolve ${command} on|off —— 只改「${FLAG_LABEL[field]}」（${FLAG_EFFECT[field]}），配置未改动`;
    }
    return evo.setFlag(field, value);
  }
  if (command === "queue") return evo.apply.queueText();
  if (command === "web") {
    if (!target.web) return "用法：/skill-evolve web [--port N] [--once]\n当前环境没有注入面板启动器（只在 pi 会话里可用）";
    return target.web(parseWebArgs(parts.slice(1)));
  }
  // approve 可能带第二个参数（`--prune`），所以这里直接用整串剩余部分
  if (command === "approve") return evo.apply.approve(arg ?? "", parts.includes("--prune"));
  if (command === "status") return evo.statusText();
  const usage = SUBCOMMANDS.map((item) => item.value).join("|");
  return `未知子命令：${command}\n用法：/skill-evolve [${usage}]`;
}
