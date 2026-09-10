import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { createLogger } from "../../src/common/logger/logger.js";
import type { AttachmentFile } from "../../src/modules/message/attachment.js";
import { AttachmentStore } from "../../src/modules/request/request.attachment-store.js";
import type { RequestRepository } from "../../src/modules/request/request.repository.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { expectAttachmentInvariant as expectInvariant } from "../attachment-fixtures.js";

/**
 * V1.2 I1 §六 / §十二 / §十四:AttachmentStore 状态机与 liveBytes 计量。
 *
 * 每个用例最后都跑一次 expectInvariant —— 「liveBytes === Σ slot.byteSize」
 * 是容器唯一的账本判据,任何方法(含抛错路径)之后都必须成立。
 * ATT-ST-07(事务回滚)与 08(PENDING 取消后真库清理)需要真数据库,放在
 * tests/integration/attachment-lifecycle.test.ts;这里用可控的活动集桩验证 sweep 的其余判据。
 */

/** 假时钟:sweep 的宽限期判据完全由它驱动,不靠 sleep */
let now = 1_700_000_000_000;
/** 桩:数据库里仍在活动态的 requestId */
let activeIds: string[] = [];
const created: AttachmentStore[] = [];

function file(size: number, name = "a.png"): AttachmentFile {
  return { name, mimeType: "image/png", buffer: Buffer.alloc(size, 0x61) };
}

function makeStore(maxBytes = 10 * 1024): AttachmentStore {
  const requestRepo = {
    async findActiveByIds(_db: PrismaClient, ids: string[]): Promise<Set<string>> {
      return new Set(ids.filter((id) => activeIds.includes(id)));
    },
  } as unknown as RequestRepository;
  const store = new AttachmentStore({
    // 桩 repo 不碰 prisma;类型层面它必须是 PrismaClient
    prisma: {} as PrismaClient,
    requestRepo,
    logger: createLogger("silent"),
    clock: { now: () => now },
    // 定时器一律不在用例期间触发:sweep 全部手动调,时序可控
    sweepIntervalMs: 3_600_000,
    maxBytes,
  });
  created.push(store);
  return store;
}

function stateOf(store: AttachmentStore, requestId: string): string | undefined {
  return store.stats().slots.find((slot) => slot.requestId === requestId)?.state;
}

function errorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (err) {
    if (err instanceof AppError) {
      return err;
    }
    throw err;
  }
  throw new Error("expected store call to throw");
}

afterEach(() => {
  for (const store of created.splice(0)) {
    store.dispose();
  }
  activeIds = [];
  now = 1_700_000_000_000;
});

