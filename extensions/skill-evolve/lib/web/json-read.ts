/**
 * 只读面板的防御式 JSON 读取：`runs/` 里的文件随时可能「写到一半被 kill」，
 * 所以所有解析都走这里 —— 读不到 / 坏 JSON 一律 null，调用方各自退化成空，绝不让一页 500。
 */
import * as fs from "node:fs";
import { DISPOSITIONS } from "../attribution.ts";

export function readJson<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 归因编码（A~E / semantic / F / G）加一句中文标签：光看字母没人知道 B 是 frontmatter 坏 */
export function reasonLabel(code: string): string {
  const disposition = DISPOSITIONS[code as keyof typeof DISPOSITIONS];
  return disposition ? `${code} ${disposition.label}` : code;
}
