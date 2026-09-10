/**
 * I2-B:Provider 附件注入协议单元测试(PROTO / AD / RESIDUE 矩阵)。
 *
 * 全部用例走 `GeminiWebAdapter.runPrompt` 生产路径 —— 只压时间参数,不替换协议;
 * Fake 只记 name/mimeType/byteLength/selector(§22),不保存任何图片字节。
 *
 * 剧本驱动:`attachment.onPlusClick` / `onUpload` 是按序消费的状态补丁,
 * 用来复现 I2-A 真机定案的 `false→click→false→click→true→hydration→input=1`。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { ERROR_CODE_HTTP_STATUS } from "../../src/common/errors/error-code-map.js";
import { createLogger } from "../../src/common/logger/logger.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { GeminiWebAdapter } from "../../src/providers/gemini/gemini.adapter.js";
import { isContextClosedError } from "../../src/providers/gemini/gemini.errors.js";
import {
  GEMINI_ATTACHMENT_SELECTORS,
  GEMINI_SELECTORS,
} from "../../src/providers/gemini/gemini.selectors.js";
import type {
  GeminiAdapterOptions,
  GeminiAttachmentInput,
} from "../../src/providers/gemini/gemini.types.js";
import { FakeDriver, createFakeManager } from "../fakes.js";
import type { FakePage, FakePageScript } from "../fakes.js";

const BASE_URL = "https://gemini.google.com/app";
const CONVERSATION_URL = "https://gemini.google.com/app/b386795e14915155";

/** 单测把节奏压到毫秒级;真实的 20s/5s 默认值见 gemini.adapter.ts 的 DEFAULTS */
const FAST: GeminiAdapterOptions = {
  responseTimeoutMs: 400,
  composerReadyTimeoutMs: 60,
  sendAckTimeoutMs: 60,
  urlGraceMs: 5,
  historySettleTimeoutMs: 120,
  pollIntervalMs: 2,
  stableWindowMs: 6,
  attachmentReadyTimeoutMs: 150,
  attachmentPanelTimeoutMs: 30,
};

const FRESH_DOM: Record<string, number> = {
  [GEMINI_SELECTORS.composer]: 1,
  [GEMINI_SELECTORS.quillComposer]: 1,
  [GEMINI_SELECTORS.signInLink]: 1,
  [GEMINI_SELECTORS.userTurn]: 0,
  [GEMINI_SELECTORS.turnShell]: 0,
  [GEMINI_SELECTORS.answer]: 0,
};

/** 第一轮发送后被页面接受的结构:外壳数 == 回答数 表示已生成完 */
const FIRST_TURN_DOM: Record<string, number> = {
  [GEMINI_SELECTORS.userTurn]: 1,
  [GEMINI_SELECTORS.turnShell]: 1,
  [GEMINI_SELECTORS.answer]: 1,
};

const logger = createLogger("silent");

type SetupOptions = Partial<GeminiAdapterOptions> & { domCounts?: Record<string, number> };

async function setup(
  script: FakePageScript = {},
  options: SetupOptions = {},
): Promise<{ adapter: GeminiWebAdapter; page: FakePage; manager: BrowserManager }> {
  const { domCounts, ...adapterOptions } = options;
  const driver = new FakeDriver();
  const manager = createFakeManager(driver, {
    ...script,
    domCounts: { ...FRESH_DOM, ...(script.domCounts ?? {}), ...(domCounts ?? {}) },
  });
  await manager.openGemini();
  const page = driver.latestContext?.lastPage;
  if (!page) {
    throw new Error("fake page was not created");
  }
  const adapter = new GeminiWebAdapter({
    manager,
    baseUrl: BASE_URL,
    options: { ...FAST, ...adapterOptions },
    logger,
  });
  return { adapter, page, manager };
}

type RunInput = Parameters<GeminiWebAdapter["runPrompt"]>[0];

function runInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    prompt: "只回复:收到",
    existingUrl: null,
    onConversationUrl: async () => {},
    ...overrides,
  };
}

/** 发送被页面接受、回答稳定的标准剧本 */
function acceptedSend(): FakePageScript {
  return { afterSend: { url: CONVERSATION_URL, domCounts: FIRST_TURN_DOM, answerTexts: ["收到"] } };
}