describe("AttachmentStore 状态机", () => {
  it("ATT-ST-01 reserve 建 RESERVED slot 并一次性计入 liveBytes", () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000), file(500)]);
    const stats = store.stats();
    expect(stats.slotCount).toBe(1);
    expect(stats.liveBytes).toBe(1_500);
    expect(stateOf(store, "r1")).toBe("RESERVED");
    expectInvariant(store);
  });

  it("ATT-ST-02 容量不足 → 503 入口拒绝,零状态变化且绝不淘汰既有附件", () => {
    const store = makeStore(10_000);
    store.reserve("big", [file(8_000)]);
    const before = store.stats();

    const err = errorOf(() => store.reserve("small", [file(3_000)]));
    expect(err.code).toBe("ATTACHMENT_CAPACITY_EXCEEDED");
    expect(err.statusCode).toBe(503);

    const after = store.stats();
    expect(after).toEqual(before);
    expect(stateOf(store, "big")).toBe("RESERVED");
    expectInvariant(store);
  });

  it("ATT-ST-02B 恰好占满配额可以通过,再多 1 字节即被拒", () => {
    const store = makeStore(10_000);
    store.reserve("exact", [file(10_000)]);
    expect(store.stats().liveBytes).toBe(10_000);
    expect(errorOf(() => store.reserve("over", [file(1)])).code).toBe(
      "ATTACHMENT_CAPACITY_EXCEEDED",
    );
    expect(store.stats().slotCount).toBe(1);
    expectInvariant(store);
  });

  it("ATT-ST-03 同 requestId 重复 reserve → 抛错且不覆盖既有 slot", () => {
    const store = makeStore();
    const first = file(1_000, "first.png");
    store.reserve("r1", [first]);
    const err = errorOf(() => store.reserve("r1", [file(9_000, "second.png")]));
    expect(err.code).toBe("INTERNAL_ERROR");

    const stats = store.stats();
    expect(stats.slotCount).toBe(1);
    expect(stats.liveBytes).toBe(1_000);
    expect(store.take("r1")).toBeUndefined();
    store.attach("r1");
    expect(store.take("r1")).toEqual([first]);
    expectInvariant(store);
  });

  it("ATT-ST-04 attach 只做 RESERVED→READY,绝不二次计量", () => {
    const store = makeStore();
    store.reserve("r1", [file(2_048)]);
    expect(store.attach("r1")).toBe(true);
    expect(stateOf(store, "r1")).toBe("READY");
    expect(store.stats().liveBytes).toBe(2_048);
    // 重复 attach / 未知 id 都返回 false,且账本一动没动
    expect(store.attach("r1")).toBe(false);
    expect(store.attach("nope")).toBe(false);
    expect(store.stats().liveBytes).toBe(2_048);
    expectInvariant(store);
  });

  it("ATT-ST-05 take 只做 READY→IN_USE,返回附件但不删 slot、不改计量", () => {
    const store = makeStore();
    const files = [file(1_024), file(2_048)];
    store.reserve("r1", files);
    expect(store.take("r1")).toBeUndefined(); // RESERVED 还不可取
    store.attach("r1");
    expect(store.take("r1")).toBe(files);
    expect(stateOf(store, "r1")).toBe("IN_USE");
    expect(store.stats().slotCount).toBe(1);
    expect(store.stats().liveBytes).toBe(3_072);
    // 同一份字节不会被第二条执行链取走两次
    expect(store.take("r1")).toBeUndefined();
    expectInvariant(store);
  });

  it("ATT-ST-06 drop 幂等:删除并扣回字节,重复 drop 与未知 id 都是 no-op", () => {
    const store = makeStore();
    store.reserve("r1", [file(4_096)]);
    store.attach("r1");
    store.take("r1");
    store.drop("r1");
    expect(store.stats().liveBytes).toBe(0);
    expect(store.stats().slotCount).toBe(0);
    store.drop("r1");
    store.drop("never-reserved");
    expectInvariant(store);
  });
});

describe("AttachmentStore sweep(§十二:以数据库活动态为准,不是固定 TTL)", () => {
  it("ATT-ST-08A RESERVED 在宽限期内一律保留,即使数据库里还没有对应活动行", async () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000)]);
    activeIds = [];
    expect(await store.sweep()).toBe(0);
    expect(store.stats().liveBytes).toBe(1_000);
    expectInvariant(store);
  });

  it("ATT-ST-08B RESERVED 超过宽限期且数据库无活动 Request 才被回收", async () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000)]);
    now += 5 * 60_000; // 宽限期边界(>=)
    activeIds = [];
    expect(await store.sweep()).toBe(1);
    expect(store.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
  });

  it("ATT-ST-08C 数据库仍活动(PENDING/PROCESSING/CANCELLING)的 READY 附件永不被删", async () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000)]);
    store.attach("r1");
    activeIds = ["r1"];
    now += 60 * 60_000;
    expect(await store.sweep()).toBe(0);
    expect(stateOf(store, "r1")).toBe("READY");
    expectInvariant(store);
  });

  it("ATT-ST-08D 已终态的 READY 附件(如 PENDING 被取消)由 sweep 回收", async () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000)]);
    store.attach("r1");
    activeIds = [];
    expect(await store.sweep()).toBe(1);
    expectInvariant(store);
  });

  it("ATT-ST-09 IN_USE 永不参与 sweep,释放权只属于执行链的 finally", async () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000)]);
    store.attach("r1");
    store.take("r1");
    activeIds = [];
    now += 60 * 60_000;
    expect(await store.sweep()).toBe(0);
    expect(stateOf(store, "r1")).toBe("IN_USE");
    expect(store.stats().liveBytes).toBe(1_000);
    store.drop("r1");
    expectInvariant(store);
  });

  it("ATT-ST-10 dispose 撤掉定时器并清空容器,liveBytes 归零", async () => {
    const store = makeStore();
    store.reserve("r1", [file(1_000)]);
    store.reserve("r2", [file(2_000)]);
    store.attach("r2");
    store.take("r2");
    store.dispose();
    expect(store.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
    expectInvariant(store);
    // dispose 之后容器仍可安全使用(没有遗留定时器会再动账本)
    expect(await store.sweep()).toBe(0);
    expectInvariant(store);
  });
});
