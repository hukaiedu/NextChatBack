import { describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { createLogger } from "../../src/common/logger/logger.js";
import { GeminiStreamService } from "../../src/modules/provider/gemini-stream.service.js";
import type { StreamingWriter } from "../../src/modules/provider/gemini-stream.service.js";
import type { MessageService } from "../../src/modules/message/message.service.js";
import { RequestEventEmitter } from "../../src/modules/sse/event-emitter.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MountOptions {
  updateIntervalMs?: number;
  save?: (id: string, content: string) => Promise<boolean>;
}

function mount(opts: MountOptions = {}) {
  const saved: string[] = [];
  const broadcasts: string[] = [];
  const control = { failSave: false };
  const events = new RequestEventEmitter();
  events.subscribe("req_1", (notification) => {
    const { content } = notification as { content?: string };
    if (content !== undefined) {
      broadcasts.push(content);
    }
  });

  const messageService = {
    saveStreamingContent: async (id: string, content: string) => {
      if (opts.save) {
        return opts.save(id, content);
      }
      if (control.failSave) {
        throw new Error("SQLITE_BUSY");
      }
      saved.push(content);
      return true;
    },
  } as unknown as MessageService;

  const service = new GeminiStreamService({
    messageService,
    events,
    logger: createLogger("silent"),
    options: { updateIntervalMs: opts.updateIntervalMs },
  });
  const stream: StreamingWriter = service.open("req_1", "msg_a");
  return { saved, broadcasts, control, events, stream };
}

describe("GeminiStreamService:广播立即、落库节流(§7)", () => {
  it("每次文本变化都立即广播,落库只按节流间隔", async () => {
    const h = mount({ updateIntervalMs: 300 });

    await h.stream.push("a");
    await h.stream.push("ab");
    expect(h.broadcasts).toEqual(["a", "ab"]);
    // 第二次落在节流窗口内:只在内存里等补写
    expect(h.saved).toEqual(["a"]);

    await h.stream.flush();
    expect(h.saved).toEqual(["a", "ab"]);
  });

  it("节流窗口过后下一条直接落库,flush 无残留", async () => {
    const h = mount({ updateIntervalMs: 20 });

    await h.stream.push("a");
    await sleep(30);
    await h.stream.push("ab");
    expect(h.saved).toEqual(["a", "ab"]);

    await h.stream.flush();
    expect(h.saved).toEqual(["a", "ab"]);
  });

  it("updateIntervalMs=0:每次变化都落库(集成测试用的确定性档位)", async () => {
    const h = mount({ updateIntervalMs: 0 });

    await h.stream.push("你好");
    await h.stream.push("你好世界");
    expect(h.saved).toEqual(["你好", "你好世界"]);
    expect(h.broadcasts).toEqual(["你好", "你好世界"]);
  });

  it("读到相同文本不重复广播也不写库", async () => {
    const h = mount({ updateIntervalMs: 0 });

    await h.stream.push("你好");
    await h.stream.push("你好");
    expect(h.broadcasts).toEqual(["你好"]);
    expect(h.saved).toEqual(["你好"]);
  });

  it("Assistant 已离开 STREAMING:抛 STREAMING_UPDATE_FAILED 让执行按失败收尾", async () => {
    const h = mount({ save: async () => false });

    const err = await h.stream.push("你好").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCodes.STREAMING_UPDATE_FAILED);
  });

  it("数据库异常包装成 STREAMING_UPDATE_FAILED", async () => {
    const h = mount({
      save: async () => {
        throw new Error("SQLITE_BUSY");
      },
    });

    const err = await h.stream.push("你好").catch((e: unknown) => e);
    expect((err as AppError).code).toBe(ErrorCodes.STREAMING_UPDATE_FAILED);
    expect((err as AppError).cause).toBeInstanceOf(Error);
  });

  it("收尾补写失败不推翻已成功的执行:只记日志", async () => {
    const h = mount({ updateIntervalMs: 300 });
    await h.stream.push("a");
    await h.stream.push("ab");
    expect(h.broadcasts).toEqual(["a", "ab"]);

    h.control.failSave = true;
    await expect(h.stream.flush()).resolves.toBeUndefined();
    expect(h.saved).toEqual(["a"]);
  });
});
