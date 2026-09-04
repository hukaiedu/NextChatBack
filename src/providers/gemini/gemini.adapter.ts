import type { Logger } from "../../common/logger/logger.js";
import type { BrowserManager } from "./browser-manager.js";
import type { BrowserPageHandle } from "./browser-driver.js";
import {
  browserCrashed,
  cancellationUnconfirmed,
  conversationUnavailable,
  domChanged,
  loginRequired,
  navigationFailed,
  pageClosed,
  responseTimeout,
} from "./gemini.errors.js";
import {
  extractConversationId,
  GEMINI_SELECTORS,
  isSameConversation,
  normalizeConversationUrl,
} from "./gemini.selectors.js";
import type {
  GeminiAdapter,
  GeminiAdapterOptions,
  GeminiPromptResult,
  GeminiPromptRunInput,
} from "./gemini.types.js";
import { isGeminiOriginUrl } from "./session-checker.js";

/** 节奏默认值:全部来自 2026-09-03 真实页面实测,只有 responseTimeoutMs 走 env */
const DEFAULTS = {
  composerReadyTimeoutMs: 15_000,
  sendAckTimeoutMs: 20_000,
  urlGraceMs: 3_000,
  historySettleTimeoutMs: 15_000,
  pollIntervalMs: 400,
  stableWindowMs: 1_500,
  stopConfirmTimeoutMs: 10_000,
} as const;

/**
 * fill 与 Enter 之间的间隔:Quill 需要一拍把 DOM 输入同步进 Angular 模型,
 * 实测无间隔时偶发 Enter 早于模型更新而丢字符。
 */
const FILL_SETTLE_MS = 300;

/**
 * 单个候选 selector 的点击预算:每次 click 用有限超时,候选间才可能轮换,
 * 否则第一个不可见候选会把整个确认窗口耗光。
 */
const STOP_CLICK_TIMEOUT_MS = 1_000;

export interface GeminiWebAdapterDeps {
  manager: BrowserManager;
  baseUrl: string;
  options: GeminiAdapterOptions;
  logger: Logger;
}

/** 一轮页面结构快照,用于判断「本轮新增了什么」而不是「页面上有多少」 */
interface TurnSnapshot {
  turns: number;
  shells: number;
  answers: number;
}

/**
 * Gemini 页面自动化适配器(prd 第 4 阶段)。
 *
 * 职责边界(§3.1):只管 URL / DOM / Selector / 输入 / 回答读取。
 * 不做:登录检测(交给 BrowserManager 状态机)、数据库写入(URL 通过
 * onConversationUrl 钩子交给服务层)、Request 状态流转与重试(§第 5 阶段;
 * 本适配器任何失败都直接抛出,绝不自动重试 —— 原则 30)。
 */
export class GeminiWebAdapter implements GeminiAdapter {
  private readonly opts: Required<GeminiAdapterOptions>;

  constructor(private readonly deps: GeminiWebAdapterDeps) {
    this.opts = {
      responseTimeoutMs: deps.options.responseTimeoutMs,
      composerReadyTimeoutMs:
        deps.options.composerReadyTimeoutMs ?? DEFAULTS.composerReadyTimeoutMs,
      sendAckTimeoutMs: deps.options.sendAckTimeoutMs ?? DEFAULTS.sendAckTimeoutMs,
      urlGraceMs: deps.options.urlGraceMs ?? DEFAULTS.urlGraceMs,
      historySettleTimeoutMs:
        deps.options.historySettleTimeoutMs ?? DEFAULTS.historySettleTimeoutMs,
      pollIntervalMs: deps.options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      stableWindowMs: deps.options.stableWindowMs ?? DEFAULTS.stableWindowMs,
      stopConfirmTimeoutMs:
        deps.options.stopConfirmTimeoutMs ?? DEFAULTS.stopConfirmTimeoutMs,
    };
  }

