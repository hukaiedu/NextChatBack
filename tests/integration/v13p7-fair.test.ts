import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { Logger } from "../../src/common/logger/logger.js";
import type { AbuseProtectionConfig, SchedulerConfig } from "../../src/app.js";
import { USER_MESSAGE_STATUS } from "../../src/modules/message/message.types.js";
import { RequestRepository } from "../../src/modules/request/request.repository.js";
import type { GeminiPromptResult, GeminiPromptRunInput } from "../../src/providers/gemini/gemini.types.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { setupTestContext, type TestContext } from "../helpers.js";
import {
  authDeps,
  newUserWithConversations,
  requestIdOf,
  send,
  type TestUser,
} from "../multi-user-fixtures.js";

/**
 * V1.3 P7:公平调度矩阵。
 *
 * 两条取证通道并用,缺一不可:
 * - **真实执行序列** `adapter.attempted`(用户能感知到的公平性只看这条)
 * - **内存队列快照** `snapshotQueue()`(§94/§203:test-only 观察窗,不暴露任何 HTTP 面)
 *
 * 种子数据直接落库并显式给 createdAt,才能把 §46/§54 的到达次序钉死;
 * §91~§93 另有一组走真实 HTTP 提交的多用户端到端。
 */

const BASE_MS = Date.parse("2026-01-01T10:00:00.000Z");

/**
 * 每次执行都要一条独占的 provider 会话 URL:执行器要求这条 URL 必须落库
 * (否则按 PROVIDER_DOM_CHANGED 判失败),而该列是 @unique,复用第二条就会撞约束。
 * 会话段必须是 extractConversationId 认得的十六进制形态,否则落库前就被判
 * PROVIDER_CONVERSATION_UNAVAILABLE。64 条足够覆盖本文件最长的一次 drain(11 条)。
 */
const URLS = Array.from(
  { length: 64 },
  (_, i) => `https://gemini.google.com/app/fair${i.toString(16).padStart(12, "0")}`,
);

const contexts: TestContext[] = [];

/**
 * Fake Adapter 的剧本版:前 N 次执行抛 Provider 崩溃,且崩溃那几次报告「页面没静默」,
 * 于是 releaseSlot 真的走 Browser 重建 —— 崩溃与重建都落在同一条真实路径上。
 */
class ScriptedAdapter extends FakeGeminiAdapter {
  readonly attempted: string[] = [];
  private crashesLeft: number;
  private nonIdleLeft: number;

  constructor(
    behavior: FakeAdapterBehavior,
    script: { crashFirst?: number; nonIdleFirst?: number } = {},
  ) {
    super(behavior);
    this.crashesLeft = script.crashFirst ?? 0;
    this.nonIdleLeft = script.nonIdleFirst ?? 0;
  }

  override async runPrompt(input: GeminiPromptRunInput): Promise<GeminiPromptResult> {
    this.attempted.push(input.prompt);
    if (this.crashesLeft > 0) {
      this.crashesLeft -= 1;
      throw new AppError(ErrorCodes.PROVIDER_BROWSER_CRASHED, "browser context crashed");
    }
    return super.runPrompt(input);
  }

  override async confirmIdle(): Promise<boolean> {
    if (this.nonIdleLeft > 0) {
      this.nonIdleLeft -= 1;
      return false;
    }
    return super.confirmIdle();
  }
}

interface Harness {
  ctx: TestContext;
  adapter: ScriptedAdapter;
  driver: FakeDriver;
}

/** 起一个「Scheduler 已创建但不启动」的 app:所有推进都由 runOnce 手动触发,次序才确定 */
async function mount(
  behavior: FakeAdapterBehavior = {},
  script: { crashFirst?: number; nonIdleFirst?: number } = {},
  extra: { scheduler?: SchedulerConfig; abuse?: AbuseProtectionConfig; reset?: boolean } = {},
): Promise<Harness> {
  const adapter = new ScriptedAdapter(behavior, script);
  const driver = new FakeDriver();
  const ctx = await setupTestContext({
    browserManager: createFakeManager(driver),
    geminiAdapter: adapter,
    scheduler: { autoStart: false, ...extra.scheduler },
    abuse: extra.abuse,
    auth: authDeps(),
  });
  contexts.push(ctx);
  if (extra.reset !== false) {
    await ctx.reset();
  }
  return { ctx, adapter, driver };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ctx of contexts.splice(0)) {
    await ctx.close();
  }
});

async function seedUser(ctx: TestContext): Promise<string> {
  const user = await ctx.prisma.user.create({
    data: { type: "ANONYMOUS", status: "ACTIVE" },
    select: { id: true },
  });
  return user.id;
}

/**
 * 直接落一条 PENDING(绕开 P6 准入,精确控制到达次序)。
 * prompt 与 requestFingerprint 都取「标签+序号」,于是执行序列读回来就是 A1 → B1 → …。
 */
async function seedPending(
  ctx: TestContext,
  userId: string,
  prompt: string,
  createdAtMs: number,
): Promise<string> {
  const conversation = await ctx.prisma.conversation.create({
    // 每条 PENDING 独占一个会话:同一会话的活动态由部分唯一索引兜底
    data: { title: prompt, status: "ACTIVE", provider: "GEMINI_WEB", userId },
  });
  const userMessage = await ctx.prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: prompt,
      status: USER_MESSAGE_STATUS,
      position: 1,
    },
  });
  const assistantMessage = await ctx.prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: "",
      status: "PENDING",
      position: 2,
    },
  });
  const request = await ctx.prisma.modelRequest.create({
    data: {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      idempotencyKey: randomUUID(),
      requestFingerprint: prompt,
      status: "PENDING",
      provider: "GEMINI_WEB",
      createdAt: new Date(createdAtMs),
    },
  });
  return request.id;
}

