import type { Logger } from "../../common/logger/logger.js";
import { ATTACHMENT_MAX_COUNT } from "../../config/constants.js";
import type { AttachmentUiState, BrowserPageHandle, BrowserUploadFile } from "./browser-driver.js";
import { attachmentFailed, attachmentTimeout, isContextClosedError } from "./gemini.errors.js";
import { GEMINI_ATTACHMENT_SELECTORS } from "./gemini.selectors.js";
import type { GeminiAttachmentInput } from "./gemini.types.js";

/**
 * I2-B:附件注入协议(全部判据来自 I2-A 真机定案,见 docs/PERSONCHAT_V12_IMAGE_UPLOAD_I2A_REPORT.md §10)。
 *
 * 三条硬约束:
 * 1. 入口状态机只读有尺寸 `+` 的 `aria-expanded` 三态,禁止固定点击次数;
 * 2. 就绪必须按**当前请求的 expectedCount** 精确相等,`>= 1` 不算就绪(4 图只到 3 个不得发送);
 * 3. 任何一步不满足都失败 —— 绝不降级成纯文本发送,也不带着别人/上一次的附件继续。
 */

/** 单次面板动作后等待状态迁移的窗口(真机水合 max ≈1.2s,留 4 倍余量;§10 允许 5s) */
const DEFAULT_PANEL_WAIT_MS = 5_000;

/** 连续多少次「状态驱动动作无任何迁移」判 ENTRY_STUCK(I2-A 定案阈值 2,只决定「还要不要继续」) */
const MAX_NO_TRANSITION = 2;

/** 状态机步数上限(防御性:每次动作最多 1 次迁移,正常 0..3 步就 READY) */
const MAX_STEPS = 12;

/** 点击 `+` 的单次预算(与模型菜单同款 5s 先例:水合期按钮可能尚不可点) */
const PLUS_CLICK_TIMEOUT_MS = 5_000;

export interface AttachmentProtocolOptions {
  /** 附件就绪等待上限(生产 20s;测试压到毫秒级) */
  readyTimeoutMs: number;
  /** 单次面板动作后的状态迁移等待窗口(省略 = 生产默认 5s) */
  panelWaitMs?: number;
  /** 轮询间隔 */
  pollIntervalMs: number;
  /** reload 复位后等 composer 恢复的上限 */
  composerReadyTimeoutMs: number;
}

export interface AttachmentProtocolDeps {
  page: BrowserPageHandle;
  logger: Logger;
  options: AttachmentProtocolOptions;
  /** 等 composer 可交互(复用 Adapter 的实现,登录失效等分类保持一致) */
  waitForComposer: (deadline: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读一次快照。**读取失败 fail closed**:driver 只在真正拿不到快照时抛错,
 * 这里把普通异常包装成 PROVIDER_ATTACHMENT_FAILED(绝不当作 attachmentCount=0);
 * 关闭族异常原样上抛,保持既有 PAGE_CLOSED / BROWSER_CRASHED 分类(§30)。
 */
async function readState(deps: AttachmentProtocolDeps): Promise<AttachmentUiState> {
  try {
    return await deps.page.getAttachmentUiState();
  } catch (err) {
    if (isContextClosedError(err)) {
      throw err;
    }
    throw attachmentFailed("attachment ui snapshot read failed", err);
  }
}

/** reload 当前会话并等 composer 恢复(composer 残留的唯一已验证复位手段) */
async function reloadAndSettle(deps: AttachmentProtocolDeps): Promise<void> {
  await deps.page.reload();
  await deps.waitForComposer(Date.now() + deps.options.composerReadyTimeoutMs);
}

/**
 * §8/§19:composer 必须没有「不属于本次请求」的附件。
 * 纯文本路径与带附件路径都先过这一关(I0 R1:残留会被下一条消息带走)。
 * 有残留 → reload 复位 → 再断言;仍不为 0 → PROVIDER_ATTACHMENT_FAILED。
 */
export async function ensureNoForeignComposerAttachments(
  deps: AttachmentProtocolDeps,
): Promise<void> {
  const state = await readState(deps);
  if (state.pickerOverlay) {
    throw attachmentFailed("picker overlay covers composer");
  }
  if (state.attachmentCount === 0) {
    return;
  }
  deps.logger.info(
    { attachmentCount: state.attachmentCount, reset: "reload" },
    "composer has residual attachments; reloading",
  );
  await reloadAndSettle(deps);
  const after = await readState(deps);
  if (after.pickerOverlay) {
    throw attachmentFailed("picker overlay covers composer after reload");
  }
  if (after.attachmentCount !== 0) {
    throw attachmentFailed(`composer still has ${after.attachmentCount} attachment(s) after reload`);
  }
}

/**
 * §10/§11:状态驱动地把图片 input 带到「恰好 1 个」。
 * `aria-expanded === "true"` 但 input 未水合时只等不点(点下去会收起面板)。
 */
export async function ensureAttachmentInput(deps: AttachmentProtocolDeps): Promise<void> {
  let noTransition = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const state = await readState(deps);
    if (state.attachmentCount > 0) {
      throw attachmentFailed("composer dirtied before attach");
    }
    if (state.imageInputCount > 1) {
      throw attachmentFailed(`expected exactly 1 image input, found ${state.imageInputCount}`);
    }
    if (state.imageInputCount === 1) {
      return;
    }
    if (state.pickerOverlay) {
      throw attachmentFailed("picker overlay covers composer");
    }
    if (state.generating) {
      // 生成中 `+` 点不动:先等 idle,期间零点击(§28)
      await waitGenerationIdle(deps);
      continue;
    }
    if (!state.plusSized) {
      // plusSized=false 只能读作「此刻没有可点的盒子」,不推断附件有无(§29)
      throw attachmentFailed(
        state.plusExists ? "entry not ready: plus button is not sized" : "entry not ready: plus button is missing",
      );
    }
    if (state.expanded === "true") {
      const outcome = await waitStateChange(
        deps,
        (s) => (s.imageInputCount === 1 ? "READY" : s.expanded !== "true" ? "PANEL_CLOSED" : null),
      );
      if (outcome === null) {
        throw attachmentFailed("image input did not hydrate after panel expanded");
      }
      continue;
    }
    // expanded 为 null(占位)或 "false"(已武装):点一次,等迁移
    await deps.page.clickNth(GEMINI_ATTACHMENT_SELECTORS.plus, state.plusSizedIndex, {
      timeoutMs: PLUS_CLICK_TIMEOUT_MS,
    });
    const before = state.expanded;
    const moved = await waitStateChange(
      deps,
      (s) => (s.imageInputCount === 1 ? "READY" : s.expanded !== before ? "MOVED" : null),
    );
    if (moved === null) {
      noTransition += 1;
      if (noTransition >= MAX_NO_TRANSITION) {
        throw attachmentFailed("entry stuck: no state transition after 2 actions");
      }
    } else {
      noTransition = 0;
    }
  }
  throw attachmentFailed("panel state machine did not reach READY");
}

/** 生成中 → 等 stop 图标消失(有界);期间零点击 */
async function waitGenerationIdle(deps: AttachmentProtocolDeps): Promise<void> {
  const deadline = Date.now() + deps.options.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await readState(deps)).generating) {
      return;
    }
    await sleep(deps.options.pollIntervalMs);
  }
  throw attachmentFailed("page is still generating (stop icon did not disappear)");
}

