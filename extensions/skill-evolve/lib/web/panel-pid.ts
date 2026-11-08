/**
 * 「谁持有 Web 面板」的落盘记录：`.pi/evolution/locks/web.json`。
 *
 * 为什么要有它：面板的 HTTP 服务跑在 pi 进程内（见 ./server.ts），端口被占时
 * `lsof -ti:7788 | xargs kill` 会连 pi 一起杀掉。把「pid + 地址 + 起于何时」写下来，
 * 说「端口被占」时才能分清「本机面板在跑」与「别的服务占了端口」，清理动作不必靠猜 PID。
 *
 * 三条边界：
 * 1. **只记事实，不承担互斥**：跨进程互斥是 lib/lock.ts 的 dispatch 目录锁；这份文件坏了当没有，
 *    绝不能让面板因为记录文件起不来；
 * 2. **写失败只记日志**：此时面板已经监听成功，丢记录顶多让「占用提示」少一层判读依据；
 * 3. **删记录要比 pid**：只有文件里的 pid 就是调用方时才删，否则会抹掉另一个实例的活记录。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isPidAlive } from "../lock.ts";

/** 记录文件的相对位置（相对 evolutionDir）；绝对路径见 webPidFile() */
export const WEB_PID_FILE = path.join("locks", "web.json");

export interface WebPidInfo {
  /** 持有面板的进程（= pi 主进程）pid */
  pid: number;
  host: string;
  /** 实际监听端口：`port: 0` 时是内核分配的端口，不是请求值 */
  port: number;
  /** 面板地址（`http://host:port`），提示语直接给用户复制 */
  url: string;
  /** 起监听的毫秒戳 */
  startedAt: number;
}

export function webPidFile(evolutionDir: string): string {
  return path.join(evolutionDir, WEB_PID_FILE);
}

/** 默认日志口：面板已经在跑，记录写失败只能落日志，不能反过来把面板搞挂 */
const defaultLog = (msg: string): void => console.error(msg);

/**
 * 写记录（原子）：先写 `web.json.tmp` 再 rename —— 同盘 rename 是原子的，
 * 读方永远看不到半截 JSON。任何失败都只记日志、不抛、不留 `.tmp` 垃圾。
 */
export function writeWebPid(evolutionDir: string, info: WebPidInfo, log: (msg: string) => void = defaultLog): void {
  const file = webPidFile(evolutionDir);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    log(`[skill-evolve] 写 Web 面板记录失败（面板本身照常运行）：${String(error)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 读方只认 web.json，.tmp 清不掉也不影响判读
    }
  }
}

/**
 * 读记录：坏 JSON、类型不对、字段缺失都返回 null（调用方一律按「没有记录」处理）。
 * `port` / `startedAt` 也要求合法，否则提示语会出现 `NaN` 或 1970 年这种假信息。
 */
export function readWebPid(evolutionDir: string): WebPidInfo | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(webPidFile(evolutionDir), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const info = raw as Partial<WebPidInfo>;
    const { pid, host, port, url, startedAt } = info;
    if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
    if (typeof host !== "string" || host.length === 0) return null;
    if (!Number.isInteger(port) || (port as number) <= 0) return null;
    if (typeof url !== "string" || url.length === 0) return null;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
    return { pid: pid as number, host, port: port as number, url, startedAt: startedAt as number };
  } catch {
    return null;
  }
}

/**
 * 删记录：只有文件里的 pid 等于调用方 pid 时才删。
 * 别人的记录（或读不出来的坏记录）一律不动 —— 无法证明是自己写的，就不该改。
 */
export function clearWebPid(evolutionDir: string, callerPid: number, log: (msg: string) => void = defaultLog): void {
  const record = readWebPid(evolutionDir);
  if (!record || record.pid !== callerPid) return;
  try {
    fs.rmSync(webPidFile(evolutionDir), { force: true });
  } catch (error) {
    log(`[skill-evolve] 删 Web 面板记录失败：${String(error)}`);
  }
}

/** pid 是否存活：与跨进程锁同一条判据（EPERM = 进程在、只是无权发信号，同样算活） */
export function isAlive(pid: number): boolean {
  return isPidAlive(pid);
}
