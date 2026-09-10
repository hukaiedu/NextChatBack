import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { createLogger } from "../../src/common/logger/logger.js";
import { ConversationRepository } from "../../src/modules/conversation/conversation.repository.js";
import { MessageRepository } from "../../src/modules/message/message.repository.js";
import { MessageService } from "../../src/modules/message/message.service.js";
import { AttachmentStore } from "../../src/modules/request/request.attachment-store.js";
import { RequestRepository } from "../../src/modules/request/request.repository.js";
import { attachment, decodedBytes, expectAttachmentInvariant } from "../attachment-fixtures.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

/**
 * V1.2 I1.1:数据库唯一约束竞态兜底(FINDING-02 的正题)。
 *
 * P2002 一律由 **真 Prisma + 真 SQLite + 真 migration + 真唯一约束** 产生。
 * 测试注入只负责制造「事务外预检查到了对方提交之前的旧快照」这一件事 ——
 * 也就是这条兜底分支唯一会真实发生的条件。§9:不为此污染生产 AppHandle,
 * 所以这里自己持有 Repository 实例并直接构造 MessageService。
 *
 * 三条实测前提(不是推断):
 * - driver adapter 的 P2002 只报列名,永不报索引名;
 * - 同会话同 Key 且赢家仍活动时 SQLite 先报活动索引 ⇒ 要隔离出 idempotencyKey 冲突,赢家必须先离开活动态;
 * - Message 的复合唯一报 ["conversationId","position"],必须与 ModelRequest 的单列区分开(见 RACE-PREC-01)。
 */

const ACTIVE = ["PENDING", "PROCESSING", "CANCELLING"] as const;

let ctx: TestContext;
let prisma: TestContext["prisma"];
let requestRepo: RequestRepository;
let messageRepo: MessageRepository;
let store: AttachmentStore;
let service: MessageService;

beforeEach(async () => {
  ctx = await setupTestContext();
  await ctx.reset();
  prisma = ctx.prisma;
  requestRepo = new RequestRepository();
  messageRepo = new MessageRepository();
  store = new AttachmentStore({
    prisma: ctx.prisma,
    requestRepo,
    logger: createLogger("silent"),
    // 用例里手动驱动断言,不需要后台定时器插手
    sweepIntervalMs: 3_600_000,
  });
  service = new MessageService(prisma, messageRepo, new ConversationRepository(), requestRepo, store);
});

afterEach(async () => {
  store.dispose();
  await ctx.close();
});

async function newConversation(title: string): Promise<string> {
  return (await prisma.conversation.create({ data: { title } })).id;
}

async function activeCount(conversationId: string): Promise<number> {
  return prisma.modelRequest.count({ where: { conversationId, status: { in: [...ACTIVE] } } });
}

/** 让赢家离开活动态(等价于「首个请求已跑完,客户端拿同 Key 重试」) */
async function finishRequest(requestId: string): Promise<void> {
  const request = await prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
  await prisma.message.update({
    where: { id: request.assistantMessageId },
    data: { status: "COMPLETED", content: "done" },
  });
  await prisma.modelRequest.update({ where: { id: requestId }, data: { status: "SUCCESS" } });
}

/** 只在测试持有的 Repository 实例上制造陈旧预检,跑完立刻还原 */
async function withStalePrechecks<T>(
  leaks: { idempotencyKey?: boolean; active?: boolean; position?: boolean },
  run: () => Promise<T>,
): Promise<T> {
  const originalFind = requestRepo.findByIdempotencyKey.bind(requestRepo);
  const originalActive = requestRepo.hasActive.bind(requestRepo);
  const originalMax = messageRepo.findMaxPosition.bind(messageRepo);
  try {
    if (leaks.idempotencyKey) {
      // 一次性:输家只有在「事务前的幂等预检」上读到旧快照;撞约束之后兜底要重查赢家,
      // 那次必须读真值 —— 否则被测分支永远查不到既有 Request,测试就只是在测自己的覆写。
      let stale = true;
      requestRepo.findByIdempotencyKey = async (db, key) => {
        if (!stale) {
          return originalFind(db, key);
        }
        stale = false;
        return null;
      };
    }
    if (leaks.active) {
      requestRepo.hasActive = async () => false;
    }
    if (leaks.position) {
      // 读到对方插入之前的 max ⇒ 两条消息落在同一个 position 上
      messageRepo.findMaxPosition = async (db, conversationId) => {
        const max = await originalMax(db, conversationId);
        return max === null ? max : max - 1;
      };
    }
    return await run();
  } finally {
    requestRepo.findByIdempotencyKey = originalFind;
    requestRepo.hasActive = originalActive;
    messageRepo.findMaxPosition = originalMax;
  }
}

