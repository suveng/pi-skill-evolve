/**
 * 「清理记录」的落地：把 `runs/<runId>/` 移到 `runs/.trash/<runId>-<时间戳>/`。
 *
 * 为什么是移动而不是删除：清理只是把卡死的 run 从列表里挪走，数据必须还能捞回来 ——
 * 复盘目录里有会话原文、findings、候选稿，删掉就真没了。`.trash/` 已在 .gitignore 里，
 * 要腾空间时由人手动 rm，不由一次网页点击决定。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRunDir } from "./run-path.ts";

export const TRASH_DIR = ".trash";

/** 目录名里的时间戳：人读得懂，且同一 run 多次清理不会撞名 */
function stamp(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 移动成功返回一句人话（带相对路径，方便人去捞）。
 * 失败抛 Error：所有「不该发生」的分支都在这里挡住，绝不静默跳过 —— 静默跳过会让人以为清掉了，其实还在列表里。
 */
export function moveRunToTrash(evolutionDir: string, runId: string, now = Date.now()): string {
  const runDir = resolveRunDir(evolutionDir, runId);
  if (runDir === null) throw new Error(`runId 不合法：${runId}`);
  if (!fs.existsSync(runDir)) throw new Error(`找不到 run 目录：runs/${runId}`);
  const trashRoot = path.join(evolutionDir, "runs", TRASH_DIR);
  fs.mkdirSync(trashRoot, { recursive: true });
  const target = path.join(trashRoot, `${runId}-${stamp(now)}`);
  // rename 到已存在的目录会在部分平台上静默合并，所以先显式拒绝（同一秒内点两次就会碰到）
  if (fs.existsSync(target)) throw new Error(`目标已存在，未移动：runs/${TRASH_DIR}/${path.basename(target)}`);
  fs.renameSync(runDir, target);
  return `已清理 ${runId}：移动到 runs/${TRASH_DIR}/${path.basename(target)}（可逆，没有删数据）`;
}
