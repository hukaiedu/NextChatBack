import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { SseTestClient, createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { SseEvent, TestContext } from "../helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  description: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timeout: ${description}`);
    }
    await sleep(5);
  }
}

/** 流式剧本 + 逐帧放行:每推完一段文本就挂起,等测试确认 SSE 已收到 */
function scripted(texts: string[]): {
  behavior: FakeAdapterBehavior;
  release: Array<() => void>;
} {
  const release: Array<() => void> = [];
  return {
    release,
    behavior: {
      streamTexts: texts,
      onStreamText: async () => {
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
      },
    },
  };
}

const isDelta = (e: SseEvent) => e.event === "delta";
const isSnapshot = (e: SseEvent) => e.event === "snapshot";

describe("SSE 集成:GET /api/requests/:id/events(真 SQLite + Fake Adapter 流式剧本)", () => {
  let ctx: TestContext;
  let manager: BrowserManager;
  let adapter: FakeGeminiAdapter;

  async function mount(behavior: FakeAdapterBehavior, updateIntervalMs = 0): Promise<void> {
    manager = createFakeManager(new FakeDriver());
    adapter = new FakeGeminiAdapter(behavior);
    ctx = await setupTestContext({
      browserManager: manager,
      geminiAdapter: adapter,
      // autoStart:false:执行由测试用 runOnce 手动发起,连接一定建立在第一帧之前
      scheduler: { autoStart: false, scanIntervalMs: 25 },
      streaming: { updateIntervalMs },
    });
    await ctx.reset();
  }

  afterEach(async () => {
    await ctx.close();
  });

  async function createPendingRequest(key: string): Promise<string> {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", key);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { request: { id: string } } };
    return body.data.request.id;
  }

  async function assistant() {
    return ctx.prisma.message.findFirst({ where: { role: "ASSISTANT" } });
  }

  async function requestStatus(id: string): Promise<string | null> {
    const row = await ctx.prisma.modelRequest.findUnique({ where: { id } });
    return row?.status ?? null;
  }

  /** 连上 SSE,等到首帧同步(connected + status)结束:此后到达的内容帧必为纯增量 */
  async function subscribe(requestId: string, expectStatus = "PENDING"): Promise<SseTestClient> {
    const client = await SseTestClient.connect(ctx.baseUrl, requestId);
    expect(client.contentType).toContain("text/event-stream");
    expect(await client.next()).toMatchObject({ event: "connected", data: { requestId } });
    const status = await client.waitFor(
      (e) => e.event === "status",
      "initial status",
      3000,
      isDelta,
    );
    expect(status.data).toMatchObject({ requestStatus: expectStatus });
    return client;
  }

  /** 发起执行但不 await:节奏由 scripted 的 gate 逐帧放行 */
  function execute(): void {
    void ctx.scheduler!.runOnce();
  }

  async function releaseGate(release: Array<() => void>, index: number): Promise<void> {
    await waitFor(async () => (release[index] ? true : null), `gate ${index} registered`);
    release[index]!();
  }

  it(
    "流式成功:delta 逐帧推送 + Assistant 内容随流更新 + SUCCESS/COMPLETED 收尾(§14/§15)",
    { timeout: 20000 },
    async () => {
      const script = scripted(["你好", "你好世界"]);
      await mount(script.behavior);
      const requestId = await createPendingRequest("sse-ok-1");
      const client = await subscribe(requestId);
      execute();

      const first = await client.waitFor(isDelta, "delta 1");
      expect(first.data).toEqual({ type: "delta", content: "你好" });
      expect(await assistant()).toMatchObject({ status: "STREAMING", content: "你好" });
      expect(await requestStatus(requestId)).toBe("PROCESSING");

      await releaseGate(script.release, 0);
      const second = await client.waitFor(isDelta, "delta 2");
      expect(second.data).toEqual({ type: "delta", content: "世界" });
      expect(await assistant()).toMatchObject({ status: "STREAMING", content: "你好世界" });

      await releaseGate(script.release, 1);
      const done = await client.waitFor(
        (e) => e.event === "status" && e.data.requestStatus === "SUCCESS",
        "SUCCESS status",
      );
      expect(done.data).toMatchObject({ status: "COMPLETED", requestStatus: "SUCCESS", errorCode: null });

      // 状态同步:PENDING → PROCESSING → SUCCESS 每一跳都推给了前端
      expect(
        client.seen.filter((e) => e.event === "status").map((e) => e.data.requestStatus),
      ).toEqual(["PENDING", "PROCESSING", "SUCCESS"]);
      // 数据库是最终状态来源
      expect(await assistant()).toMatchObject({ status: "COMPLETED", content: "你好世界" });
      expect(await requestStatus(requestId)).toBe("SUCCESS");

      // 终态后服务端收尾响应:客户端读到流末尾,登记表已空
      expect(await client.next()).toBeNull();
      expect(ctx.sseConnections()).toBe(0);
    },
  );

  it(
    "FAILED:收到 error 帧 + status FAILED 后关闭",
    { timeout: 20000 },
    async () => {
      await mount({
        runError: new AppError(
          ErrorCodes.PROVIDER_DOM_CHANGED,
          "Gemini page does not match expected structure",
          500,
        ),
      });
      const requestId = await createPendingRequest("sse-fail-1");
      const client = await subscribe(requestId);
      execute();

      const error = await client.waitFor((e) => e.event === "error", "error frame");
      expect(error.data).toMatchObject({ code: ErrorCodes.PROVIDER_DOM_CHANGED });
      const status = await client.waitFor(
        (e) => e.event === "status" && e.data.requestStatus === "FAILED",
        "FAILED status",
      );
      expect(status.data).toMatchObject({ status: "FAILED" });
      expect(
        client.seen.filter((e) => e.event === "status").map((e) => e.data.requestStatus),
      ).toEqual(["PENDING", "PROCESSING", "FAILED"]);
      expect(await assistant()).toMatchObject({ status: "FAILED", content: "" });
      expect(await client.next()).toBeNull();
      expect(ctx.sseConnections()).toBe(0);
    },
  );

  it("已经完成的 Request:连接后立即给出最终状态并收尾响应", async () => {
    await mount({ answer: "假回答" });
    const requestId = await createPendingRequest("sse-done-1");
    await ctx.scheduler!.runOnce();
    expect(await requestStatus(requestId)).toBe("SUCCESS");

    const client = await SseTestClient.connect(ctx.baseUrl, requestId);
    expect(await client.next()).toMatchObject({ event: "connected" });
    // 不重放历史 delta:库里已有的内容一次 snapshot 给出
    expect(await client.waitFor(isSnapshot, "snapshot")).toMatchObject({
      data: { type: "snapshot", content: "假回答" },
    });
    expect(
      await client.waitFor((e) => e.event === "status", "status"),
    ).toMatchObject({ data: { requestStatus: "SUCCESS", status: "COMPLETED" } });
    expect(await client.next()).toBeNull();
    expect(ctx.sseConnections()).toBe(0);
  });

  it(
    "多个 SSE 客户端同时订阅:各自收到同一份事件流,断开其一不影响另一个(§12/§13)",
    { timeout: 20000 },
    async () => {
      const script = scripted(["第一句", "第一句第二句"]);
      await mount(script.behavior);
      const requestId = await createPendingRequest("sse-multi-1");
      const a = await subscribe(requestId);
      const b = await subscribe(requestId);
      expect(ctx.sseConnections()).toBe(2);
      execute();

      expect(await a.waitFor(isDelta, "A delta 1")).toMatchObject({
        data: { type: "delta", content: "第一句" },
      });
      expect(await b.waitFor(isDelta, "B delta 1")).toMatchObject({
        data: { type: "delta", content: "第一句" },
      });

      a.close();
      await waitFor(async () => (ctx.sseConnections() === 1 ? 1 : null), "A connection released");
      await releaseGate(script.release, 0);

      expect(await b.waitFor(isDelta, "B delta 2")).toMatchObject({
        data: { type: "delta", content: "第二句" },
      });
      await releaseGate(script.release, 1);
      expect(
        await b.waitFor((e) => e.event === "status" && e.data.requestStatus === "SUCCESS", "B SUCCESS"),
      ).toMatchObject({ data: { status: "COMPLETED" } });
      // A 已断开:它的流里根本没有第二句之后的帧
      expect(a.seen.some((e) => e.event === "status" && e.data.requestStatus === "SUCCESS")).toBe(false);
      expect(await assistant()).toMatchObject({ status: "COMPLETED", content: "第一句第二句" });
    },
  );

  it(
    "断线重连(页面刷新):新连接先拿 snapshot,再继续收增量(§10)",
    { timeout: 20000 },
    async () => {
      const script = scripted(["你好", "你好世界"]);
      await mount(script.behavior);
      const requestId = await createPendingRequest("sse-reconnect-1");
      const old = await subscribe(requestId);
      execute();
      expect(await old.waitFor(isDelta, "old delta")).toMatchObject({
        data: { content: "你好" },
      });

      old.close();
      const fresh = await subscribe(requestId, "PROCESSING");
      // 重连的第一份内容是 snapshot(库里已落下的进度),不是历史 delta 重放
      expect(fresh.seen.filter(isSnapshot)).toEqual([
        { event: "snapshot", data: { type: "snapshot", content: "你好" } },
      ]);

      await releaseGate(script.release, 0);
      expect(await fresh.waitFor(isDelta, "delta after reconnect")).toMatchObject({
        data: { type: "delta", content: "世界" },
      });
      await releaseGate(script.release, 1);
      await fresh.waitFor((e) => e.event === "status" && e.data.requestStatus === "SUCCESS", "SUCCESS");
      expect(await assistant()).toMatchObject({ status: "COMPLETED", content: "你好世界" });
    },
  );

  it(
    "SSE 客户端断开不影响 Gemini 执行(§13/§17)",
    { timeout: 20000 },
    async () => {
      const script = scripted(["你好", "你好世界"]);
      await mount(script.behavior);
      const requestId = await createPendingRequest("sse-disconnect-1");
      const client = await subscribe(requestId);
      execute();
      await client.waitFor(isDelta, "delta before close");
      client.close();

      await releaseGate(script.release, 0);
      await releaseGate(script.release, 1);
      await waitFor(async () => ((await requestStatus(requestId)) === "SUCCESS" ? "SUCCESS" : null), "SUCCESS");

      expect(await assistant()).toMatchObject({ status: "COMPLETED", content: "你好世界" });
      expect(manager.getStatus()).toBe("READY");
      await waitFor(async () => (ctx.sseConnections() === 0 ? 0 : null), "connection released");
    },
  );

  it(
    "前文被改写:SSE 用 snapshot 覆盖,数据库与前端一致(§5)",
    { timeout: 20000 },
    async () => {
      const script = scripted(["abc", "axbc"]);
      await mount(script.behavior);
      const requestId = await createPendingRequest("sse-snapshot-1");
      const client = await subscribe(requestId);
      execute();

      expect(await client.waitFor(isDelta, "delta abc")).toMatchObject({
        data: { type: "delta", content: "abc" },
      });
      await releaseGate(script.release, 0);
      expect(await client.waitFor((e) => e.event === "snapshot", "snapshot axbc")).toMatchObject({
        data: { type: "snapshot", content: "axbc" },
      });
      await releaseGate(script.release, 1);
      await client.waitFor((e) => e.event === "status" && e.data.requestStatus === "SUCCESS", "SUCCESS");
      expect(await assistant()).toMatchObject({ status: "COMPLETED", content: "axbc" });
    },
  );

  it(
    "落库节流:SSE 收到全部增量,数据库只按间隔写入(§7)",
    { timeout: 20000 },
    async () => {
      const observed: Array<string | null> = [];
      await mount(
        {
          streamTexts: ["1", "12", "123", "1234", "12345", "123456"],
          beforeAnswer: async () => {
            observed.push((await assistant())?.content ?? null);
          },
        },
        300,
      );
      const requestId = await createPendingRequest("sse-throttle-1");
      const client = await subscribe(requestId);
      await ctx.scheduler!.runOnce();
      // 等终态帧到达:它是本轮流式事件的最后一帧,此前写入的帧都已按序送达
      await client.waitFor((e) => e.event === "status" && e.data.requestStatus === "SUCCESS", "SUCCESS");

      // 6 次文本变化全部立即推给前端,增量拼起来就是完整回答
      const contents = client.seen.filter(isDelta).map((e) => e.data.content);
      expect(contents.join("")).toBe("123456");
      // 节流窗口内只落了第一笔:其余进度留在内存,收尾时补写
      expect(observed).toEqual(["1"]);
      expect(await assistant()).toMatchObject({ status: "COMPLETED", content: "123456" });
    },
  );

  it("应用停机:仍有活动 SSE 连接时也放得开(§11)", async () => {
    await mount({ answer: "不会被执行" });
    const requestId = await createPendingRequest("sse-shutdown-1");
    const client = await subscribe(requestId);
    expect(ctx.sseConnections()).toBe(1);

    const startedAt = Date.now();
    await ctx.close();
    // 长连接没被主动结束的话,这里会一直等下去(兜底靠强制退出)
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(ctx.sseConnections()).toBe(0);
    // 服务端已结束响应:客户端读到流末尾
    expect(await client.next()).toBeNull();
  });

  it("未知 Request:写 SSE 头之前就回 404,响应不是事件流", async () => {
    await mount({});
    const res = await fetch(`${ctx.baseUrl}/api/requests/does-not-exist/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.REQUEST_NOT_FOUND,
    );
    expect(ctx.sseConnections()).toBe(0);
  });
});
