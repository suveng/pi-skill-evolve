/**
 * 只读面板的 HTTP 外壳：真监听 127.0.0.1（port=0 取随机端口）、路由白名单、只读 405、端口占用结构化报错。
 * 只起本地 http server，不起 pi / node 子进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WebState } from "../lib/web/data.ts";
import { writeWebPid } from "../lib/web/panel-pid.ts";
import { startWebPanel, type WebPanel, type WebPanelOptions } from "../lib/web/server.ts";

/** 不存在的 pid：Linux 的 pid_max 远小于 INT32_MAX，这个号系统里不会有进程 */
const DEAD_PID = 2_147_483_646;

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-webserver-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  // 一条待人批的队列记录：确保页面不是空态，tab 文案与列表都真的渲染出来
  fs.writeFileSync(
    path.join(evolutionDir, "queue.json"),
    JSON.stringify([
      {
        runId: "run-web",
        level: "approval",
        skill: "demo",
        targets: [".pi/skills/demo/SKILL.md"],
        createdAt: Date.UTC(2026, 10, 8, 12),
        status: "pending",
      },
    ]),
    "utf8",
  );
  return evolutionDir;
}

const FORM = "application/x-www-form-urlencoded";

async function open(evolutionDir: string, port = 0, extra: Partial<WebPanelOptions> = {}): Promise<WebPanel> {
  const result = await startWebPanel({ evolutionDir, port, ...extra });
  assert.equal(result.ok, true, `面板应该起来：${result.ok ? "" : result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result.panel;
}

test("GET /：真监听 127.0.0.1，返回四个 tab 与队列里的待批条目", async () => {
  const panel = await open(workspace());
  try {
    assert.match(panel.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(panel.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /待处理/);
    assert.match(html, /待审批/);
    assert.match(html, /已结束/);
    assert.equal(html.includes("复盘报告"), false, "复盘报告 tab 已下线");
    // 待批条目只出现在待审批页：待处理页不再重复列同一条（2026-11-10 去重）
    assert.equal(html.includes("run-web"), false, "待处理页不许再列待批条目");
    const approvals = await (await fetch(`${panel.url}/?view=approvals`)).text();
    assert.match(approvals, /<span class="badge blue"[^>]*>待审批<\/span>/);
    assert.match(approvals, /<td class="skill"><code>demo<\/code><\/td>/);
    assert.match(approvals, /<a class="rid" href="\/\?view=run&amp;runId=run-web"[^>]*>详情<\/a>/);
  } finally {
    await panel.close();
  }
});

test("GET /?view=done 与已下线的 ?view=reports：切视图走 query，非法值回落待处理", async () => {
  const panel = await open(workspace());
  try {
    const done = await (await fetch(`${panel.url}/?view=done`)).text();
    assert.match(done, /<title>技能进化 · 已结束<\/title>/);
    const gone = await (await fetch(`${panel.url}/?view=reports`)).text();
    assert.match(gone, /<title>技能进化 · 待处理<\/title>/, "下线的视图回落待处理");
    const bogus = await (await fetch(`${panel.url}/?view=nope`)).text();
    assert.match(bogus, /<title>技能进化 · 待处理<\/title>/);
  } finally {
    await panel.close();
  }
});

test("GET /api/state：合法 JSON 且带五个顶层字段", async () => {
  const panel = await open(workspace());
  try {
    const response = await fetch(`${panel.url}/api/state`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const state = (await response.json()) as WebState;
    assert.deepEqual(Object.keys(state).sort(), ["applied", "approvals", "done", "pending", "summary"]);
    assert.equal(state.pending.length, 0, "待批条目只在待审批页出现一次");
    assert.equal(state.approvals[0]?.runId, "run-web");
    assert.equal(state.summary.pendingApprovals, 1);
  } finally {
    await panel.close();
  }
});

test("非 GET 一律 405 且带 allow: GET（面板不能写）", async () => {
  const panel = await open(workspace());
  try {
    const response = await fetch(panel.url, { method: "POST", body: "x" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    // 405 之后面板照常工作：没有被写状态
    assert.equal((await fetch(panel.url)).status, 200);
  } finally {
    await panel.close();
  }
});

test("白名单之外一律 404：不接受任意文件读取", async () => {
  const panel = await open(workspace());
  try {
    const passwd = await fetch(`${panel.url}/etc/passwd`);
    assert.equal(passwd.status, 404);
    const body = await passwd.text();
    assert.equal(body.includes("root:"), false, "不能把文件内容吐出来");
    assert.equal((await fetch(`${panel.url}/../.pi/evolution/queue.json`)).status, 404);
    assert.equal((await fetch(`${panel.url}/api/state/extra`)).status, 404);
  } finally {
    await panel.close();
  }
});

test("close() 幂等，关闭后可以从同一端口重新 start", async () => {
  const evolutionDir = workspace();
  const first = await open(evolutionDir);
  const port = first.port;
  await first.close();
  await first.close(); // 重复关闭不抛 ERR_SERVER_NOT_RUNNING
  await assert.rejects(fetch(`${first.url}/api/state`), "关闭后旧连接不再服务");

  const second = await open(evolutionDir, port);
  try {
    assert.equal((await fetch(`${second.url}/api/state`)).status, 200);
  } finally {
    await second.close();
  }
});

test("端口占用返回结构化 EADDRINUSE，不抛栈", async () => {
  const evolutionDir = workspace();
  const first = await open(evolutionDir);
  try {
    // 记录换成已死 pid：本用例只验结构化报错，不走「本机面板已在跑」那一支（那支在 web-panel-pid.test.ts）
    writeWebPid(evolutionDir, { pid: DEAD_PID, host: "127.0.0.1", port: first.port, url: first.url, startedAt: Date.now() });
    const second = await startWebPanel({ evolutionDir, port: first.port });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("同端口不该起来第二份");
    assert.equal(second.code, "EADDRINUSE");
    assert.match(second.message, /已被占用/);
    assert.match(second.message, /\/skill-evolve web --port/);
  } finally {
    await first.close();
  }
});

/** 记一次调用：POST 测试统一用这两个替身，不碰真写盘 */
function spy(result: string | Error = "已采纳 run-web"): { calls: string[]; fn: (runId: string) => Promise<string> } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (runId: string) => {
      calls.push(runId);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function form(fields: Record<string, string>): { method: "POST"; body: string; headers: Record<string, string> } {
  return {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { "content-type": FORM },
  };
}

/** 303 回跳：手动跟重定向，才看得到 location 与状态码 */
async function post(panel: WebPanel, pathname: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const init = form(fields);
  return fetch(`${panel.url}${pathname}`, { ...init, headers: { ...init.headers, ...headers }, redirect: "manual" });
}

test("GET /?view=approvals：列表带批准/拒绝表单与 csrf hidden（注入回调才算可写）", async () => {
  const approve = spy();
  const reject = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: reject.fn });
  try {
    const html = await (await fetch(`${panel.url}/?view=approvals`)).text();
    assert.match(html, /<title>技能进化 · 待审批<\/title>/);
    assert.match(html, /action="\/approve"/);
    assert.match(html, /action="\/reject"/);
    assert.match(html, new RegExp(`name="csrf" value="${panel.csrf}"`));
    assert.match(html, /name="runId" value="run-web"/);
    assert.match(html, /点「批准」= 在 TUI 敲/);
  } finally {
    await panel.close();
  }
});

test("POST /approve：csrf 正确 → onApprove 恰一次，303 回待审批页带 msg 首行", async () => {
  const approve = spy("已采纳 run-web（approval · 演示技能）\n第二行不进 URL");
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    const response = await post(panel, "/approve", { csrf: panel.csrf, runId: "run-web" });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location") ?? "", panel.url);
    assert.equal(location.pathname, "/");
    assert.equal(location.searchParams.get("view"), "approvals");
    assert.equal(location.searchParams.get("msg"), "已采纳 run-web（approval · 演示技能）");
    assert.deepEqual(approve.calls, ["run-web"], "只调一次，runId 原样传下去");
  } finally {
    await panel.close();
  }
});

test("POST /approve：csrf 不对 → 403，onApprove 一次都没被调", async () => {
  const approve = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    for (const csrf of ["wrong", ""]) {
      const response = await post(panel, "/approve", { csrf, runId: "run-web" });
      assert.equal(response.status, 403);
      assert.match(await response.text(), /csrf 校验失败/);
    }
    assert.deepEqual(approve.calls, []);
  } finally {
    await panel.close();
  }
});

test("POST /approve：Origin 是跨站的 http://evil.com → 403 且不执行", async () => {
  const approve = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    const response = await post(panel, "/approve", { csrf: panel.csrf, runId: "run-web" }, { origin: "http://evil.com" });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Origin 头与面板地址不一致/);
    assert.deepEqual(approve.calls, []);
    // 同源 Origin 是正常浏览器行为，必须放行
    const ok = await post(panel, "/approve", { csrf: panel.csrf, runId: "run-web" }, { origin: panel.url });
    assert.equal(ok.status, 303);
  } finally {
    await panel.close();
  }
});

/**
 * 裸 http 请求：fetch（undici）不让改 Host 头，而 Host 校验正是要挡的 DNS rebinding 面，
 * 所以这一条必须手写请求。仍然只连本机，不起任何子进程。
 */
function rawPost(panel: WebPanel, pathname: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: panel.host,
        port: panel.port,
        path: pathname,
        method: "POST",
        headers: { "content-type": FORM, "content-length": Buffer.byteLength(body), ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("POST /approve：Host 头不是本机当前端口 → 403（挡 DNS rebinding）", async () => {
  const approve = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    const body = new URLSearchParams({ csrf: panel.csrf, runId: "run-web" }).toString();
    const denied = await rawPost(panel, "/approve", body, { host: "evil.example.com:80" });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /Host 头不在白名单/);
    assert.deepEqual(approve.calls, [], "Host 不对时一个动作都不能执行");
    // 白名单里的 localhost 与 127.0.0.1 都要能过
    const allowed = await rawPost(panel, "/approve", body, { host: `127.0.0.1:${panel.port}` });
    assert.equal(allowed.status, 303);
  } finally {
    await panel.close();
  }
});

test("POST /approve：请求体超 2KB → 413 且不执行", async () => {
  const approve = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    const response = await post(panel, "/approve", { csrf: panel.csrf, runId: "run-web", pad: "x".repeat(4096) });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /超过 2048 字节/);
    assert.deepEqual(approve.calls, []);
  } finally {
    await panel.close();
  }
});

test("POST /approve：Content-Type 不是表单 → 415", async () => {
  const approve = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    const response = await fetch(`${panel.url}/approve`, {
      method: "POST",
      body: JSON.stringify({ csrf: panel.csrf, runId: "run-web" }),
      headers: { "content-type": "application/json" },
      redirect: "manual",
    });
    assert.equal(response.status, 415);
    assert.deepEqual(approve.calls, []);
  } finally {
    await panel.close();
  }
});

test("POST /approve：回调抛错 → 303 带 err，页面不变 500", async () => {
  const approve = spy(new Error("闸2 没通过：md-check 报错"));
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: spy().fn });
  try {
    const response = await post(panel, "/approve", { csrf: panel.csrf, runId: "run-web" });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location") ?? "", panel.url);
    assert.equal(location.searchParams.get("err"), "Error: 闸2 没通过：md-check 报错");
    assert.equal((await fetch(panel.url)).status, 200, "面板本身照常工作");
  } finally {
    await panel.close();
  }
});

test("POST /reject：csrf 正确 → onReject 恰一次，303 回待审批页带 msg", async () => {
  const reject = spy("已拒绝 run-web：技能文件未改动");
  const approve = spy();
  const panel = await open(workspace(), 0, { onApprove: approve.fn, onReject: reject.fn });
  try {
    const response = await post(panel, "/reject", { csrf: panel.csrf, runId: "run-web" });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location") ?? "", panel.url);
    assert.equal(location.searchParams.get("view"), "approvals");
    assert.equal(location.searchParams.get("msg"), "已拒绝 run-web：技能文件未改动");
    assert.deepEqual(reject.calls, ["run-web"]);
    assert.deepEqual(approve.calls, [], "拒绝不能走批准回调");
  } finally {
    await panel.close();
  }
});

test("没注入回调：待审批页无按钮，POST /approve 返回 403（不是 405，路径本身合法）", async () => {
  const panel = await open(workspace());
  try {
    const html = await (await fetch(`${panel.url}/?view=approvals`)).text();
    assert.equal(html.includes("<form"), false);
    assert.match(html, /本实例只读/);
    const response = await post(panel, "/approve", { csrf: panel.csrf, runId: "run-web" });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /本实例只读/);
  } finally {
    await panel.close();
  }
});

test("POST /：路径不在写白名单 → 405 且带 allow: GET", async () => {
  const panel = await open(workspace());
  try {
    const response = await post(panel, "/", { csrf: panel.csrf, runId: "run-web" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  } finally {
    await panel.close();
  }
});

test("csrf 由面板生成且唯一：两次 start 的令牌不同，显式传入则原样使用", async () => {
  const evolutionDir = workspace();
  const first = await open(evolutionDir);
  const second = await open(evolutionDir);
  try {
    assert.match(first.csrf, /^[0-9a-f-]{36}$/);
    assert.notEqual(first.csrf, second.csrf);
  } finally {
    await first.close();
    await second.close();
  }
  const fixed = await open(evolutionDir, 0, { csrf: "fixed-token", onApprove: spy().fn, onReject: spy().fn });
  try {
    assert.equal(fixed.csrf, "fixed-token");
    assert.match(await (await fetch(`${fixed.url}/?view=approvals`)).text(), /name="csrf" value="fixed-token"/);
  } finally {
    await fixed.close();
  }
});

/** 造一个真 run 目录，child.log 里有 lineCount 行（末行带序号，方便断言「只回尾部」） */
function runWithLog(lineCount: number, runId = "run-log"): string {
  const evolutionDir = workspace();
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const body = Array.from({ length: lineCount }, (_, index) => `第 ${index + 1} 行`).join("\n");
  fs.writeFileSync(path.join(runDir, "child.log"), `${body}\n`, "utf8");
  return evolutionDir;
}

test("POST /action：csrf 不对 → 403，一个回调都不执行（顺序与 /approve 一致）", async () => {
  let runs = 0;
  const panel = await open(workspace(), 0, {
    onRunNow: async () => {
      runs += 1;
      return "已派生复盘：run-new";
    },
  });
  try {
    const response = await post(panel, "/action", { csrf: "wrong-token", name: "run" });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /csrf 校验失败/);
    assert.equal(runs, 0, "csrf 不对时连 name 都不该被读");
  } finally {
    await panel.close();
  }
});

test("GET /log：runId 出白名单或解析后跑出 runs/ → 404，且不吐文件内容", async () => {
  const panel = await open(workspace());
  try {
    for (const bad of ["../../etc/passwd", "../queue.json", "a/b", "", ".."]) {
      const response = await fetch(`${panel.url}/log?runId=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 404, `runId=${bad} 必须 404`);
      assert.equal((await response.text()).includes("root:"), false);
    }
  } finally {
    await panel.close();
  }
});

test("GET /log：真实 run → 200 text/plain，带来源行与日志末行；没有 run 目录则 404", async () => {
  const evolutionDir = runWithLog(3);
  const panel = await open(evolutionDir);
  try {
    const response = await fetch(`${panel.url}/log?runId=run-log`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    const text = await response.text();
    assert.match(text, /^# run-log · child\.log（末 3 行）/);
    assert.match(text, /第 3 行/, "末行要在");
    assert.equal((await fetch(`${panel.url}/log?runId=run-nope`)).status, 404);
  } finally {
    await panel.close();
  }
});

test("GET /log：日志再长也只回末 200 行（面板不是下载器）", async () => {
  const panel = await open(runWithLog(250));
  try {
    const text = await (await fetch(`${panel.url}/log?runId=run-log`)).text();
    const lines = text.trimEnd().split("\n");
    assert.equal(lines.length, 201, "首行来源 + 200 行日志");
    assert.match(lines[0]!, /末 200 行/);
    assert.equal(lines[1], "第 51 行", "前 50 行被截掉");
    assert.equal(lines.at(-1), "第 250 行");
  } finally {
    await panel.close();
  }
});
