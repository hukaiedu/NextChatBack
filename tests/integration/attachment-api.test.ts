import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_TOTAL_MAX_BYTES,
} from "../../src/config/constants.js";
import type { ModelRequestModel } from "../../src/generated/prisma/models.js";
import type { RawAttachment } from "../../src/modules/message/attachment.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import {
  attachment,
  attachmentImage,
  decodedBytes,
  expectAttachmentInvariant,
} from "../attachment-fixtures.js";

/**
 * V1.2 I1 §18 + §三:HTTP 层的附件契约与 body limit。
 *
 * Scheduler 一律不启动:这一层只验「进门的规矩」—— 校验顺序、错误码、落库的 attachmentCount,
 * 以及 AttachmentStore 是否按份数占了正确的字节。执行链(§十/§十一)与重启恢复(§十三)
 * 分别在 attachment-lifecycle / attachment-recovery 里验。
 *
 * 一个会话在同一时刻只允许一条活动 Request,所以「两次都成功」的用例必须各用新会话。
 */

let ctx: TestContext;
let conversationId = "";

interface SendBody {
  data: { request: ModelRequestModel; deduplicated: boolean };
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

async function send(
  items: RawAttachment[] | undefined,
  key: string,
  content = "看图",
): Promise<{ status: number; body: SendBody | ErrorBody }> {
  const res = await sendMessage(ctx.baseUrl, conversationId, content, key, undefined, items);
  return { status: res.status, body: (await res.json()) as SendBody | ErrorBody };
}

/** 请求被拒时必须一个字节都没占内存、也没留下 Request / Message */
async function expectRejectedCleanly(key: string): Promise<void> {
  expect(ctx.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
  expect(await ctx.prisma.modelRequest.findFirst({ where: { idempotencyKey: key } })).toBeNull();
  expect(await ctx.prisma.message.count({ where: { conversationId } })).toBe(0);
}

beforeAll(async () => {
  ctx = await setupTestContext();
});

beforeEach(async () => {
  await ctx.reset();
  conversationId = (await createConversation(ctx.baseUrl, "attachment-api")).id;
});

afterAll(async () => {
  await ctx.close();
});

describe("API 附件契约(§18)", () => {
  it("ATT-API-01 单张合法 PNG → 202 + attachmentCount=1 + READY slot 占住真实字节", async () => {
    const items = [attachment("image/png", 2_048)];
    const { status, body } = await send(items, "api-01");
    expect(status).toBe(202);
    const request = (body as SendBody).data.request;
    expect(request.attachmentCount).toBe(1);
    expect(request.status).toBe("PENDING");

    const stats = ctx.attachmentStore.stats();
    expect(stats.slotCount).toBe(1);
    expect(stats.liveBytes).toBe(decodedBytes(items));
    expect(stats.slots).toEqual([
      { requestId: request.id, state: "READY", byteSize: decodedBytes(items) },
    ]);
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-API-02 白名单四种类型各一张(= 张数上限)→ 202,份数与总字节逐一对齐", async () => {
    const items = [
      attachment("image/png", 1_000),
      attachment("image/jpeg", 1_100),
      attachment("image/webp", 1_200),
      attachment("image/gif", 1_300),
    ];
    expect(items).toHaveLength(ATTACHMENT_MAX_COUNT);
    const { status, body } = await send(items, "api-02");
    expect(status).toBe(202);
    expect((body as SendBody).data.request.attachmentCount).toBe(ATTACHMENT_MAX_COUNT);
    expect(ctx.attachmentStore.stats().liveBytes).toBe(decodedBytes(items));
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-API-03 第 5 张 → 413 ATTACHMENT_TOO_LARGE 且零副作用", async () => {
    const five = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, i) =>
      attachment("image/png", 512 + i),
    );
    const { status, body } = await send(five, "api-03");
    expect(status).toBe(413);
    expect((body as ErrorBody).error.code).toBe("ATTACHMENT_TOO_LARGE");
    await expectRejectedCleanly("api-03");
  });

  it("ATT-API-04 类型不在白名单 → 415 UNSUPPORTED_ATTACHMENT_TYPE", async () => {
    const bmp: RawAttachment = {
      name: "a.bmp",
      mimeType: "image/bmp",
      data: `data:image/bmp;base64,${Buffer.from([0x42, 0x4d, 1, 2]).toString("base64")}`,
    };
    const { status, body } = await send([bmp], "api-04");
    expect(status).toBe(415);
    expect((body as ErrorBody).error.code).toBe("UNSUPPORTED_ATTACHMENT_TYPE");
    await expectRejectedCleanly("api-04");
  });

  it("ATT-API-05 声明与真实字节不一致(PNG 装 JPEG 头)→ 415,绝不降级收字节", async () => {
    const lying: RawAttachment = {
      name: "lying.png",
      mimeType: "image/png",
      data: `data:image/png;base64,${attachmentImage("image/jpeg").toString("base64")}`,
    };
    const { status, body } = await send([lying], "api-05");
    expect(status).toBe(415);
    expect((body as ErrorBody).error.code).toBe("UNSUPPORTED_ATTACHMENT_TYPE");
    await expectRejectedCleanly("api-05");
  });

  it("ATT-API-06 mimeType 与 dataURL 前缀互相矛盾 → 415", async () => {
    const mismatched: RawAttachment = { ...attachment("image/png"), mimeType: "image/webp" };
    const { status, body } = await send([mismatched], "api-06");
    expect(status).toBe(415);
    expect((body as ErrorBody).error.code).toBe("UNSUPPORTED_ATTACHMENT_TYPE");
    await expectRejectedCleanly("api-06");
  });

  it("ATT-API-07 dataURL 非法 / base64 非法 → 400 VALIDATION_ERROR", async () => {
    for (const [key, data] of [
      ["api-07a", "https://example.com/a.png"],
      ["api-07b", "data:image/png;base64,aGVsbG8"],
      ["api-07c", "data:image/png;base64,!!!!"],
    ] as const) {
      const { status, body } = await send([{ name: "a.png", mimeType: "image/png", data }], key);
      expect(status).toBe(400);
      expect((body as ErrorBody).error.code).toBe("VALIDATION_ERROR");
      await expectRejectedCleanly(key);
    }
  });

  it("ATT-API-08 单图解码后 >5MB → 413 ATTACHMENT_TOO_LARGE", async () => {
    const { status, body } = await send(
      [attachment("image/png", ATTACHMENT_MAX_BYTES + 1)],
      "api-08",
    );
    expect(status).toBe(413);
    expect((body as ErrorBody).error.code).toBe("ATTACHMENT_TOO_LARGE");
    await expectRejectedCleanly("api-08");
  });

  it("ATT-API-09 总量 >10MB(单图都不超限)→ 413 ATTACHMENT_TOO_LARGE", async () => {
    // 总上限之上的解码量必须仍装得进 14MB body,否则先被传输层拒掉、到不了业务判据:
    // 3.5 + 3.5 + 3.2 = 10.2MB → base64 约 13.6MB(膨胀 4/3),留得住 JSON 开销。
    const items = [
      attachment("image/png", 3_670_016),
      attachment("image/jpeg", 3_670_016),
      attachment("image/gif", 3_350_000),
    ];
    expect(decodedBytes(items)).toBeGreaterThan(ATTACHMENT_TOTAL_MAX_BYTES);
    const payloadBytes = items.reduce((sum, item) => sum + item.data.length, 0);
    expect(payloadBytes).toBeLessThan(14 * 1024 * 1024);

    const { status, body } = await send(items, "api-09");
    expect(status).toBe(413);
    expect((body as ErrorBody).error.code).toBe("ATTACHMENT_TOO_LARGE");
    await expectRejectedCleanly("api-09");
  });

  it("ATT-API-10 attachments 缺省与 [] 都与纯文本等价:attachmentCount=0 且容器不被触碰", async () => {
    expect((await send(undefined, "api-10a")).status).toBe(202);
    // 同会话已有活动 Request,空数组这条要用新会话才能验「同样成功」
    const second = (await createConversation(ctx.baseUrl, "attachment-api-empty")).id;
    const res = await sendMessage(
      ctx.baseUrl,
      second,
      "看图",
      "api-10b",
      undefined,
      [],
    );
    expect(res.status).toBe(202);

    const rows = await ctx.prisma.modelRequest.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.attachmentCount)).toEqual([0, 0]);
    // 零份数请求一个 slot 都不该占(§七「无附件时不 reserve」)
    expect(ctx.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
  });