/** 轮询到 condition 返回非 null(有界);超时返回 null */
async function waitStateChange(
  deps: AttachmentProtocolDeps,
  condition: (state: AttachmentUiState) => string | null,
): Promise<string | null> {
  const deadline = Date.now() + (deps.options.panelWaitMs ?? DEFAULT_PANEL_WAIT_MS);
  for (;;) {
    const state = await readState(deps);
    const outcome = condition(state);
    if (outcome !== null) {
      return outcome;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(deps.options.pollIntervalMs);
  }
}

/**
 * §13/§14/§16:一次注入全部图片,再按 expectedCount 精确等就绪。
 * 上传报错即终局(真机实测 error 常驻、loading 消失),不等满 timeout。
 */
export async function injectAttachments(
  deps: AttachmentProtocolDeps,
  attachments: GeminiAttachmentInput[],
): Promise<void> {
  // 内部 invariant:张数只可能来自 I1 已复核的 payload,越界即程序错误,不在此重做业务限额
  if (attachments.length < 1 || attachments.length > ATTACHMENT_MAX_COUNT) {
    throw attachmentFailed(`unexpected attachment count ${attachments.length}`);
  }
  const state = await readState(deps);
  if (state.imageInputCount !== 1) {
    throw attachmentFailed(`expected exactly 1 image input before inject, found ${state.imageInputCount}`);
  }
  const files: BrowserUploadFile[] = attachments.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    buffer: file.buffer,
  }));
  try {
    // 一次传完整数组(目标 input 是 multiple;绝不逐图开合面板)
    await deps.page.setInputFiles(GEMINI_ATTACHMENT_SELECTORS.imageInput, files);
  } catch (err) {
    // 关闭族异常仍由 Scheduler 的 isContextClosedError 沿 cause 链识别(§30:
    // 页面关闭/Context 关闭/崩溃优先映射浏览器错误,不被附件错误覆盖)
    throw attachmentFailed("setInputFiles failed", err);
  }
  await waitAttachmentReady(deps, attachments.length);
}

/**
 * §14:就绪 = 计数精确等于 expectedCount ∧ 无 loading ∧ 无 error。
 * 4 图只出现 3 个不得因为「状态稳定」就发送。
 */
export async function waitAttachmentReady(
  deps: AttachmentProtocolDeps,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + deps.options.readyTimeoutMs;
  for (;;) {
    const state = await readState(deps);
    if (state.hasError) {
      // 真机实测:0 字节图 error 图标出现后常驻 ⇒ 立即失败,不白等满 20s
      throw attachmentFailed("attachment upload reported an error");
    }
    if (
      state.attachmentCount === expectedCount &&
      !state.uploading &&
      !state.hasError
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw attachmentTimeout(deps.options.readyTimeoutMs, expectedCount);
    }
    await sleep(deps.options.pollIntervalMs);
  }
}

/**
 * §18:Enter 前断言 —— 此刻附件数**本来就该等于** expectedCount,
 * 不能再用「必须为 0」的 clean 判据(那会把本次自己的附件当残留)。
 */
export async function assertComposerExpectedBeforeSend(
  deps: AttachmentProtocolDeps,
  expectedCount: number,
): Promise<void> {
  const state = await readState(deps);
  if (state.hasError) {
    throw attachmentFailed("attachment upload reported an error before send");
  }
  if (state.uploading) {
    throw attachmentFailed("attachment upload still in progress before send");
  }
  if (state.attachmentCount !== expectedCount) {
    throw attachmentFailed(
      `composer has ${state.attachmentCount} attachment(s) before send, expected ${expectedCount}`,
    );
  }
}
