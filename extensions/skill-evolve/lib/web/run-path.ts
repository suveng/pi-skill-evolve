/**
 * runId → run 目录的唯一解析口。
 *
 * 为什么要有这一层：runId 来自 URL query（`/log?runId=`）与表单（`name=rerun`），是**用户可控输入**。
 * `path.join(runs, "../../etc/passwd")` 是完全合法的 join，所以「拼路径」之前必须先做两道：
 * 字符白名单 + 解析后必须仍在 `runs/` 下。少一道就有目录穿越 —— 面板能读的日志盘上任何文件都能读。
 */
import * as path from "node:path";

/** 白名单：`/`、`\`、`..`（单独作为一段）都会被这道挡掉，`.` 与 `-` 是 runId 里真会出现的 */
export const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/** 合法且不越界返回绝对路径，否则 null（调用方一律按 404 / 400 处理） */
export function resolveRunDir(evolutionDir: string, runId: string): string | null {
  const trimmed = runId.trim();
  if (!SAFE_RUN_ID.test(trimmed)) return null;
  // 白名单已经排除了分隔符，真正兜底的是这一句：解析后父目录必须正好是 runs/
  const runsRoot = path.resolve(evolutionDir, "runs");
  const runDir = path.resolve(runsRoot, trimmed);
  return path.dirname(runDir) === runsRoot ? runDir : null;
}