function imageAttachment(
  name: string,
  mimeType: GeminiAttachmentInput["mimeType"] = "image/png",
  byteLength = 8,
): GeminiAttachmentInput {
  return { name, mimeType, buffer: Buffer.alloc(byteLength, 1) };
}

/** 面板已展开且 input 已水合的「可直接注入」起点 */
const INPUT_READY = { expanded: "true", imageInputCount: 1 } as const;

describe("I2-B 附件入口状态机", () => {
  it("PROTO-01:false→click→false→click→true→水合→input=1 必须以 READY 收尾并发送", async () => {
    const { adapter, page } = await setup({
      attachment: {
        expanded: "false",
        imageInputCount: 0,
        hydrateInputAfterMs: 10,
        onPlusClick: [{ expanded: "false" }, { expanded: "true" }],
      },
      ...acceptedSend(),
    });

    const result = await adapter.runPrompt(
      runInput({ attachments: [imageAttachment("a.png")] }),
    );

    expect(result.answer).toBe("收到");
    // 第一次点击没有迁移(仍在 "false"),第二次才展开;绝无第三次
    expect(page.clickNthCalls).toEqual([
      { selector: GEMINI_ATTACHMENT_SELECTORS.plus, index: 0 },
      { selector: GEMINI_ATTACHMENT_SELECTORS.plus, index: 0 },
    ]);
    expect(page.uploadCalls).toHaveLength(1);
    expect(page.fillCalls).toHaveLength(1);
    expect(page.pressCalls).toHaveLength(1);
    // §17 顺序:注入完成 → 才 fill → 才 Enter
    expect(page.events).toEqual(["plus-click", "plus-click", "upload", "fill", "press:Enter"]);
  });

  it("PROTO-02:连续两次状态驱动点击都没有迁移 → PROVIDER_ATTACHMENT_FAILED 且不注入不发送", async () => {
    const { adapter, page } = await setup({
      attachment: { expanded: "false", imageInputCount: 0, onPlusClick: [{}, {}] },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("stuck"),
    });
    expect(page.clickNthCalls).toHaveLength(2);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("AD-01:面板已展开但 input 始终不水合 → FAILED,期间不得再点 +", async () => {
    const { adapter, page } = await setup({
      attachment: { expanded: "true", imageInputCount: 0 },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("did not hydrate"),
    });
    // expanded==="true" 时点击会收起面板 —— 一次都不能点
    expect(page.clickNthCalls).toEqual([]);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("AD-01b:没有可点击尺寸的 + → ENTRY_NOT_READY,零点击零注入零发送", async () => {
    const { adapter, page } = await setup({
      attachment: { plusSized: false, imageInputCount: 0 },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("plus button is not sized"),
    });
    expect(page.clickNthCalls).toEqual([]);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("AD-02:image input 多于 1 个 → FAILED(结构异常不做猜测)", async () => {
    const { adapter, page } = await setup({
      attachment: { ...INPUT_READY, imageInputCount: 2 },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("exactly 1 image input"),
    });
    expect(page.clickNthCalls).toEqual([]);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
  });

  it("AD-06:两张图只调用一次 setInputFiles,且一次传完整数组", async () => {
    const { adapter, page } = await setup(
      { attachment: { ...INPUT_READY }, ...acceptedSend() },
      { domCounts: { "images-files-uploader img": 99, 'img[src^="blob:"]': 99 } },
    );

    const files = [
      imageAttachment("a.png", "image/png", 12),
      imageAttachment("b.jpg", "image/jpeg", 34),
    ];
    const result = await adapter.runPrompt(runInput({ attachments: files }));

    expect(result.answer).toBe("收到");
    expect(page.clickNthCalls).toEqual([]); // 不逐图开合面板
    expect(page.uploadCalls).toEqual([
      {
        selector: GEMINI_ATTACHMENT_SELECTORS.imageInput,
        files: [
          { name: "a.png", mimeType: "image/png", byteLength: 12 },
          { name: "b.jpg", mimeType: "image/jpeg", byteLength: 34 },
        ],
      },
    ]);
    expect(page.pressCalls).toHaveLength(1);
  });

  it("AD-03:setInputFiles 普通失败 → FAILED,不 fill 不 Enter", async () => {
    const { adapter, page } = await setup({
      attachment: { ...INPUT_READY, failUpload: true },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("setInputFiles failed"),
    });
    expect(page.uploadCalls).toHaveLength(1);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("AD-03b:注入瞬间页面关闭 → 包装错误仍被关闭族识别(§30 浏览器错误优先)", async () => {
    const { adapter } = await setup({
      attachment: { ...INPUT_READY, failUploadClosed: true },
    });

    const err = await adapter
      .runPrompt(runInput({ attachments: [imageAttachment("a.png")] }))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED });
    // 分类器下钻 cause 链后仍能认出关闭族 → Scheduler 可优先映射 PAGE_CLOSED/BROWSER_CRASHED
    expect(isContextClosedError(err)).toBe(true);
  });

  it("AD-07:2 图只到位 1 个 → PROVIDER_ATTACHMENT_TIMEOUT(504),绝不发送", async () => {
    const { adapter, page } = await setup({
      attachment: { ...INPUT_READY, onUpload: [{ attachmentCount: 1 }] },
    });

    const started = Date.now();
    await expect(
      adapter.runPrompt(
        runInput({ attachments: [imageAttachment("a.png"), imageAttachment("b.jpg")] }),
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_ATTACHMENT_TIMEOUT });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("AD-04/06b:计数已等于 expectedCount 但 loading 仍在 → 不 fill 不 Enter", async () => {
    const { adapter, page } = await setup({
      attachment: { ...INPUT_READY, onUpload: [{ attachmentCount: 1, uploading: true }] },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_ATTACHMENT_TIMEOUT });
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
    expect(page.events).toEqual(["upload"]);
  });

  it("AD-08:上传中 → loading 清除后才 fill/Enter,顺序由守卫保证", async () => {
    const { adapter, page } = await setup({
      attachment: {
        ...INPUT_READY,
        uploadingClearAfterMs: 12,
        onUpload: [{ attachmentCount: 1, uploading: true }],
      },
      ...acceptedSend(),
    });

    const result = await adapter.runPrompt(
      runInput({ attachments: [imageAttachment("a.png")] }),
    );

    expect(result.answer).toBe("收到");
    expect(page.events).toEqual(["upload", "fill", "press:Enter"]);
  });

  it("AD-05:上传报错是终局 —— 不等满 readyTimeout 立即 FAILED,绝不 Enter", async () => {
    const { adapter, page } = await setup(
      {
        attachment: {
          ...INPUT_READY,
          onUpload: [{ attachmentCount: 1, hasError: true }],
        },
      },
      { attachmentReadyTimeoutMs: 2_000 },
    );

    const started = Date.now();
    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("reported an error"),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("张数越界(内部 invariant 违反)→ FAILED,不触碰页面", async () => {
    const { adapter, page } = await setup({
      attachment: { ...INPUT_READY },
    });

    const five = Array.from({ length: 5 }, (_unused, i) =>
      imageAttachment(`f${i}.png`),
    );
    await expect(
      adapter.runPrompt(runInput({ attachments: five })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("unexpected attachment count"),
    });
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
  });

  it("picker overlay 在场 → FAILED(只检测不处置),不注入不发送", async () => {
    const { adapter, page } = await setup({
      attachment: { pickerOverlay: true },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("picker overlay"),
    });
    expect(page.clickNthCalls).toEqual([]);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
  });

  it("§28:生成中先等 idle(期间零点击),idle 后正常走完协议", async () => {
    const { adapter, page } = await setup({
      attachment: {
        expanded: "false",
        imageInputCount: 0,
        generating: true,
        generatingClearAfterMs: 20,
        hydrateInputAfterMs: 10,
        onPlusClick: [{ expanded: "true" }],
      },
      ...acceptedSend(),
    });

    const result = await adapter.runPrompt(
      runInput({ attachments: [imageAttachment("a.png")] }),
    );

    expect(result.answer).toBe("收到");
    // 生成中绝不点 +:第一个 plus-click 必须晚于 stop 消失
    expect(page.events.indexOf("generating-idle")).toBe(0);
    expect(page.events.indexOf("generating-idle")).toBeLessThan(
      page.events.indexOf("plus-click"),
    );
  });

  it("§28:生成一直不结束 → FAILED(有界),零点击零注入", async () => {
    const { adapter, page } = await setup({
      attachment: { expanded: "false", imageInputCount: 0, generating: true },
      ...acceptedSend(),
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("still generating"),
    });
    expect(page.clickNthCalls).toEqual([]);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });
});

describe("I2-B composer 残留守卫", () => {
  it("RESIDUE-01:带附件请求前发现残留 → 先 reload 复位再注入(旧判据 domCounts 不参与)", async () => {
    const { adapter, page } = await setup(
      {
        attachment: {
          attachmentCount: 1,
          afterReload: { ...INPUT_READY },
        },
        ...acceptedSend(),
      },
      // 故意让作废判据给出与附件数不一致的值:业务代码若偷读它们就会误判
      {
        domCounts: {
          "images-files-uploader img": 0,
          'img[src^="blob:"]': 7,
          "input-area-v2 .gem-attachment-content": 99,
        },
      },
    );

    const result = await adapter.runPrompt(
      runInput({ attachments: [imageAttachment("a.png")] }),
    );

    expect(result.answer).toBe("收到");
    expect(page.reloadCalls).toHaveLength(1);
    expect(page.events).toEqual(["reload", "upload", "fill", "press:Enter"]);
  });

  it("RESIDUE-02:reload 后仍残留 → FAILED,不注入不发送", async () => {
    const { adapter, page } = await setup({
      attachment: { attachmentCount: 2, afterReload: { attachmentCount: 1 } },
    });

    await expect(
      adapter.runPrompt(runInput({ attachments: [imageAttachment("a.png")] })),
    ).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("after reload"),
    });
    expect(page.reloadCalls).toHaveLength(1);
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("TEXT-RESIDUE-01:纯文本请求遇到残留 → 复位为 0 后才 fill/Enter", async () => {
    const { adapter, page } = await setup({
      attachment: { attachmentCount: 1 },
      ...acceptedSend(),
    });

    const result = await adapter.runPrompt(runInput());

    expect(result.answer).toBe("收到");
    expect(page.reloadCalls).toHaveLength(1);
    expect(page.events).toEqual(["reload", "fill", "press:Enter"]);
    expect(page.clickNthCalls).toEqual([]);
    expect(page.uploadCalls).toEqual([]);
  });

  it("TEXT-RESIDUE-02:复位失败 → FAILED,纯文本也不发(fill=0/Enter=0)", async () => {
    const { adapter, page } = await setup({
      attachment: { attachmentCount: 1, afterReload: { attachmentCount: 1 } },
      ...acceptedSend(),
    });

    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
    });
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("纯文本路径在干净 composer 上保持原行为(0 reload / 0 点击 / 1 fill / 1 Enter)", async () => {
    const { adapter, page } = await setup({ ...acceptedSend() });

    const result = await adapter.runPrompt(runInput());

    expect(result.answer).toBe("收到");
    expect(page.reloadCalls).toEqual([]);
    expect(page.clickNthCalls).toEqual([]);
    expect(page.fillCalls).toEqual([
      { selector: GEMINI_SELECTORS.quillComposer, value: "只回复:收到" },
    ]);
    expect(page.pressCalls).toHaveLength(1);
  });
});

/**
 * Final Fix 回归:I2-B 早期版本在快照读取抛错时返回空快照,残留守卫会把它
 * 当成「composer 干净」直接 fill/Enter,重开 I0 R1 的串轮泄漏。
 * 现行语义:读成功且计数为 0 ≠ 读失败 —— 后者是错误,绝不参与判定。
 */
describe("I2-B Final Fix:快照读取失败 fail-closed", () => {
  it("I2B-SNAPSHOT-01:残留 1 个 + 首次快照读取抛错 → 纯文本也不发(fill=0/Enter=0)", async () => {
    const { adapter, page } = await setup({
      attachment: { attachmentCount: 1, failSnapshotRead: true },
      ...acceptedSend(),
    });

    const err = await adapter.runPrompt(runInput()).then(() => null).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("snapshot read failed"),
    });
    // 页面状态未知时不做任何动作:既不 reload 复位,也不 fill/Enter
    expect(page.reloadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
    // 瞬态读失败不得被误判成关闭族(否则 Scheduler 会映射成 PAGE_CLOSED/CRASHED)
    expect(isContextClosedError(err)).toBe(false);
  });

  it("I2B-SNAPSHOT-02:读取正常且确实没有附件 → count=0 是合法观测,纯文本照常发送", async () => {
    // 与 SNAPSHOT-01 的页面状态完全相同(0 附件),唯一差别是读取成功
    const { adapter, page } = await setup({ ...acceptedSend() });

    const result = await adapter.runPrompt(runInput());

    expect(result.answer).toBe("收到");
    expect(page.snapshotReadCount).toBeGreaterThan(0);
    expect(page.reloadCalls).toEqual([]);
    expect(page.fillCalls).toHaveLength(1);
    expect(page.pressCalls).toHaveLength(1);
  });

  it("I2B-SNAPSHOT-03:读取抛关闭族异常 → 原样上抛,不得包装成 ATTACHMENT_FAILED", async () => {
    const { adapter, page } = await setup({
      attachment: { failSnapshotClosed: true },
      ...acceptedSend(),
    });

    const err = await adapter
      .runPrompt(runInput({ attachments: [imageAttachment("a.png")] }))
      .then(() => null)
      .catch((e: unknown) => e);

    // §30 浏览器错误优先:Scheduler 仍能把它映射为 PAGE_CLOSED / BROWSER_CRASHED
    expect(isContextClosedError(err)).toBe(true);
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(page.uploadCalls).toEqual([]);
    expect(page.fillCalls).toEqual([]);
    expect(page.pressCalls).toEqual([]);
  });

  it("I2B-SNAPSHOT-04:注入成功但 Enter 前快照读取抛错 → FAILED,Enter=0", async () => {
    // 注入后的读取次序:①就绪轮询 ②fill 守卫 ③Enter 前断言 —— 预算 2 让前两次成功,
    // 恰好把失败落在 Enter 前断言上(不允许拿旧读数发送)
    const { adapter, page } = await setup({
      attachment: { ...INPUT_READY, failSnapshotAfterUpload: 2 },
    });

    const err = await adapter
      .runPrompt(runInput({ attachments: [imageAttachment("a.png")] }))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
      message: expect.stringContaining("snapshot read failed"),
    });
    expect(page.uploadCalls).toHaveLength(1);
    // 文字已填入,但 Enter 前断言拿不到可信读数 → 停在这一步,绝不按旧读数发送
    expect(page.fillCalls).toHaveLength(1);
    expect(page.pressCalls).toEqual([]);
  });
});

describe("I2-B 错误码与 selector 冻结", () => {
  it("附件错误码映射 502 / 504", () => {
    expect(ERROR_CODE_HTTP_STATUS.PROVIDER_ATTACHMENT_FAILED).toBe(502);
    expect(ERROR_CODE_HTTP_STATUS.PROVIDER_ATTACHMENT_TIMEOUT).toBe(504);
  });

  it("GEMINI_ATTACHMENT_SELECTORS 与 §4 登记表逐条一致", () => {
    expect(GEMINI_ATTACHMENT_SELECTORS).toEqual({
      imageInput: 'input[type="file"][accept="image/*"]',
      plus: 'input-area-v2 button:has(mat-icon[fonticon="plus"])',
      composerAttachment: "input-area-v2 .gem-attachment-content",
      uploading: "input-area-v2 .gem-attachment-loading-container",
      attachmentError: 'input-area-v2 mat-icon[fonticon="error"]',
      generating: 'input-area-v2 mat-icon[fonticon="stop"]',
      attachmentClose: 'input-area-v2 button:has(mat-icon[fonticon="close"])',
      pickerOverlay: ".picker-iframe-container, .picker-api-container, google-picker",
    });
  });

  it("生产代码不含作废判据/越权原语(attachments 模块与 driver 附件段)", () => {
    const banned = [
      "images-files-uploader",
      "blob:",
      "progress_activity",
      "arrow_upward",
      "elementFromPoint",
      "evaluate(",
      "force:",
      ".first()",
    ];
    const attachmentsSource = readFileSync(
      resolve(process.cwd(), "src/providers/gemini/gemini.attachments.ts"),
      "utf8",
    );
    const driverSource = readFileSync(
      resolve(process.cwd(), "src/providers/gemini/playwright-driver.ts"),
      "utf8",
    );
    // driver 的附件能力段从 I2-B 快照方法开始到文件结尾(旧 fill/click 的 .first() 不在范围内)
    const attachmentSection = driverSource.slice(
      driverSource.indexOf("I2-B:读取附件/入口快照"),
    );

    for (const token of banned) {
      expect(attachmentsSource).not.toContain(token);
      expect(attachmentSection).not.toContain(token);
    }
    // 注册但未使用的 close selector:V1 只用 reload 复位,不得出现点击
    expect(attachmentsSource).not.toContain("attachmentClose");
    expect(attachmentSection).not.toContain("attachmentClose");
  });
});
