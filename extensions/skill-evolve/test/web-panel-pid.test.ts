/**
 * 「面板记录」与「端口占用提示」：真监听 127.0.0.1（port=0 取随机端口），不起 node/pi 子进程。
 *
 * 为什么要单一个文件：这组用例验的是 `locks/web.json` 的写入/清除与占用文案判读，
 * 与 HTTP 路由白名单无关；放回 web-server.test.ts 会把那个文件顶过 500 行闸门。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readWebPid, writeWebPid } from "../lib/web/panel-pid.ts";
import { startWebPanel, type WebPanel, type WebPanelOptions } from "../lib/web/server.ts";

/** 不存在的 pid：Linux 的 pid_max 远小于 INT32_MAX，这个号系统里不会有进程 */
const DEAD_PID = 2_147_483_646;

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-webpanelpid-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  return evolutionDir;
}

function pidFile(evolutionDir: string): string {
  return path.join(evolutionDir, "locks", "web.json");
}

async function open(evolutionDir: string, extra: Partial<WebPanelOptions> = {}): Promise<WebPanel> {
  const result = await startWebPanel({ evolutionDir, port: 0, ...extra });
  assert.equal(result.ok, true, `面板应该起来：${result.ok ? "" : result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result.panel;
}

test("起监听即落 locks/web.json：pid 是本进程、url 带实际端口，close() 后消失", async () => {
  const evolutionDir = workspace();
  const panel = await open(evolutionDir);
  try {
    const record = readWebPid(evolutionDir);
    assert.ok(record, "起监听之后必须有记录");
    assert.equal(record.pid, process.pid);
    // port: 0 时写的是内核分配的实际端口，不是请求值
    assert.equal(record.port, panel.port);
    assert.equal(record.url, panel.url);
    assert.equal(Number.isFinite(record.startedAt), true);
  } finally {
    await panel.close();
  }
  assert.equal(fs.existsSync(pidFile(evolutionDir)), false, "close() 后记录要删掉");
});

test("close() 只删自己的记录：文件被换成别的 pid 时保留", async () => {
  const evolutionDir = workspace();
  const panel = await open(evolutionDir);
  writeWebPid(evolutionDir, { pid: DEAD_PID, host: "127.0.0.1", port: panel.port, url: panel.url, startedAt: Date.now() });
  await panel.close();
  assert.equal(fs.existsSync(pidFile(evolutionDir)), true, "别人的记录不能被本实例抹掉");
  assert.equal(readWebPid(evolutionDir)?.pid, DEAD_PID);
});

test("端口被占且记录活着：提示「已在 … 运行」带 pid，而不是让人去 kill", async () => {
  const evolutionDir = workspace();
  const first = await open(evolutionDir);
  try {
    const second = await startWebPanel({ evolutionDir, port: first.port });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("同端口不该起来第二份");
    assert.equal(second.code, "EADDRINUSE");
    assert.equal(second.message.includes(`已在 ${first.url} 运行`), true);
    assert.equal(second.message.includes(`pid ${process.pid}`), true);
    assert.match(second.message, /起于 \d{4}-\d{2}-\d{2}T/);
    assert.match(second.message, /\/skill-evolve web --port 7799/);
    assert.equal(second.message.includes("不要直接 kill"), false, "认出是本机面板就不该建议 kill 排查");
  } finally {
    await first.close();
  }
});

test("端口被占但记录是死的：维持占用文案，提醒先 lsof 看 COMMAND 再动手", async () => {
  const evolutionDir = workspace();
  const first = await open(evolutionDir);
  const port = first.port;
  try {
    // 记录换成已死 pid：说明占端口的不是本机面板记录的那个实例
    writeWebPid(evolutionDir, { pid: DEAD_PID, host: "127.0.0.1", port, url: first.url, startedAt: Date.now() });
    const second = await startWebPanel({ evolutionDir, port });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("同端口不该起来第二份");
    assert.equal(second.message.includes("已在 "), false, "记录是死的就不能说面板在跑");
    assert.match(second.message, /已被占用/);
    assert.match(second.message, new RegExp(`lsof -nP -iTCP:${port} -sTCP:LISTEN`));
    assert.match(second.message, /不要直接 kill/);
  } finally {
    await first.close();
  }
});