/**
 * 队列里还挂着哪些 PENDING(按数据库的到达次序)。
 * 标签一律取 USER 消息正文:种子行与 HTTP 行同源,requestFingerprint 在真实链路上是指纹哈希,不能当标签。
 */
async function pendingPrompts(ctx: TestContext): Promise<string[]> {
  const rows = await ctx.prisma.modelRequest.findMany({
    where: { status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { userMessage: { select: { content: true } } },
  });
  return rows.map((row) => row.userMessage.content);
}

/** 全量结果按到达次序读回 [prompt, status, attemptCount] */
async function outcomeByPrompt(ctx: TestContext): Promise<Array<[string, string, number]>> {
  const rows = await ctx.prisma.modelRequest.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      status: true,
      attemptCount: true,
      userMessage: { select: { content: true } },
    },
  });
  return rows.map((row) => [row.userMessage.content, row.status, row.attemptCount]);
}

/** 队列收尾判据(§199/§200):跑空后内存里不留用户键、轮转项或去重标记 */
function expectQueueEmpty(ctx: TestContext): void {
  expect(ctx.scheduler!.snapshotQueue()).toEqual({
    readyUsers: [],
    perUser: {},
    queuedRequestIds: [],
    current: null,
    activeByUser: {},
  });
}

/**
 * §71 starvation 指标:测试层定义,不进生产、不引入 Metrics 系统。
 *
 * 执行序列的标签形如 `A1`/`B2`,首字符即归属用户。逐条回放并统计同一用户的连跑长度;
 * 任何「紧跟同用户上一次 claim」的那一条,判据是**此刻其它用户的剩余 pending 必须已为 0**
 * —— 也就是「同一 User 连续 claim 次数 <=1,除非其它 User 队列已空」。
 *
 * §71 的第三个例外分支「其它 User 不可 dispatch」由 FIX-01A 之后才可覆盖:在飞上限是 per-user
 * 且以数据库为准,于是能让 B/C 各自被自己的在飞行挡住、只留 A 可派发(见 ACTIVE-09)。
 */
function assertNoStarvation(
  sequence: string[],
  totals: Record<string, number>,
): { longestRun: number } {
  const consumed: Record<string, number> = {};
  let previous: string | null = null;
  let run = 0;
  let longestRun = 0;
  for (const label of sequence) {
    const user = label[0]!;
    run = user === previous ? run + 1 : 1;
    previous = user;
    consumed[user] = (consumed[user] ?? 0) + 1;
    if (run > 1) {
      expect(
        Object.keys(totals).filter(
          (other) => other !== user && (consumed[other] ?? 0) < totals[other]!,
        ),
      ).toEqual([]);
    }
    longestRun = Math.max(longestRun, run);
  }
  expect(consumed).toEqual(totals);
  return { longestRun };
}