  async openConversation(existingUrl: string | null): Promise<void> {
    const page = this.deps.manager.requireGeminiPage();
    const target = existingUrl ?? this.deps.baseUrl;
    try {
      await page.goto(target);
    } catch (err) {
      throw navigationFailed(err);
    }
    if (!existingUrl) {
      // 新会话首页:/app 本身就是待输入状态,无需校验会话身份
      return;
    }

    // 已删除/失效的会话不会报 HTTP 404,而是被前端路由踢回 /app,所以必须等重定向稳定
    await sleep(this.opts.urlGraceMs);
    const landed = page.url();
    if (!isGeminiOriginUrl(landed, this.deps.baseUrl)) {
      throw loginRequired();
    }
    if (extractConversationId(landed) === null || !isSameConversation(landed, existingUrl)) {
      throw conversationUnavailable();
    }
    await this.waitForHistorySettled(page);
  }

  async runPrompt(input: GeminiPromptRunInput): Promise<GeminiPromptResult> {
    const page = this.deps.manager.requireGeminiPage();
    const startedAt = Date.now();

    // 三段各自计时:页面就绪慢不能报成「模型响应超时」,反之亦然(§12.13 两个码语义不同)
    await this.waitForComposer(page, Date.now() + this.opts.composerReadyTimeoutMs);
    const baseline = await this.snapshot(page);

    try {
      await page.fill(GEMINI_SELECTORS.quillComposer, input.prompt);
    } catch (err) {
      this.assertNotLoggedOut(page);
      throw domChanged("composer is not editable", err);
    }
    await sleep(FILL_SETTLE_MS);
    await page.press(GEMINI_SELECTORS.quillComposer, "Enter");

    await this.waitForSendAck(page, baseline, Date.now() + this.opts.sendAckTimeoutMs);
    return this.waitForAnswer(
      page,
      input,
      baseline,
      startedAt,
      Date.now() + this.opts.responseTimeoutMs,
    );
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private get logger(): Logger {
    return this.deps.logger;
  }

  /**
   * 复用会话时等历史轮次渲染完成:轮次总数连续 stableWindowMs 不变即认为水合结束。
   * 未水合就发送,Gemini 客户端会在缺少上文的情况下提交 Prompt(实测模型答「你没说过任何暗号」),
   * 且 runPrompt 的轮次基线也会算错,把恢复出来的旧回答当成本轮新回答。
   */
  private async waitForHistorySettled(page: BrowserPageHandle): Promise<void> {
    const limit = Date.now() + this.opts.historySettleTimeoutMs;
    let lastTotal = -1;
    let changedAt = Date.now();
    while (Date.now() < limit) {
      const snap = await this.snapshot(page);
      const total = snap.turns + snap.shells + snap.answers;
      if (total !== lastTotal) {
        lastTotal = total;
        changedAt = Date.now();
      } else if (Date.now() - changedAt >= this.opts.stableWindowMs) {
        return;
      }
      await sleep(this.opts.pollIntervalMs);
    }
    this.assertNotLoggedOut(page);
    throw domChanged("conversation history did not settle");
  }

  /** 等输入框从临时 textarea 升级为可交互 Quill 编辑器(实测约 3s) */
  private async waitForComposer(page: BrowserPageHandle, deadline: number): Promise<void> {
    const limit = Math.min(Date.now() + this.opts.composerReadyTimeoutMs, deadline);
    while (Date.now() < limit) {
      if (await this.hasComposer(page)) {
        return;
      }
      await sleep(this.opts.pollIntervalMs);
    }
    this.assertNotLoggedOut(page);
    throw domChanged("composer is missing");
  }

  /** 发送成功的判据是「本轮新气泡或新轮次外壳出现」,而非输入框被清空 */
  private async waitForSendAck(
    page: BrowserPageHandle,
    baseline: TurnSnapshot,
    deadline: number,
  ): Promise<void> {
    const limit = Math.min(Date.now() + this.opts.sendAckTimeoutMs, deadline);
    while (Date.now() < limit) {
      const current = await this.snapshot(page);
      if (current.turns > baseline.turns || current.shells > baseline.shells) {
        return;
      }
      await sleep(this.opts.pollIntervalMs);
    }
    this.assertNotLoggedOut(page);
    throw domChanged("prompt was not accepted by the page");
  }

  /**
   * 等回答结束。会话 URL 与回答文本在同一轮询里读:实测 URL 要等模型开始
   * 响应才出现(可达 30s),拆成「先等 URL 再等回答」两段必然误判。
   */
  private async waitForAnswer(
    page: BrowserPageHandle,
    input: GeminiPromptRunInput,
    baseline: TurnSnapshot,
    startedAt: number,
    deadline: number,
  ): Promise<GeminiPromptResult> {
    let reportedId: string | null = null;
    let conversationUrl: string | null = null;
    let urlDetectedElapsedMs: number | null = null;
    let lastText: string | null = null;
    let textChangedAt = Date.now();

    while (Date.now() < deadline) {
      // 取消信号:用户取消或 watchdog 超时都走同一条 stopGeneration 路径
      if (input.signal?.aborted) {
        return this.stopGeneration(page, lastText, baseline, startedAt);
      }

      // 崩溃检测:renderer crash 后 page.isClosed() 仍可能为 false,
      // countElements/lastInnerText 吞异常返回 0/null → 不检查就会盲等到 responseTimeoutMs
      if (page.isCrashed()) {
        throw browserCrashed("renderer-crash");
      }
      if (page.isClosed()) {
        throw pageClosed();
      }

      const url = normalizeConversationUrl(page.url());
      const conversationId = url ? extractConversationId(url) : null;
      if (url && conversationId && conversationId !== reportedId) {
        // await:URL 一确定就必须落库成功,否则不允许继续假装会话映射成立(§6.3)
        await input.onConversationUrl(url);
        reportedId = conversationId;
        conversationUrl = url;
        urlDetectedElapsedMs = Date.now() - startedAt;
        this.logger.info(
          { urlDetectedElapsedMs, promptLength: input.prompt.length },
          "gemini conversation url detected",
        );
      }

      const current = await this.snapshot(page);
      // 本轮回答元素一出现就开始读文本:生成中的文本就是流式来源(第 6 阶段)
      if (current.answers > baseline.answers) {
        const text = await page.lastInnerText(GEMINI_SELECTORS.answerText);
        if (text !== null && text !== lastText) {
          lastText = text;
          textChangedAt = Date.now();
          if (input.onText) {
            // await:业务层落库/推送失败必须让整次执行失败,不允许悄悄丢内容
            await input.onText(text);
          }
        }
        const done = current.shells === current.answers;
        if (
          done &&
          lastText !== null &&
          lastText.trim().length > 0 &&
          Date.now() - textChangedAt >= this.opts.stableWindowMs
        ) {
          if (!conversationUrl) {
            throw domChanged("conversation url did not appear");
          }
          return {
            answer: lastText,
            conversationUrl,
            urlDetectedElapsedMs,
            answerElapsedMs: Date.now() - startedAt,
          };
        }
      }
      await sleep(this.opts.pollIntervalMs);
    }
    throw responseTimeout(this.opts.responseTimeoutMs);
  }

  /**
   * 点击 Gemini 停止按钮并确认生成真的停了(prd §11.3;第 9 阶段 §二多候选)。
   *
   * 「确认真正停止」= 三条同时成立:
   * 1. 所有候选 selector 的停止按钮计数为 0(Gemini 自己声明生成结束,最强信号)
   * 2. response-container 数 == model-response 数(复用现有结构判据)
   * 3. 正文连续 stableWindowMs 不变(防按钮先消失、模型还在吐尾巴)
   *
   * 进入时若停止按钮计数已为 0 → 页面本就没在生成 → 返回 cancelled:false 走 SUCCESS 路径
   * (§11.1「不能人为强制标为 CANCELLED」)。
   * 点击遍历候选一次,不重试整轮(原则 30);即使全部候选点击失败也不提前失败 ——
   * 以确认窗口内页面真实状态为准,窗口耗尽 → cancellationUnconfirmed()
   * (保持 FAILED + PROVIDER_CANCELLATION_UNCONFIRMED)。
   */
  private async stopGeneration(
    page: BrowserPageHandle,
    lastText: string | null,
    baseline: TurnSnapshot,
    startedAt: number,
  ): Promise<GeminiPromptResult> {
    const stopCount = await countStopButtons(page);
    if (stopCount === 0) {
      // 页面已经不在生成了(可能在 Reasoning 思考阶段还没出正文,或刚好自然结束)
      // 按 SUCCESS 路径返回,由 Scheduler 根据 Request 当前状态决定终态
      return {
        answer: lastText ?? "",
        conversationUrl: normalizeConversationUrl(page.url()) ?? "",
        urlDetectedElapsedMs: null,
        answerElapsedMs: Date.now() - startedAt,
        cancelled: false,
      };
    }

    const clicked = await clickStopButton(page);
    if (!clicked) {
      this.logger.warn(
        { selectors: GEMINI_SELECTORS.stopButtonSelectors },
        "gemini stop button: all selector candidates failed to click",
      );
    }

    // 等待三条确认同时成立
    const confirmDeadline = Date.now() + this.opts.stopConfirmTimeoutMs;
    let textStableSince = Date.now();
    let prevText = lastText;

    while (Date.now() < confirmDeadline) {
      if (page.isCrashed()) {
        throw browserCrashed("renderer-crash-during-cancel");
      }
      if (page.isClosed()) {
        throw pageClosed();
      }

      const stopStillPresent = (await countStopButtons(page)) > 0;
      const snap = await this.snapshot(page);
      const shellsEqual = snap.shells === snap.answers;

      const currentText = await page.lastInnerText(GEMINI_SELECTORS.answerText);
      if (currentText !== prevText) {
        prevText = currentText;
        textStableSince = Date.now();
      }
      const textStable = Date.now() - textStableSince >= this.opts.stableWindowMs;

      if (!stopStillPresent && shellsEqual && textStable) {
        const conversationUrl = normalizeConversationUrl(page.url()) ?? "";
        return {
          answer: prevText ?? "",
          conversationUrl,
          urlDetectedElapsedMs: null,
          answerElapsedMs: Date.now() - startedAt,
          cancelled: true,
        };
      }

      await sleep(this.opts.pollIntervalMs);
    }

    throw cancellationUnconfirmed();
  }

  /**
   * 确认 Gemini 页面当前没有正在进行的生成。
   * page 为 null/closed/crashed → true(不存在「仍在进行的生成」,交给 gate 惰性重建)。
   * countElements 吞异常返回 0 的特性在这里正好:崩溃页 → 0 === 0 → true。
   */
  async confirmIdle(): Promise<boolean> {
    const page = this.deps.manager.peekGeminiPage();
    if (!page || page.isClosed() || page.isCrashed()) {
      return true;
    }
    try {
      const snap = await this.snapshot(page);
      return snap.shells === snap.answers;
    } catch {
      return true;
    }
  }

  private async hasComposer(page: BrowserPageHandle): Promise<boolean> {
    return (await page.countElements(GEMINI_SELECTORS.quillComposer)) > 0;
  }

  private async snapshot(page: BrowserPageHandle): Promise<TurnSnapshot> {
    const [turns, shells, answers] = await Promise.all([
      page.countElements(GEMINI_SELECTORS.userTurn),
      page.countElements(GEMINI_SELECTORS.turnShell),
      page.countElements(GEMINI_SELECTORS.answer),
    ]);
    return { turns, shells, answers };
  }

  /** 失败原因消歧:页面已跳离 Gemini 域 = 登录失效,不能报成 DOM 变更 */
  private assertNotLoggedOut(page: BrowserPageHandle): void {
    if (!isGeminiOriginUrl(page.url(), this.deps.baseUrl)) {
      throw loginRequired();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 所有候选 selector 的停止按钮计数总和:任一候选命中即 >0 */
async function countStopButtons(page: BrowserPageHandle): Promise<number> {
  let total = 0;
  for (const selector of GEMINI_SELECTORS.stopButtonSelectors) {
    total += await page.countElements(selector);
  }
  return total;
}

/**
 * 遍历候选 selector 找可点元素(第 9 阶段 §二):
 * count > 0 才 click(Playwright click 自带可见性等待,隐藏元素会超时抛错),
 * 单次 click 限时 STOP_CLICK_TIMEOUT_MS,失败换下一个候选;全部失败返回 false。
 */
async function clickStopButton(page: BrowserPageHandle): Promise<boolean> {
  for (const selector of GEMINI_SELECTORS.stopButtonSelectors) {
    if ((await page.countElements(selector)) === 0) {
      continue;
    }
    try {
      await page.click(selector, { timeoutMs: STOP_CLICK_TIMEOUT_MS });
      return true;
    } catch {
      // 该候选不可点(隐藏/被遮挡/count 与 click 之间消失)→ 换下一个
    }
  }
  return false;
}
