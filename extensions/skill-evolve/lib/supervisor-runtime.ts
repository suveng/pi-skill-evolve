/**
 * 督导运行目录：把督导要用的 `.ts` 拷到 `node_modules` 之外再跑。
 *
 * 2026-11-09 事故：`node --experimental-strip-types` 对 **node_modules 下的 .ts 一律拒绝**
 * （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。扩展按本地 `.pi/extensions/*.ts` 装时一切正常，
 * 一旦按 npm 包装进 `.pi/npm/node_modules/`，评审督导一启动就崩在 import 那一步 ——
 * 结果 `autoReview` / `autoApply` 全成了装饰品，用户只看到 run 停在 analyzed。
 *
 * 解法：首次使用时把督导的源目录整份复制到 `<evolutionDir>/runtime/supervisor/<key>/`（普通目录，
 * 类型剥离不再受限），再从那里起进程。`key` 由版本 + 入口文件 mtime/size 组成，升级自动换目录，
 * 旧目录顺手清掉；拷贝失败（只读盘等）就退回原路径，行为不比现在更差。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 运行目录名：`<evolutionDir>/runtime/supervisor/` */
export const RUNTIME_DIRNAME = "supervisor";

/** 缓存键里的稳定前缀：node_modules 路径太长，只留可读的一段 */
const KEY_PREFIX = "lib";

/** 只拷源码：测试、fixture、日志都不该跟着搬 */
const COPY_FILTER = (src: string): boolean => !/(\.test\.|\.spec\.|\.log$|\.json\.tmp)/.test(src);

export interface RuntimeOptions {
  /** `.pi/evolution`：运行目录挂在它下面，随工作区走，不污染 node_modules */
  evolutionDir: string;
  /** 包内督导入口绝对路径（review-spawn 的 SUPERVISOR_SCRIPT） */
  scriptPath: string;
  /** 包版本：参与缓存键，升级后自动重建 */
  version?: string;
  log?: (msg: string) => void;
}

/** 只有 node_modules 里的 .ts 需要搬家；本地 `.pi/extensions` 安装原路径直接用 */
export function needsCopy(scriptPath: string): boolean {
  return /[\\/]node_modules[\\/]/.test(scriptPath);
}

/** 缓存键：版本 + 入口文件大小/mtime —— 内容一变就换目录，不需要手工清缓存 */
export function runtimeKey(scriptPath: string, version?: string): string {
  const parts: string[] = [KEY_PREFIX];
  const label = version ?? packageVersionOf(scriptPath);
  if (label && /^[0-9A-Za-z._-]+$/.test(label)) parts.push(label);
  try {
    const stat = fs.statSync(scriptPath);
    parts.push(String(stat.size), String(Math.trunc(stat.mtimeMs)));
  } catch {
    parts.push("unknown"); // 读不到 stat 也不抛：目录照样能建，只是键退化成常量
  }
  return parts.join("-");
}

/** 包版本：找不到 package.json 就返回空串（只影响缓存键的写法，不影响能否跑） */
export function packageVersionOf(scriptPath: string): string {
  let dir = path.dirname(scriptPath);
  for (let i = 0; i < 6; i += 1) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown };
      if (typeof raw.version === "string") return raw.version;
      return "";
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "";
}

/** 目标目录（导出给面板 / 测试用，不产生副作用） */
export function runtimeDirOf(evolutionDir: string, key: string): string {
  return path.join(evolutionDir, "runtime", RUNTIME_DIRNAME, key);
}

/**
 * 返回**可以直接 spawn 的督导入口路径**：
 * node_modules 里 → 复制后的副本；其它位置 → 原路径。
 */
export function ensureSupervisorRuntime(options: RuntimeOptions): string {
  const { scriptPath } = options;
  if (!needsCopy(scriptPath)) return scriptPath;
  const key = runtimeKey(scriptPath, options.version);
  const target = runtimeDirOf(options.evolutionDir, key);
  const entry = path.join(target, path.basename(scriptPath));
  // 已经有完整副本（.ready 与入口都在）就直接复用：督导每次派发都要解析一次路径，不能每次都拷 700KB
  if (fs.existsSync(path.join(target, ".ready")) && fs.existsSync(entry)) return entry;
  const source = path.dirname(scriptPath);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 先拷到临时目录再 rename：两个 run 同时派发时不会读到半份源码
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(source, tmp, { recursive: true, filter: COPY_FILTER });
    fs.writeFileSync(path.join(tmp, ".ready"), `${key}\n`, "utf8");
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      // 另一个进程刚好建好了同一个 key：以它的为准，清掉自己这份临时目录
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(entry)) throw error;
    }
    pruneOldRuntimes(path.dirname(target), key);
    return entry;
  } catch (error) {
    options.log?.(`[skill-evolve] 督导运行目录准备失败（回退到原路径，评审仍会失败）：${String(error)}`);
    return scriptPath;
  }
}

/** 清掉同一个父目录下的旧 key：升级后旧副本没人用，留着只会占空间 */
function pruneOldRuntimes(parent: string, keep: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep || name.includes(".tmp-")) continue;
    try {
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    } catch {
      // 别的进程正在用（Windows 上 rename 会撞）：下次再清
    }
  }
}