describe("P7 公平队列(内存队列 + 真 SQLite + 剧本 Adapter)", () => {
  it("P7-FAIR-01 用户之间 round-robin、用户内 FIFO(§46/§45)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const c = await seedUser(ctx);

    // 到达次序刻意让 A 连发三条:全局 FIFO 会先跑光 A
    await seedPending(ctx, a, "A1", BASE_MS);
    await seedPending(ctx, a, "A2", BASE_MS + 1_000);
    await seedPending(ctx, a, "A3", BASE_MS + 2_000);
    await seedPending(ctx, b, "B1", BASE_MS + 3_000);
    await seedPending(ctx, b, "B2", BASE_MS + 4_000);
    await seedPending(ctx, c, "C1", BASE_MS + 5_000);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1", "B1", "C1", "A2", "B2", "A3"]);
    expect(await outcomeByPrompt(ctx)).toEqual([
      ["A1", "SUCCESS", 1],
      ["A2", "SUCCESS", 1],
      ["A3", "SUCCESS", 1],
      ["B1", "SUCCESS", 1],
      ["B2", "SUCCESS", 1],
      ["C1", "SUCCESS", 1],
    ]);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-02 执行期间晚到的用户排在该用户剩余请求之前(§47)", async () => {
    const behavior: FakeAdapterBehavior = { conversationUrls: URLS };
    const { ctx, adapter } = await mount(behavior);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    await seedPending(ctx, a, "A1", BASE_MS);
    await seedPending(ctx, a, "A2", BASE_MS + 1_000);
    await seedPending(ctx, a, "A3", BASE_MS + 2_000);
    await seedPending(ctx, a, "A4", BASE_MS + 3_000);

    // B1 在 A1 执行**期间**才落库并 notify: reconcile 还没见过它,入队顺序完全由 §47 决定
    const rotationWhileExecuting: string[][] = [];
    behavior.beforeAnswer = async () => {
      if (adapter.attempted.length !== 1) {
        return;
      }
      const b1 = await seedPending(ctx, b, "B1", Date.now());
      ctx.scheduler!.notify(b1, b);
      rotationWhileExecuting.push(ctx.scheduler!.snapshotQueue().readyUsers);
    };

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1", "B1", "A2", "A3", "A4"]);
    // 正在执行的 A 不在轮转里,B 是当时唯一的 ready 用户;A 收尾后才被追加到 B 之后
    expect(rotationWhileExecuting).toEqual([[b]]);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-03 重度用户饿不死轻量用户:A=10 / B=1(§43)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    for (let i = 1; i <= 10; i += 1) {
      await seedPending(ctx, a, `A${i}`, BASE_MS + i * 1_000);
    }
    await seedPending(ctx, b, "B1", BASE_MS + 11_000);

    await ctx.scheduler!.runOnce();

    // B 最后到达,却第 2 个执行 —— 而不是等 A 的 10 条跑完
    expect(adapter.attempted.slice(0, 2)).toEqual(["A1", "B1"]);
    expect(adapter.attempted.filter((p) => p.startsWith("A"))).toHaveLength(10);
    expect(adapter.attempted).toHaveLength(11);
    expect(await pendingPrompts(ctx)).toEqual([]);
  });

  it("P7-FAIR-04 交错到达时单用户内仍严格 FIFO(§45)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    await seedPending(ctx, a, "A1", BASE_MS);
    await seedPending(ctx, b, "B1", BASE_MS + 500);
    await seedPending(ctx, a, "A2", BASE_MS + 1_000);
    await seedPending(ctx, b, "B2", BASE_MS + 1_500);
    await seedPending(ctx, a, "A3", BASE_MS + 2_000);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1", "B1", "A2", "B2", "A3"]);
  });

  it("P7-FAIR-05 同一 requestId 重复 notify 只执行一次(§49)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const one = await seedPending(ctx, a, "A1", BASE_MS);

    ctx.scheduler!.notify(one, a);
    ctx.scheduler!.notify(one, a);
    expect(ctx.scheduler!.snapshotQueue().queuedRequestIds).toEqual([one]);

    await ctx.scheduler!.runOnce();
    // 收尾之后再重复 notify:也不能把它重新塞回队列
    ctx.scheduler!.notify(one, a);
    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1"]);
    expect(await outcomeByPrompt(ctx)).toEqual([["A1", "SUCCESS", 1]]);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-06 排队期间被取消的 PENDING 跳过且不留残项(§63/§198)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    await seedPending(ctx, a, "A1", BASE_MS);
    const a2 = await seedPending(ctx, a, "A2", BASE_MS + 1_000);
    await seedPending(ctx, b, "B1", BASE_MS + 2_000);

    ctx.scheduler!.notify(a2, a);
    // 排队中被取消:数据库说它已不是 PENDING(§52 候选只是「该去看哪一行」的提示)
    await ctx.prisma.modelRequest.update({ where: { id: a2 }, data: { status: "CANCELLED" } });

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1", "B1"]);
    const cancelled = await ctx.prisma.modelRequest.findUnique({ where: { id: a2 } });
    expect(cancelled?.startedAt).toBeNull();
    expect(cancelled?.attemptCount).toBe(0);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-07 超时后继续下一个用户,不自动重试(§64/原则 30)", async () => {
    // 第一条挂死;watchdog abort 落地后撤掉 hang,后续恢复正常
    const behavior: FakeAdapterBehavior = { conversationUrls: URLS, hang: true };
    behavior.abortObserver = () => {
      behavior.hang = false;
    };
    const { ctx, adapter } = await mount(behavior, {}, { scheduler: { executionTimeoutMs: 50 } });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    await seedPending(ctx, a, "A1", BASE_MS);
    await seedPending(ctx, b, "B1", BASE_MS + 1_000);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1", "B1"]);
    expect(await outcomeByPrompt(ctx)).toEqual([
      ["A1", "TIMEOUT", 1],
      ["B1", "SUCCESS", 1],
    ]);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-08 Provider 崩溃并重建 Browser 后,其余用户照常执行(§59/§65)", async () => {
    const { ctx, adapter, driver } = await mount(
      { conversationUrls: URLS },
      // 第一条崩,且崩完「页面没静默」→ releaseSlot 走 restart
      { crashFirst: 1, nonIdleFirst: 1 },
    );
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const c = await seedUser(ctx);
    await seedPending(ctx, a, "A1", BASE_MS);
    await seedPending(ctx, b, "B1", BASE_MS + 1_000);
    await seedPending(ctx, c, "C1", BASE_MS + 2_000);

    const launchedBefore = driver.launchCount;
    await ctx.scheduler!.runOnce();

    // 一条崩溃没带走别人的排队:B/C 仍按轮转拿到 worker
    expect(adapter.attempted).toEqual(["A1", "B1", "C1"]);
    expect(await outcomeByPrompt(ctx)).toEqual([
      ["A1", "FAILED", 1],
      ["B1", "SUCCESS", 1],
      ["C1", "SUCCESS", 1],
    ]);
    expect(driver.launchCount).toBeGreaterThan(launchedBefore);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-09 新进程从数据库公平重建队列(§53/§54/§55/§93)", async () => {
    // 进程 1:只落库,内存队列始终为空 —— 就是要证明「公平性不依赖上一进程的内存」
    const first = await mount({ conversationUrls: URLS });
    const a = await seedUser(first.ctx);
    const b = await seedUser(first.ctx);
    const c = await seedUser(first.ctx);
    await seedPending(first.ctx, a, "A1", Date.parse("2026-01-01T10:00:00.000Z"));
    await seedPending(first.ctx, a, "A2", Date.parse("2026-01-01T10:01:00.000Z"));
    await seedPending(first.ctx, a, "A3", Date.parse("2026-01-01T10:02:00.000Z"));
    await seedPending(first.ctx, b, "B1", Date.parse("2026-01-01T10:00:30.000Z"));
    await seedPending(first.ctx, c, "C1", Date.parse("2026-01-01T10:01:30.000Z"));
    await seedPending(first.ctx, c, "C2", Date.parse("2026-01-01T10:03:00.000Z"));
    expectQueueEmpty(first.ctx);
    await first.ctx.close();
    contexts.splice(contexts.indexOf(first.ctx), 1);

    // 进程 2:全新 Scheduler 实例,按生产顺序 recovery.run() → 扫描
    const second = await mount({ conversationUrls: URLS }, {}, { reset: false });
    const report = await second.ctx.recovery.run();
    expect(report.processingFailed).toBe(0);
    expect(report.pendingAttachmentFailed).toBe(0);
    expect(await pendingPrompts(second.ctx)).toEqual(["A1", "B1", "A2", "C1", "A3", "C2"]);

    await second.ctx.scheduler!.runOnce();

    // §55 的期望序列 —— 既不是全局 FIFO,也不是按用户成块
    expect(second.adapter.attempted).toEqual(["A1", "B1", "C1", "A2", "C2", "A3"]);
    expect(await pendingPrompts(second.ctx)).toEqual([]);
    expectQueueEmpty(second.ctx);
  });

  it("P7-FAIR-11 owner 解析不到的 PENDING 按内部一致性错误跳过,不进共享桶(§56)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const orphan = await seedPending(ctx, a, "ORPHAN", BASE_MS);
    const kept = await seedPending(ctx, a, "A1", BASE_MS + 1_000);

    // B4 后 Conversation.userId NOT NULL,正常写入造不出无主行:直接模拟异常查询结果。
    // 只模拟第一轮:之后如实报「没有 PENDING」—— 真库不会把已终态的行继续报成 PENDING。
    let firstScan = true;
    vi.spyOn(RequestRepository.prototype, "findPendingWithOwner").mockImplementation(async () => {
      if (!firstScan) {
        return [];
      }
      firstScan = false;
      return [
        { id: orphan, userId: null, createdAt: new Date(BASE_MS) },
        { id: kept, userId: a, createdAt: new Date(BASE_MS + 1_000) },
      ];
    });

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1"]);
    // 未知归属那条既不执行也不收尾:交给人工/恢复路径,绝不猜一个桶放进去
    expect(await ctx.prisma.modelRequest.findUnique({ where: { id: orphan } })).toMatchObject({
      status: "PENDING",
      startedAt: null,
    });
    const snapshot = ctx.scheduler!.snapshotQueue();
    expect(snapshot.queuedRequestIds).toEqual([]);
    expect(Object.keys(snapshot.perUser)).toEqual([]);
  });

  it("P7-FAIR-12 一个用户在轮转里至多出现一次(§48)", async () => {
    const behavior: FakeAdapterBehavior = { conversationUrls: URLS, answer: "ok" };
    const { ctx, adapter } = await mount(behavior);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    for (let i = 1; i <= 5; i += 1) {
      await seedPending(ctx, a, `A${i}`, BASE_MS + i * 1_000);
    }
    await seedPending(ctx, b, "B1", BASE_MS + 10_000);

    // 每次开始执行前抄一份轮转:A 连发 5 条也只能占一个轮转位
    const rotations: string[][] = [];
    behavior.beforeAnswer = async () => {
      rotations.push(ctx.scheduler!.snapshotQueue().readyUsers);
    };

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted.filter((p) => p.startsWith("A"))).toHaveLength(5);
    expect(rotations.length).toBeGreaterThan(0);
    for (const users of rotations) {
      expect(users.length).toBe(new Set(users).size);
    }
  });

  it("P7-FAIR-13 三用户各 5 条的饱和压力:每轮恰好 A B C 各一条(§70)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const c = await seedUser(ctx);

    // 到达次序刻意按用户成块(A 的 5 条全在最前):全局 FIFO 会先跑光 A,§70 禁止的正这种形态
    let arrival = 0;
    for (const [userId, key] of [
      [a, "A"],
      [b, "B"],
      [c, "C"],
    ] as const) {
      for (let i = 1; i <= 5; i += 1) {
        arrival += 1;
        await seedPending(ctx, userId, `${key}${i}`, BASE_MS + arrival * 100);
      }
    }

    await ctx.scheduler!.runOnce();

    const executionOrder: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      executionOrder.push(`A${i}`, `B${i}`, `C${i}`);
    }
    expect(adapter.attempted).toEqual(executionOrder);
    // 逐轮复核:每连续 3 条必须是 A/B/C 各一,谁也没连占两个位置
    for (let offset = 0; offset < executionOrder.length; offset += 3) {
      const round = adapter.attempted.slice(offset, offset + 3);
      expect([...new Set(round.map((label) => label[0]))]).toEqual(["A", "B", "C"]);
    }
    expect(assertNoStarvation(adapter.attempted, { A: 5, B: 5, C: 5 }).longestRun).toBe(1);
    // 读回按 (createdAt, id) = 到达次序(按用户成块),与上面的执行次序刻意不同
    const arrivalOrder = ["A", "B", "C"].flatMap((key) =>
      [1, 2, 3, 4, 5].map((i) => `${key}${i}`),
    );
    expect(await outcomeByPrompt(ctx)).toEqual(
      arrivalOrder.map((label): [string, string, number] => [label, "SUCCESS", 1]),
    );
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-14 连跑只在其它用户排空之后出现(§71)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const c = await seedUser(ctx);
    for (let i = 1; i <= 5; i += 1) {
      await seedPending(ctx, a, `A${i}`, BASE_MS + i * 1_000);
    }
    await seedPending(ctx, b, "B1", BASE_MS + 6_000);
    await seedPending(ctx, c, "C1", BASE_MS + 7_000);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1", "B1", "C1", "A2", "A3", "A4", "A5"]);
    // B/C 还在排队时 A 一次都连不起来;两者排空后 A 才拿到连跑的份
    expect(assertNoStarvation(adapter.attempted, { A: 5, B: 1, C: 1 }).longestRun).toBe(4);
    expectQueueEmpty(ctx);
  });

  it("P7-FAIR-15 notify 报的 userId 与数据库 owner 不一致时按数据库修正,不用任何一方继续(§153)", async () => {
    const behavior: FakeAdapterBehavior = { conversationUrls: URLS };
    const { ctx, adapter } = await mount(behavior);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const a1 = await seedPending(ctx, a, "A1", BASE_MS);

    const currentWhileExecuting: Array<{ requestId: string; userId: string } | null> = [];
    behavior.beforeAnswer = async () => {
      currentWhileExecuting.push(ctx.scheduler!.snapshotQueue().current);
    };

    // 故意把 A 的行报成 B 的:入队先落在 B 桶,对账必须搬回 A 桶才允许执行
    ctx.scheduler!.notify(a1, b);
    expect(ctx.scheduler!.snapshotQueue().perUser[b]).toEqual([a1]);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["A1"]);
    // current.userId 是数据库 owner,而不是 notify 带来的那个
    expect(currentWhileExecuting).toEqual([{ requestId: a1, userId: a }]);
    expect(await outcomeByPrompt(ctx)).toEqual([["A1", "SUCCESS", 1]]);
    expectQueueEmpty(ctx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §91~§93:多用户端到端(真实 HTTP 提交 + 公平执行 + 排队中取消 + 重启)
// ─────────────────────────────────────────────────────────────────────────────

describe("P7 多用户端到端模拟(HTTP)", () => {
  /** A/B/C 三个匿名用户按轮次各发 plan[label] 条,全部走真实提交链路 */
  async function submitRoundRobin(
    ctx: TestContext,
    plan: Record<"A" | "B" | "C", number>,
    keyPrefix: string,
  ): Promise<{ users: Record<string, TestUser>; ids: Map<string, string> }> {
    const users = {} as Record<string, TestUser>;
    for (const label of ["A", "B", "C"] as const) {
      users[label] = await newUserWithConversations(ctx, plan[label]);
    }
    const ids = new Map<string, string>();
    for (let round = 1; round <= 5; round += 1) {
      for (const label of ["A", "B", "C"] as const) {
        if (round > plan[label]) {
          continue;
        }
        const prompt = `${label}${round}`;
        const user = users[label]!;
        const res = await send(
          ctx,
          user.cookie,
          user.conversationIds[round - 1]!,
          `${keyPrefix}-${prompt}`,
          prompt,
        );
        expect(res.status).toBe(202);
        ids.set(prompt, requestIdOf(res.body));
        // SQLite 只存到毫秒,而同毫秒的 tie-break 是随机 uuid:让每条都有独立的到达时刻
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    return { users, ids };
  }

  it("P7-E2E-01 A5/B2/C3:准入、归属、公平顺序、全部终态(§91)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const plan = { A: 5, B: 2, C: 3 } as const;
    const { users, ids } = await submitRoundRobin(ctx, plan, "e2e-01");
    expect(ids.size).toBe(10);
    expect(ctx.scheduler!.snapshotQueue().queuedRequestIds).toHaveLength(10);

    await ctx.scheduler!.runOnce();

    // 公平次序 = 用户轮转 × 用户内 FIFO;既不是全局 FIFO,也不是按用户成块
    expect(adapter.attempted).toEqual([
      "A1", "B1", "C1", "A2", "B2", "C2", "A3", "C3", "A4", "A5",
    ]);
    expect(await ctx.prisma.modelRequest.count({ where: { status: "SUCCESS" } })).toBe(10);
    expect(await pendingPrompts(ctx)).toEqual([]);
    // 原则 30:一条都没被重试过
    expect(await ctx.prisma.modelRequest.count({ where: { attemptCount: { gt: 1 } } })).toBe(0);

    // 归属正确:每个用户只在自己的会话里留下已完成的回答
    for (const label of ["A", "B", "C"] as const) {
      const user = users[label]!;
      expect(
        await ctx.prisma.conversation.count({
          where: { id: { in: user.conversationIds }, userId: user.userId },
        }),
      ).toBe(plan[label]);
      expect(
        await ctx.prisma.message.count({
          where: {
            conversationId: { in: user.conversationIds },
            role: "ASSISTANT",
            status: "COMPLETED",
            content: "fake answer",
          },
        }),
      ).toBe(plan[label]);
      // 同用户内部提交次序保持(§45 在 HTTP 路径上同样成立)
      expect(adapter.attempted.filter((p) => p.startsWith(label))).toEqual(
        Array.from({ length: plan[label] }, (_, i) => `${label}${i + 1}`),
      );
    }
    expectQueueEmpty(ctx);
  });

  it("P7-E2E-02 排队中取消 A3 与 B2:不执行、别人不饿死、队列无残留(§92/§198)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS });
    const { users, ids } = await submitRoundRobin(ctx, { A: 3, B: 2, C: 1 }, "e2e-02");

    for (const prompt of ["A3", "B2"]) {
      const owner = prompt.startsWith("A") ? users.A!.cookie : users.B!.cookie;
      const res = await fetch(`${ctx.baseUrl}/api/requests/${ids.get(prompt)!}/cancel`, {
        method: "POST",
        headers: { Cookie: owner },
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    expect(ctx.scheduler!.snapshotQueue().queuedRequestIds).toHaveLength(6);

    await ctx.scheduler!.runOnce();

    // 已取消的两条绝不执行;其余用户与同用户后续请求照常拿到 worker
    expect(adapter.attempted).toEqual(["A1", "B1", "C1", "A2"]);
    // 到达次序就是提交次序(轮转交错),outcomeByPrompt 按 (createdAt, id) 读回
    expect(await outcomeByPrompt(ctx)).toEqual([
      ["A1", "SUCCESS", 1],
      ["B1", "SUCCESS", 1],
      ["C1", "SUCCESS", 1],
      ["A2", "SUCCESS", 1],
      ["B2", "CANCELLED", 0],
      ["A3", "CANCELLED", 0],
    ]);
    expect(await pendingPrompts(ctx)).toEqual([]);
    expectQueueEmpty(ctx);
  });

  it("P7-E2E-03 跨进程重启:新 Scheduler 从数据库公平重建未执行队列(§93)", async () => {
    // 进程 1:6 条全部提交成功,但 Scheduler 从未启动 —— 内存队列随进程一起消失
    const first = await mount({ conversationUrls: URLS });
    const { ids } = await submitRoundRobin(first.ctx, { A: 3, B: 2, C: 1 }, "e2e-03");
    expect(ids.size).toBe(6);
    expect(await pendingPrompts(first.ctx)).toEqual([
      "A1", "B1", "C1", "A2", "B2", "A3",
    ]);
    await first.ctx.close();
    contexts.splice(contexts.indexOf(first.ctx), 1);

    // 进程 2:新 app + 新 Scheduler,先恢复再扫描
    const second = await mount({ conversationUrls: URLS }, {}, { reset: false });
    await second.ctx.recovery.run();
    expectQueueEmpty(second.ctx);

    await second.ctx.scheduler!.runOnce();

    expect(second.adapter.attempted).toEqual(["A1", "B1", "C1", "A2", "B2", "A3"]);
    expect(await pendingPrompts(second.ctx)).toEqual([]);
    expectQueueEmpty(second.ctx);
  });

  it("P7-E2E-04 存量积压同时超过用户与全局上限:恢复不删数据、照旧全部 drain、期间新准入被拒(§72/§73/§74)", async () => {
    const { ctx, adapter } = await mount(
      { conversationUrls: URLS },
      {},
      { abuse: { userMaxPendingRequests: 2, globalMaxPendingRequests: 3 } },
    );
    const user = await newUserWithConversations(ctx, 1);
    // 旧版本遗留:5 条纯文本 PENDING 同时越过用户上限(2)与全局容量(3)
    for (let i = 1; i <= 5; i += 1) {
      await seedPending(ctx, user.userId, `L${i}`, BASE_MS + i * 1_000);
    }

    // 启动恢复既不掉队也不删行(§74:限额只控制新进入的工作,不是数据修复)
    const report = await ctx.recovery.run();
    expect(report).toMatchObject({
      processingFailed: 0,
      cancellingFailed: 0,
      pendingAttachmentFailed: 0,
    });
    expect(await pendingPrompts(ctx)).toEqual(["L1", "L2", "L3", "L4", "L5"]);

    // 积压仍超限 → 新提交拒绝
    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "e2e-04-blocked")).status).toBe(
      429,
    );
    expect(await ctx.prisma.modelRequest.count()).toBe(5);

    // §72「全部恢复并逐步 drain」:积压照旧被公平消化,不受超限影响
    await ctx.scheduler!.runOnce();
    expect(adapter.attempted).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    expect(await pendingPrompts(ctx)).toEqual([]);
    expectQueueEmpty(ctx);

    // pending 降回上限以下后,同一个用户重新可以提交
    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "e2e-04-after")).status).toBe(
      202,
    );
    expect(await ctx.prisma.modelRequest.count()).toBe(6);
  });

  it("LOAD-01 10 用户 × 5 请求 correctness stress:无超发、无饿死、单 worker、全部终态(§148)", async () => {
    const { ctx, adapter } = await mount(
      { conversationUrls: URLS },
      {},
      { abuse: { userMaxPendingRequests: 50, globalMaxPendingRequests: 100 } },
    );
    // 每用户 5 个会话 5 条请求:text = 标签,执行序列读回来就是 A1..J5
    for (const userChar of "ABCDEFGHIJ") {
      const user = await newUserWithConversations(ctx, 5);
      for (let i = 1; i <= 5; i += 1) {
        const label = `${userChar}${i}`;
        expect(
          (await send(ctx, user.cookie, user.conversationIds[i - 1]!, `load-${label}`, label))
            .status,
        ).toBe(202);
      }
    }

    await ctx.scheduler!.runOnce();

    // 50 条全部真实执行、全部终态;单 worker 下轮转不出现连续同用户(其它用户未排空时)
    expect(adapter.attempted).toHaveLength(50);
    const totals = Object.fromEntries("ABCDEFGHIJ".split("").map((c) => [c, 5]));
    assertNoStarvation(adapter.attempted, totals);
    expect(await pendingPrompts(ctx)).toEqual([]);
    expectQueueEmpty(ctx);
  });
});

