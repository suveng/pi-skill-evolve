/**
 * 面板的 HTTP 底层小工具：发响应、303 回跳、Host/Origin 校验、读表单体。
 *
 * 抽出来只有一个理由：写操作（actions.ts）与路由（server.ts）都要用，而这套校验必须只有一份 ——
 * 两处各写一遍，迟早出现「/action 比 /approve 松一点」的洞。
 */
import type * as http from "node:http";

export const HTML_TYPE = "text/html; charset=utf-8";
export const TEXT_TYPE = "text/plain; charset=utf-8";
export const FORM_TYPE = "application/x-www-form-urlencoded";
/** 表单请求体上限：几个 hidden 字段 + runId，2KB 已经是一百倍余量；超了就是有人在探 */
export const MAX_BODY_BYTES = 2048;

export function sendText(res: http.ServerResponse, status: number, text: string, type = TEXT_TYPE): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(text);
}

/**
 * 303 回跳：结果首行进 query，页面顶部渲染成横幅；绝不把错误变成 500 页。
 * `view` 决定回哪一页 —— 审批动作回待审批页，控制条动作回点按钮时那一页。
 */
export function sendBack(
  res: http.ServerResponse,
  key: "msg" | "err",
  text: string,
  view = "approvals",
): void {
  // 首行够用：approve 的结论是多行五闸明细，全塞进 URL 只会又长又难读
  const line = text.split("\n")[0]!.trim().slice(0, 300) || (key === "msg" ? "完成" : "失败（无详情）");
  res.writeHead(303, {
    location: `/?view=${view}&${key}=${encodeURIComponent(line)}`,
    "content-type": TEXT_TYPE,
    "cache-control": "no-store",
  });
  res.end(`${line}\n`);
}

/**
 * Host / Origin 校验：只认本机当前端口。
 *
 * 浏览器同源表单提交一定带 `Origin: http://<Host>`，所以两者一致就够了；
 * 命令行 curl 不带 Origin（也就不带浏览器自动附带的凭据），此时靠 csrf 兜底。
 */
export function sourceDenied(request: http.IncomingMessage, port: number): string | null {
  const host = String(request.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return "Host 头不在白名单（只认 127.0.0.1 / localhost 的当前端口）";
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return "Origin 头与面板地址不一致";
  return null;
}

/** 读表单请求体：超过上限返回 null（继续把剩余的流读掉，避免客户端卡在写一半） */
export function readBody(request: http.IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= limit) chunks.push(chunk);
    });
    request.on("end", () => resolve(total > limit ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}
