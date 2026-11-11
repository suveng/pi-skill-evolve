/**
 * 会话详情页的**读盘层**：从 sessionId 找到会话 .jsonl 绝对路径，读出来交给解析器。
 *
 * 两条来源（顺序固定）：
 * 1. run.json 里已经写着 `sessionFile`（pi 派发时写下的绝对路径）；`?file=` 参数同理，但要**过安全闸**；
 * 2. 该路径已不在本机（换了机器 / 清理过 sessions），就按 sessionId 在
 *    `~/.pi/agent/sessions/*​/*.jsonl` 里按文件名反查 —— 文件名形如
 *    `2026-11-08T02-48-52-675Z_<sessionId>.jsonl`，所以「文件名含 sessionId」就是精确命中。
 *
 * 安全闸（面板虽然是 127.0.0.1，但 query 参数来自浏览器，不能当可信路径用）：
 * 只接受 **realpath 落在 sessions 根目录之下**、且**文件名含 sessionId**、且以 `.jsonl` 结尾的文件。
 * 三条同时成立才读 —— 少了任何一条，`?file=/etc/passwd` 就能读到任意文件。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listRuns } from "../runs.ts";
import { parseSessionText, type SessionTranscript } from "./session-view.ts";

/** sessionId 只允许这些字符：它会被当文件名匹配词，绝不允许 `/` 之类进到路径里 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{4,128}$/;

/** 反查 runs 时要扫多少条（与 data.ts 的 SCAN_LIMIT 同量级，够覆盖最近这批 run） */
const RUN_SCAN_LIMIT = 100;

export interface SessionSource {
  sessionId: string;
  /** 子进程（分析 / 评审 / 重写 Agent）的会话：面板用 runId+agent 定位，不走用户会话目录 */
  agent?: { runId: string; role: string };
  /** 解析到的会话原文绝对路径；找不到 = null */
  file: string | null;
  /** 文件字节数（找不到 = 0） */
  sizeBytes: number;
  /** 解析结果；找不到文件 = null */
  transcript: SessionTranscript | null;
}

/** pi 会话根目录：`~/.pi/agent/sessions`（测试用 home 覆盖，绝不读真实目录） */
export function sessionsRoot(home?: string): string {
  return path.join(home ?? os.homedir(), ".pi", "agent", "sessions");
}

/** 规范化 sessionId：不合法返回 null（调用方据此直接给「会话文件已不在本机」） */
export function safeSessionId(raw: string): string | null {
  const trimmed = raw.trim();
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** 路径是否真在根目录之下（用 realpath 比，符号链接绕不出去） */
function insideRoot(root: string, file: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    return realFile.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}

/** 文件本身是不是这个会话的原文：basename 含 sessionId、后缀 .jsonl、且在根目录内 */
function isSessionFile(root: string, sessionId: string, file: string): boolean {
  if (!file.endsWith(".jsonl")) return false;
  if (!path.basename(file).includes(sessionId)) return false;
  return insideRoot(root, file);
}

/**
 * 按 sessionId 在 sessions 根目录下反查（一层子目录，pi 按项目路径分目录）。
 * 命中多条时取文件名最大的那条：名字以 ISO 时间开头，字典序最大 = 最近一次会话。
 */
export function findSessionFile(sessionId: string, root: string): string | null {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(root, dir.name);
    let names: string[];
    try {
      names = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl") || !name.includes(sessionId)) continue;
      if (found === null || name > path.basename(found)) found = path.join(sub, name);
    }
  }
  return found !== null && isSessionFile(root, sessionId, found) ? found : null;
}

/** 解析会话文件路径：先试给定路径（过安全闸），不行再按 sessionId 反查 */
export function resolveSessionFile(input: { sessionId: string; file?: string | null; root: string }): string | null {
  const { sessionId, file, root } = input;
  if (file !== null && file !== undefined && file.length > 0) {
    if (isSessionFile(root, sessionId, file)) return file;
  }
  return findSessionFile(sessionId, root);
}

/** run.json 里记着的会话路径：同 sessionId 的 run 里挑最近一条（队列条目没有这个字段，只能反查） */
export function declaredSessionFile(evolutionDir: string, sessionId: string): string | null {
  const runs = listRuns(evolutionDir, RUN_SCAN_LIMIT);
  for (const run of runs) {
    if (run.sessionId === sessionId && run.sessionFile !== null && run.sessionFile.length > 0) return run.sessionFile;
  }
  return null;
}

/**
 * 读出会话原文并解析。找不到文件不抛错：页面要显示「会话文件已不在本机」这句人话，
 * 而不是一个 500 或空白页。
 */
/** agent 会话的角色白名单：与 spawn 时用的 `se-<role>.jsonl` 一致 */
export const AGENT_ROLE = /^(?:analyze|review|rewrite-\d+)$/;

/**
 * 读 run 目录下某个 Agent 的会话（`runs/<runId>/agents/*_se-<role>.jsonl`）。
 * 路径全部拼自 runId/role 两个已校验字段，外部传不进任意路径。
 */
export function readAgentSessionSource(input: {
  evolutionDir: string;
  runId: string;
  role: string;
}): SessionSource {
  const runId = input.runId.trim();
  const role = input.role.trim();
  const empty = (): SessionSource => ({
    sessionId: `${runId.slice(0, 8)}/${role}`,
    agent: { runId, role },
    file: null,
    sizeBytes: 0,
    transcript: null,
  });
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes("..")) return empty();
  if (!AGENT_ROLE.test(role)) return empty();
  const dir = path.join(input.evolutionDir, "runs", runId, "agents");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return empty();
  }
  const hit = names.filter((name) => name.endsWith(`_se-${role}.jsonl`)).sort().at(-1);
  if (hit === undefined) return empty();
  const file = path.join(dir, hit);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return empty();
  }
  return {
    sessionId: `${runId.slice(0, 8)}/${role}`,
    agent: { runId, role },
    file,
    sizeBytes: Buffer.byteLength(raw, "utf8"),
    transcript: parseSessionText(raw),
  };
}

export function readSessionSource(input: {
  evolutionDir: string;
  sessionId: string;
  file?: string | null;
  home?: string;
}): SessionSource {
  const sessionId = safeSessionId(input.sessionId);
  const root = sessionsRoot(input.home);
  if (sessionId === null) return { sessionId: input.sessionId.trim(), file: null, sizeBytes: 0, transcript: null };
  const declared = input.file ?? declaredSessionFile(input.evolutionDir, sessionId);
  const file = resolveSessionFile({ sessionId, file: declared, root });
  if (file === null) return { sessionId, file: null, sizeBytes: 0, transcript: null };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // 目录在但文件被删 / 没权限：与「不在本机」同一句话，不暴露系统错误
    return { sessionId, file: null, sizeBytes: 0, transcript: null };
  }
  return { sessionId, file, sizeBytes: Buffer.byteLength(raw, "utf8"), transcript: parseSessionText(raw) };
}