/**
 * V1.3 P6+P7 FIX-01A:单用户「在飞」上限的真相在数据库(§2~§10)。
 *
 * 三条口径贯穿全部用例:
 * - 一律用 env 合法且等于生产默认的 **1**,不再用 cap=0 这种生产不可能出现的档位;
 * - active 状态一律**直接写库**造出来(绕开本进程的认领路径),于是内存 `activeByUser`
 *   对它一无所知 —— 「挡住这个用户的是内存计数还是数据库」在断言里可分辨;
 * - Active = `PROCESSING` + `CANCELLING`,owner 只认 `Conversation.userId`(§51)。
 */
describe("P7 FIX-01A 单用户 DB active invariant(USER_MAX_ACTIVE_REQUESTS=1)", () => {
  const CAP_ONE = { abuse: { userMaxActiveRequests: 1 } };

  /** 把一条种子请求转成在飞状态:模拟「另一个执行体(或上一进程)正占着这条」 */
  async function makeInFlight(
    ctx: TestContext,
    requestId: string,
    status: "PROCESSING" | "CANCELLING",
  ): Promise<void> {
    await ctx.prisma.modelRequest.update({
      where: { id: requestId },
      data: { status, startedAt: new Date() },
    });
  }

  async function statusOf(ctx: TestContext, requestId: string): Promise<Record<string, unknown>> {
    const row = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { status: true, attemptCount: true, startedAt: true },
    });
    return { ...row, startedAt: row.startedAt !== null };
  }

  /** §7 ACTIVE-01:A 的名额被自己那条 PROCESSING 占住 → B 先执行,A1 连认领都没有 */
  it("ACTIVE-01 该用户已有 PROCESSING → 不派发其新的 PENDING,晚到的 B 先执行(§7)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const a0 = await seedPending(ctx, a, "A0", BASE_MS);
    await makeInFlight(ctx, a0, "PROCESSING");
    const a1 = await seedPending(ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(ctx, b, "B1", BASE_MS + 2_000);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["B1"]);
    // 未认领:PENDING + attemptCount=0 + startedAt 仍为 null
    expect(await statusOf(ctx, a1)).toEqual({ status: "PENDING", attemptCount: 0, startedAt: false });
    // 挡住它的是数据库而不是内存计数器:本进程从没为 A 记过一次在飞
    expect(ctx.scheduler!.snapshotQueue().activeByUser).toEqual({});
    // 跳过 ≠ 丢弃:A1 仍在队列里等下一次机会
    expect(ctx.scheduler!.snapshotQueue().queuedRequestIds).toContain(a1);
    // 不是本进程认领的行,执行链一律不碰
    expect(await statusOf(ctx, a0)).toEqual({
      status: "PROCESSING",
      attemptCount: 0,
      startedAt: true,
    });
  });

  /** §7 ACTIVE-02:A0 进终态 → 名额释放,A1 下一轮就走,证明不会永久饿死 */
  it("ACTIVE-02 占位的 PROCESSING 进入终态后 A1 立刻获得机会:不造成永久饿死(§7)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const a0 = await seedPending(ctx, a, "A0", BASE_MS);
    await makeInFlight(ctx, a0, "PROCESSING");
    await seedPending(ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(ctx, b, "B1", BASE_MS + 2_000);

    await ctx.scheduler!.runOnce();
    expect(adapter.attempted).toEqual(["B1"]);

    await ctx.prisma.modelRequest.update({
      where: { id: a0 },
      data: { status: "SUCCESS", completedAt: new Date() },
    });
    // 无需新 notify:队列从未丢过这条,下一轮对账就能派发
    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["B1", "A1"]);
    expect(await pendingPrompts(ctx)).toEqual([]);
    expectQueueEmpty(ctx);
  });

  /** §7 ACTIVE-03 + §6:CANCELLING 同样是 Active → 也占该用户的名额 */
  it("ACTIVE-03 CANCELLING 同样占名额:A1 不被派发(§6/§7)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const a0 = await seedPending(ctx, a, "A0", BASE_MS);
    await makeInFlight(ctx, a0, "CANCELLING");
    const a1 = await seedPending(ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(ctx, b, "B1", BASE_MS + 2_000);

    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["B1"]);
    expect(await statusOf(ctx, a1)).toEqual({ status: "PENDING", attemptCount: 0, startedAt: false });
    // 取消中的那条也绝不被第二次认领
    expect(await statusOf(ctx, a0)).toMatchObject({ status: "CANCELLING", attemptCount: 0 });
  });

  /** §7 ACTIVE-04:上限是 per-user 而不是全局 —— C 的在飞既不挡 A 也不挡 B */
  it("ACTIVE-04 在飞属于第三个用户 C:既不挡 A 也不挡 B(上限非全局,§7)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const c = await seedUser(ctx);
    const c0 = await seedPending(ctx, c, "C0", BASE_MS);
    await makeInFlight(ctx, c0, "PROCESSING");
    await seedPending(ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(ctx, b, "B1", BASE_MS + 2_000);

    await ctx.scheduler!.runOnce();

    // C 的名额满了,只影响它自己;A/B 照常轮转,库里也不给 C 补第二条
    expect(adapter.attempted).toEqual(["A1", "B1"]);
    expect(await statusOf(ctx, c0)).toMatchObject({ status: "PROCESSING", attemptCount: 0 });
  });

  /** §8:轮转里只剩一个已达上限的用户 → 一次检查、一次对账就退出 drain,不自旋 */
  it("ACTIVE-05 唯一 ready 用户已满:一轮只查一次在飞计数就退出,不 busy-loop(§8)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const a0 = await seedPending(ctx, a, "A0", BASE_MS);
    await makeInFlight(ctx, a0, "PROCESSING");
    await seedPending(ctx, a, "A1", BASE_MS + 1_000);

    const activeCounts = vi.spyOn(RequestRepository.prototype, "countActiveForUser");
    const scans = vi.spyOn(RequestRepository.prototype, "findPendingWithOwner");
    // 实现若原地反复重试同一个用户,这一句永不返回 —— 用例超时就是失败证据
    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual([]);
    expect(activeCounts).toHaveBeenCalledTimes(1);
    // §60:取不到候选就退出 drain,连对账都不做第二次
    expect(scans).toHaveBeenCalledTimes(1);
    expect(await pendingPrompts(ctx)).toEqual(["A1"]);
  });

  /** §9:在飞计数查询失败 → 本轮 drain 退出并记内部错误,绝不按 0 放行,也不丢 PENDING */
  it("ACTIVE-06 在飞计数查询抛错:drain 退出记内部错误,不按 0 放行,下一轮照常(§9)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    await seedPending(ctx, a, "A1", BASE_MS);
    await seedPending(ctx, b, "B1", BASE_MS + 1_000);

    const failing = vi
      .spyOn(RequestRepository.prototype, "countActiveForUser")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    // 日志走调度器同一个 pino 实例:§9 要求「记录内部错误」而不只是静默退出
    const logger = (ctx.scheduler as unknown as { deps: { logger: Logger } }).deps.logger;
    const errors = vi.spyOn(logger, "error");

    // drainSafely 自己吞掉异常:这一句必须正常返回,否则整条调度链会被一次查询抖动打断
    await ctx.scheduler!.runOnce();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[1]).toBe("scheduler drain aborted");
    // 关键判据:「查不到」当成「没有」就会放行 A1 —— 一条都不许执行
    expect(adapter.attempted).toEqual([]);
    expect(await pendingPrompts(ctx)).toEqual(["A1", "B1"]);

    // 下一次 drain 不再抛错:两条 PENDING 一条没丢,照常按轮转跑完
    await ctx.scheduler!.runOnce();
    expect(adapter.attempted).toEqual(["A1", "B1"]);
    expectQueueEmpty(ctx);
  });

  /** §10 A 面:只跑 Scheduler(不跑恢复)时的 active invariant 边界 */
  it("ACTIVE-07 Scheduler-only 边界:遗留 PROCESSING 不被接管也不被收尾,同用户持续让位(§10 A)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const a0 = await seedPending(ctx, a, "A0", BASE_MS);
    await makeInFlight(ctx, a0, "PROCESSING");
    const a1 = await seedPending(ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(ctx, b, "B1", BASE_MS + 2_000);

    // 多轮 drain:恢复路径没跑之前,这条在飞行既不会被收养也不会被强制收尾
    await ctx.scheduler!.runOnce();
    await ctx.scheduler!.runOnce();

    expect(adapter.attempted).toEqual(["B1"]);
    expect(await statusOf(ctx, a0)).toMatchObject({ status: "PROCESSING", attemptCount: 0 });
    expect(await statusOf(ctx, a1)).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  /** §10 B 面:生产启动顺序 recovery.run() → Scheduler,恢复先把在飞收尾 */
  it("ACTIVE-08 完整启动顺序(恢复 → drain):恢复清空在飞,PENDING 全部获得机会(§10 B)", async () => {
    // 进程 1:留下「一条 PROCESSING + 一条 PENDING + 别人的 PENDING」后崩溃
    const first = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(first.ctx);
    const b = await seedUser(first.ctx);
    const a0 = await seedPending(first.ctx, a, "A0", BASE_MS);
    await makeInFlight(first.ctx, a0, "PROCESSING");
    await seedPending(first.ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(first.ctx, b, "B1", BASE_MS + 2_000);
    await first.ctx.close();
    contexts.splice(contexts.indexOf(first.ctx), 1);

    // 进程 2:按生产顺序先恢复再扫描
    const second = await mount({ conversationUrls: URLS }, {}, { ...CAP_ONE, reset: false });
    const report = await second.ctx.recovery.run();
    expect(report).toMatchObject({ processingFailed: 1, cancellingFailed: 0 });

    // 正常启动之后库里**不留** active 行 —— active invariant 因此不会挡住重启后的 PENDING
    const repo = new RequestRepository();
    expect(await repo.countActiveForUser(second.ctx.prisma, a)).toBe(0);
    expect(await repo.countActiveForUser(second.ctx.prisma, b)).toBe(0);

    await second.ctx.scheduler!.runOnce();
    expect(second.adapter.attempted).toEqual(["A1", "B1"]);
    expect(await pendingPrompts(second.ctx)).toEqual([]);
    expectQueueEmpty(second.ctx);
  });

  /** §71 第三条例外分支:别的用户各自被自己的在飞行挡住时,同一用户合法连跑 */
  it("ACTIVE-09 其它用户都不可派发时,同一用户连跑不再构成饿死(§71 第三分支)", async () => {
    const { ctx, adapter } = await mount({ conversationUrls: URLS }, {}, CAP_ONE);
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    const c = await seedUser(ctx);
    const b0 = await seedPending(ctx, b, "B0", BASE_MS);
    const c0 = await seedPending(ctx, c, "C0", BASE_MS + 500);
    await makeInFlight(ctx, b0, "PROCESSING");
    await makeInFlight(ctx, c0, "CANCELLING");
    await seedPending(ctx, a, "A1", BASE_MS + 1_000);
    await seedPending(ctx, a, "A2", BASE_MS + 2_000);
    await seedPending(ctx, b, "B1", BASE_MS + 3_000);
    await seedPending(ctx, c, "C1", BASE_MS + 4_000);

    await ctx.scheduler!.runOnce();

    // A 连跑两条不是破坏公平:B/C 的新请求是被**它们自己**的在飞行挡住的
    expect(adapter.attempted).toEqual(["A1", "A2"]);
    expect(await pendingPrompts(ctx)).toEqual(["B1", "C1"]);
  });
});