  it("ATT-API-11 附件校验排在会话存在性之前:不存在的会话 + 非法类型 → 415 而非 404", async () => {
    const res = await sendMessage(
      ctx.baseUrl,
      "00000000-0000-0000-0000-000000000000",
      "看图",
      "api-11",
      undefined,
      [
        {
          name: "a.bin",
          mimeType: "application/octet-stream",
          data: `data:application/octet-stream;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`,
        },
      ],
    );
    expect(res.status).toBe(415);
  });

  it("ATT-API-12 响应与数据库都只有份数,没有附件字节", async () => {
    const items = [attachment("image/png", 4_096)];
    const { status, body } = await send(items, "api-12");
    expect(status).toBe(202);
    expect(JSON.stringify(body)).not.toContain(items[0]!.data);

    const row = await ctx.prisma.modelRequest.findFirstOrThrow({
      where: { idempotencyKey: "api-12" },
    });
    expect(JSON.stringify(row)).not.toContain(items[0]!.data);
    expect(row.attachmentCount).toBe(1);
  });
});

describe("body limit(§三:只有 messages 一条路径放宽到 14MB)", () => {
  async function postJson(
    path: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; code: string }> {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { error?: { code: string } };
    return { status: res.status, code: body.error?.code ?? "" };
  }

  it("ATT-ML-01 300KB 的 messages 请求不被默认 100KB 上限拒绝", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "ml-01" },
      // content 本身在默认上限内,pad 把整包推过 100KB → 只有放宽路径能通过
      body: JSON.stringify({ content: "x".repeat(40_000), pad: "y".repeat(300_000) }),
    });
    expect(res.status).toBe(202);
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-ML-02 300KB 打到其他路由 → 413 PAYLOAD_TOO_LARGE(既有 500 误判已修)", async () => {
    const out = await postJson("/api/conversations", { title: "t", pad: "y".repeat(300_000) });
    expect(out).toEqual({ status: 413, code: "PAYLOAD_TOO_LARGE" });
  });

  it("ATT-ML-03 15MB 打到 messages → 413,超的是放宽后的上限而不是默认上限", async () => {
    const out = await postJson(
      `/api/conversations/${conversationId}/messages`,
      { content: "x".repeat(40_000), pad: "y".repeat(15 * 1024 * 1024) },
      { "Idempotency-Key": "ml-03" },
    );
    expect(out).toEqual({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    await expectRejectedCleanly("ml-03");
  });

  it("ATT-ML-04 GET messages 无回归,且列表不回显附件字节", async () => {
    const items = [attachment("image/png", 1_024)];
    expect((await send(items, "ml-04")).status).toBe(202);
    const res = await fetch(
      `${ctx.baseUrl}/api/conversations/${conversationId}/messages?limit=50`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(JSON.stringify(body.data)).toContain("USER");
    expect(JSON.stringify(body)).not.toContain(items[0]!.data);
  });

  it("ATT-ML-05 /messages/extra 拿不到 14MB 额度(放宽必须锚定精确路径)", async () => {
    const out = await postJson(
      `/api/conversations/${conversationId}/messages/extra`,
      { pad: "y".repeat(300_000) },
      { "Idempotency-Key": "ml-05" },
    );
    // 前缀挂载会把这条一起放宽;锚定正则下它先被默认 100KB 上限拒掉,连路由都进不去
    expect(out).toEqual({ status: 413, code: "PAYLOAD_TOO_LARGE" });
  });

  it("ATT-ML-06 带 body 的 404 仍走原错误形状", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations/nonexistent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("CONVERSATION_NOT_FOUND");
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });
});