/** 期望业务错误:拿到 AppError 就返回,拿到别的(含成功)一律判失败 */
async function expectAppError(race: Promise<unknown>): Promise<AppError> {
  const result = await race.then(() => "resolved").catch((err: unknown) => err);
  expect(result, "竞态输家必须落到预期业务错误,而不是裸数据库异常或成功").toBeInstanceOf(AppError);
  return result as AppError;
}

describe("唯一约束竞态兜底(§六/§十二):P2002 全部由真实约束产生", () => {
  it("RACE-IDEM-01 同会话同 Key + 同图片:输家撞 idempotencyKey → 重查 → deduplicated", async () => {
    const conversationId = await newConversation("race-idem-01");
    const img = attachment("image/png", 4096);
    const winner = await service.sendMessage(conversationId, "同一句话", "k-01", undefined, [img]);
    expect(store.stats().slotCount).toBe(1);
    await finishRequest(winner.request.id);

    const loser = await withStalePrechecks({ idempotencyKey: true }, () =>
      service.sendMessage(conversationId, "同一句话", "k-01", undefined, [img]),
    );

    expect(loser.deduplicated).toBe(true);
    expect(loser.request.id).toBe(winner.request.id);
    expect(await prisma.modelRequest.count({ where: { idempotencyKey: "k-01" } })).toBe(1);
    // 输家不得留下任何痕迹:消息、slot、字节都只有赢家那一份
    expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
    expect(store.stats().slots).toEqual([
      { requestId: winner.request.id, state: "READY", byteSize: decodedBytes([img]) },
    ]);
    expect(store.stats().liveBytes).toBe(decodedBytes([img]));
    expectAttachmentInvariant(store);
  });

  it("RACE-IDEM-01B 同 Key 但赢家仍活动:活动索引优先命中,得 409 而非 dedup(实测判据)", async () => {
    const conversationId = await newConversation("race-idem-01b");
    const winner = await service.sendMessage(conversationId, "同一句话", "k-01b");

    const err = await expectAppError(
      withStalePrechecks({ idempotencyKey: true, active: true }, () =>
        service.sendMessage(conversationId, "同一句话", "k-01b"),
      ),
    );
    expect(err.code).toBe("CONVERSATION_REQUEST_IN_PROGRESS");
    expect(err.statusCode).toBe(409);
    expect(await activeCount(conversationId)).toBe(1);
    expect(await prisma.modelRequest.count({ where: { id: winner.request.id } })).toBe(1);
    expectAttachmentInvariant(store);
  });

  it("RACE-IDEM-02 同 Key 换图片:409 IDEMPOTENCY_KEY_REUSED;跨会话同 Key 同图也 409", async () => {
    const conversationId = await newConversation("race-idem-02");
    const first = attachment("image/png", 4096);
    const second = attachment("image/jpeg", 2048);
    const winner = await service.sendMessage(conversationId, "同一句话", "k-02", undefined, [first]);
    await finishRequest(winner.request.id);
    const winnerSlot = store.stats().slots[0]!;

    const err = await expectAppError(
      withStalePrechecks({ idempotencyKey: true }, () =>
        service.sendMessage(conversationId, "同一句话", "k-02", undefined, [second]),
      ),
    );
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(err.statusCode).toBe(409);
    // 输家的占位收回,赢家的 slot 分毫未动
    expect(store.stats().slots).toEqual([winnerSlot]);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
    expectAttachmentInvariant(store);

    // §六 A 第三行:不同 conversation 复用同 Key 同样判 409
    const otherConversation = await newConversation("race-idem-02-other");
    const crossErr = await expectAppError(
      withStalePrechecks({ idempotencyKey: true }, () =>
        service.sendMessage(otherConversation, "同一句话", "k-02", undefined, [first]),
      ),
    );
    expect(crossErr.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(store.stats().slots).toEqual([winnerSlot]);
    expectAttachmentInvariant(store);
  });

  it("RACE-CONV-01 同会话不同 Key:输家撞活动唯一索引 → 409 CONVERSATION_REQUEST_IN_PROGRESS", async () => {
    const conversationId = await newConversation("race-conv-01");
    const img = attachment("image/png", 4096);
    const winner = await service.sendMessage(conversationId, "先到的", "k-conv-1", undefined, [img]);
    const winnerSlot = store.stats().slots[0]!;

    const err = await expectAppError(
      withStalePrechecks({ active: true }, () =>
        service.sendMessage(conversationId, "后到的", "k-conv-2", undefined, [
          attachment("image/jpeg", 1024),
        ]),
      ),
    );
    expect(err.code).toBe("CONVERSATION_REQUEST_IN_PROGRESS");
    expect(err.statusCode).toBe(409);
    // 数据库仍然合法:一条活动 Request、只有赢家的两条消息
    expect(await activeCount(conversationId)).toBe(1);
    expect(await prisma.modelRequest.count({ where: { conversationId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
    // 输家 reservation 完整释放,赢家 slot 未被覆盖也未被删
    expect(store.stats().slots).toEqual([winnerSlot]);
    expectAttachmentInvariant(store);
  });

  it("RACE-PREC-01 Message(conversationId,position) 复合冲突不得被洗成业务 409", async () => {
    const conversationId = await newConversation("race-prec-01");
    await service.sendMessage(conversationId, "先到的", "k-prec-1");

    const result = await withStalePrechecks({ active: true, position: true }, () =>
      service.sendMessage(conversationId, "后到的", "k-prec-2", undefined, [
        attachment("image/png", 512),
      ]),
    )
      .then(() => "resolved")
      .catch((err: unknown) => err);

    // 既不是 409 也不是 dedup:保持「未识别数据库异常」语义(该映射由 error-handling.test.ts 锁死为 500)
    expect(result).not.toBeInstanceOf(AppError);
    expect(result).not.toBe("resolved");
    expect((result as { name?: string }).name).toBe("PrismaClientKnownRequestError");
    expect((result as { code?: string }).code).toBe("P2002");
    // 输家事务整体回滚:消息与 Request 都只有赢家那一份,输家占位也收干净
    expect(await activeCount(conversationId)).toBe(1);
    expect(await prisma.modelRequest.count({ where: { conversationId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
    // 赢家是纯文本(本来不碰容器),输家占位必须收干净 ⇒ 容器回到空
    expect(store.stats().slots).toEqual([]);
    expectAttachmentInvariant(store);
  });

  it("RACE-REG-01 诚实预检下不新建 Request:同 Key 重发仍走既有幂等路径(回归护栏)", async () => {
    const conversationId = await newConversation("race-reg-01");
    const img = attachment("image/png", 4096);
    const winner = await service.sendMessage(conversationId, "同一句话", "k-reg", undefined, [img]);
    await finishRequest(winner.request.id);

    const replay = await service.sendMessage(conversationId, "同一句话", "k-reg", undefined, [img]);
    expect(replay.deduplicated).toBe(true);
    expect(replay.request.id).toBe(winner.request.id);
    expect(store.stats().slots).toHaveLength(1);
    expectAttachmentInvariant(store);
  });
});
