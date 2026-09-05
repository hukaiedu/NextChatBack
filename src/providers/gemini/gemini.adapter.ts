import type { Logger } from "../../common/logger/logger.js";
import type { AppError } from "../../common/errors/app-error.js";
import type { BrowserManager } from "./browser-manager.js";
import type { BrowserElementSnapshot, BrowserPageHandle } from "./browser-driver.js";
import {
  browserCrashed,
  cancellationUnconfirmed,
  conversationUnavailable,
  domChanged,
  isContextClosedError,
  loginRequired,
  modelSwitchFailed,
  modelUnavailable,
  navigationFailed,
  pageClosed,
  responseTimeout,
} from "./gemini.errors.js";
import {
  extractConversationId,
  GEMINI_MODEL_SELECTORS,
  GEMINI_SELECTORS,
  isSameConversation,
  normalizeConversationUrl,
} from "./gemini.selectors.js";
import type {
  GeminiAdapter,
  GeminiAdapterOptions,
  GeminiModelCatalog,
  GeminiModelOption,
  GeminiPromptResult,
  GeminiPromptRunInput,
  ResolvedGeminiModel,
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
  modelMenuTimeoutMs: 5_000,
  // FIX-06:trigger 点击重试总预算 = 单次点击 5s + 菜单等待 5s 的既有最坏包络
  modelTriggerBudgetMs: 10_000,
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

/**
 * 模型菜单内单次点击(trigger 开合、选项)的预算:与停止按钮同理,候选/重试的
 * 轮换与验证逻辑需要每次点击有界,菜单状态等待由 modelMenuTimeoutMs 单独覆盖。
 */
/** 真机实测:刚导航完 Angular 头部仍在水合,1s 内 trigger 常不可点(M0 采样同款 5s 先例) */
const MODEL_CLICK_TIMEOUT_MS = 5_000;

/** §十一:模型菜单项一次 readAll 请求的属性集(机器 key / class / 禁用判据) */
const MODEL_OPTION_ATTRS = ["data-mode-id", "class", "aria-disabled", "disabled"] as const;

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
      modelMenuTimeoutMs:
        deps.options.modelMenuTimeoutMs ?? DEFAULTS.modelMenuTimeoutMs,
      modelTriggerBudgetMs:
        deps.options.modelTriggerBudgetMs ?? DEFAULTS.modelTriggerBudgetMs,
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

      // 崩溃检测:renderer crash 后 page.isClosed() 仍可能为 false → 不检查就会
      // 盲等到 responseTimeoutMs(关闭族异常由 snapshot 上抛,走 Scheduler §8.8 收敛)
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
   * snapshot 抛错(含崩溃页的关闭族异常)被下方 catch 兜住 → true。
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

  /**
   * 读取模型目录(M2 §八~§十七):先查菜单是否已打开(不假设关闭),必要时点 trigger
   * 打开;一次 readAll 后按 class token 解析;退出前统一恢复页面(菜单不可见)。
   *
   * 结构性异常(菜单打不开 / 缺 data-mode-id / 重复 key / 无有效 label / 多个 selected)
   * → PROVIDER_DOM_CHANGED —— 尚未发生切换,绝不报 MODEL_SWITCH_FAILED。
   * 关闭失败:主逻辑已有异常时只记日志不覆盖;主逻辑成功时按 DOM_CHANGED 处理,
   * 不允许静默留下打开的菜单(§十)。
   */
  async listModels(): Promise<GeminiModelCatalog> {
    const page = this.deps.manager.requireGeminiPage();
    await this.openModelMenu(page);

    let outcome: { catalog: GeminiModelCatalog } | { error: unknown };
    try {
      outcome = { catalog: await this.readModelCatalog(page) };
    } catch (err) {
      outcome = { error: err };
    }

    let closeFailed = false;
    try {
      closeFailed = !(await this.closeModelMenu(page));
    } catch (closeErr) {
      if (!("error" in outcome)) {
        // 页面 crash/closed 是真实故障,原样上抛
        throw closeErr;
      }
      this.logger.warn(
        { err: closeErr },
        "gemini model menu close failed while handling a primary error",
      );
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    if (closeFailed) {
      this.assertNotLoggedOut(page);
      throw domChanged("model menu did not close");
    }
    return outcome.catalog;
  }

  /**
   * 确保页面选中目标模型并返回确认结果(M2 §十八~§二十三)。
   *
   * 与 runPrompt 的关键差异:这里全程不导航、不读会话 URL(M0 实测切换不改变 URL);
   * 切换后绝不能因「click 没抛错」就认为成功,必须重开菜单重读 selected 确认。
   * abort 检查点:进入 / 打开菜单前 / 点击前 / 点击后 / 重新验证前(§二十三)。
   */
  async ensureModel(requestedModelKey: string, signal?: AbortSignal): Promise<ResolvedGeminiModel> {
    // 检查点 1:进入时。abort 后一个 DOM 操作都不做
    signal?.throwIfAborted();
    const page = this.deps.manager.requireGeminiPage();

    // 检查点 2:打开菜单前
    signal?.throwIfAborted();
    await this.openModelMenu(page);

    const catalog = await this.readModelCatalog(page);
    const targetIndex = catalog.models.findIndex((model) => model.key === requestedModelKey);
    const target = targetIndex === -1 ? undefined : catalog.models[targetIndex];
    if (target === undefined || target.disabled) {
      // 目标不存在 / 明确禁用:不可达目标,不是切换失败(§二十二)
      await this.closeModelMenuQuietly(page);
      throw modelUnavailable(requestedModelKey);
    }

    if (target.selected) {
      // 已是目标模型:不点击,恢复页面后直接返回
      const closed = await this.closeModelMenu(page);
      if (!closed) {
        this.assertNotLoggedOut(page);
        throw domChanged("model menu did not close");
      }
      return { key: target.key, label: target.label };
    }

    // 检查点 3:点击目标前
    signal?.throwIfAborted();
    try {
      await page.clickNth(GEMINI_MODEL_SELECTORS.modeOption, targetIndex, {
        timeoutMs: MODEL_CLICK_TIMEOUT_MS,
      });
    } catch (err) {
      // 页面故障(含断连竞态,FIX-05)保持自身语义,绝不包装成 MODEL_SWITCH_FAILED(§二十四)
      const lifecycle = this.lifecycleError(page, err);
      if (lifecycle) {
        throw lifecycle;
      }
      this.assertNotLoggedOut(page);
      throw modelSwitchFailed("target model option click failed", err);
    }

    // 检查点 4:点击后。abort 则不再做任何 DOM 操作(包括等菜单关闭与关闭菜单)
    signal?.throwIfAborted();
    // M0:点击选项后菜单自动关闭;关不掉说明点击未被页面接受,无法确认切换
    const hidden = await this.waitForModelMenuHidden(page, Date.now() + this.opts.modelMenuTimeoutMs);
    if (!hidden) {
      await this.closeModelMenuQuietly(page);
      throw modelSwitchFailed("model menu did not close after clicking the target option");
    }

    // 检查点 5:重新验证前(§二十:重开菜单 → 重读 → selected 必须唯一且等于目标)
    signal?.throwIfAborted();
    await this.openModelMenu(page);
    const verified = await this.readModelCatalog(page);
    const selected = verified.models.find((model) => model.selected);
    if (selected === undefined || selected.key !== requestedModelKey) {
      await this.closeModelMenuQuietly(page);
      throw modelSwitchFailed(
        `selected model after switch is ${selected?.key ?? "none"}, expected ${requestedModelKey}`,
      );
    }
    const resolvedLabel = selected.label;

    const closed = await this.closeModelMenu(page);
    if (!closed) {
      this.assertNotLoggedOut(page);
      throw domChanged("model menu did not close");
    }
    return { key: requestedModelKey, label: resolvedLabel };
  }

  // ---------------------------------------------------------------------------
  // 模型菜单内部实现(M2)
  // ---------------------------------------------------------------------------

  /**
   * FIX-05:页面生命周期错误消歧的唯一入口。页面已关闭 / 已 crash / 错误本身是
   * 关闭族文案(如 "browser has disconnected")但页面状态尚未落地的断连竞态,
   * 统一收敛为 PAGE_CLOSED / BROWSER_CRASHED;未命中返回 null,调用方走原语义
   * (登录失效消歧、DOM_CHANGED / MODEL_SWITCH_FAILED 等)。
   * 断连竞态归 BROWSER_CRASHED 的依据:error-codes.ts「一进程 = 一 context」,
   * browser/context 级死亡都是 BROWSER_CRASHED,页面单独关闭由 isClosed 先行捕获。
   */
  private lifecycleError(page: BrowserPageHandle, err: unknown): AppError | null {
    if (page.isClosed()) {
      return pageClosed();
    }
    if (page.isCrashed()) {
      return browserCrashed("renderer-crash-during-model-menu");
    }
    if (isContextClosedError(err)) {
      return browserCrashed("browser-disconnected-during-model-catalog", err);
    }
    return null;
  }

  /**
   * FIX-05:模型菜单路径上的 countElements 统一包装 —— driver 会把关闭族异常
   * 原样上抛(不再降级 0),在此收敛为生命周期错误码,否则断连会被轮询等成
   * "model menu contains no model options" 之类的 DOM_CHANGED。
   */
  private async countMenuElements(page: BrowserPageHandle, selector: string): Promise<number> {
    try {
      return await page.countElements(selector);
    } catch (err) {
      const lifecycle = this.lifecycleError(page, err);
      if (lifecycle) {
        throw lifecycle;
      }
      throw err;
    }
  }

  /**
   * 一次 readAll(modeOption) + 解析(FIX-01/FIX-04):读取/解析阶段的页面故障在此
   * 消歧,消歧规则统一走 lifecycleError(§九)。
   */
  private async readModelCatalog(page: BrowserPageHandle): Promise<GeminiModelCatalog> {
    try {
      return parseModelCatalog(
        await page.readAll(GEMINI_MODEL_SELECTORS.modeOption, { attrs: [...MODEL_OPTION_ATTRS] }),
      );
    } catch (err) {
      const lifecycle = this.lifecycleError(page, err);
      if (lifecycle) {
        throw lifecycle;
      }
      throw err;
    }
  }

  /**
   * 确保模型菜单可见且选项已渲染(§九 + FIX-02):已打开直接用;否则点 trigger 并在
   * 有限窗口内等它出现。菜单容器(data-visible)先于 gem-menu-item 渲染,而
   * locator.all() 不等待,因此可见后还要等至少一个 modeOption 出现,随后的
   * readAll(modeOption) 才保证只执行一次且非空。
   */
  private async openModelMenu(page: BrowserPageHandle): Promise<void> {
    if (page.isCrashed()) {
      throw browserCrashed("renderer-crash-during-model-menu");
    }
    if (page.isClosed()) {
      throw pageClosed();
    }
    if ((await this.countMenuElements(page, GEMINI_MODEL_SELECTORS.modeMenu)) === 0) {
      await this.clickTriggerUntilMenuVisible(page);
    }
    // FIX-02:容器可见 ≠ 选项渲染完成。等至少一个选项出现;期间页面关闭/崩溃
    // 保持自身错误码,登录失效在超时出口消歧;始终无选项 → DOM_CHANGED
    const optionDeadline = Date.now() + this.opts.modelMenuTimeoutMs;
    while (true) {
      if (page.isCrashed()) {
        throw browserCrashed("renderer-crash-during-model-menu");
      }
      if (page.isClosed()) {
        throw pageClosed();
      }
      if ((await this.countMenuElements(page, GEMINI_MODEL_SELECTORS.modeOption)) > 0) {
        return;
      }
      if (Date.now() >= optionDeadline) {
        break;
      }
      await sleep(this.opts.pollIntervalMs);
    }
    this.assertNotLoggedOut(page);
    throw domChanged("model menu contains no model options");
  }

  /**
   * FIX-06:冷启动下 Gemini 首页元素已可见但 Angular 交互绑定尚未就绪,首次
   * trigger 点击可能以 Playwright click timeout 失败(REAL-M3 无预热验收实测,
   * 约 1/5 冷启动命中)。一次瞬时失败不能证明 DOM 已变:在 modelTriggerBudgetMs
   * 总预算内短间隔重试,每轮 click 与菜单出现等待的超时都被剩余预算封顶,最坏
   * 等待不超过预算本身(不扩大 M2 单次路径 5s+5s 的包络)。
   * 生命周期错误(PAGE_CLOSED / BROWSER_CRASHED,含断连竞态)与登录失效
   * (LOGIN_REQUIRED)绝不重试,立即上抛;预算耗尽仍打不开 → DOM_CHANGED。
   */
  private async clickTriggerUntilMenuVisible(page: BrowserPageHandle): Promise<void> {
    const deadline = Date.now() + this.opts.modelTriggerBudgetMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        await page.click(GEMINI_MODEL_SELECTORS.modeTrigger, {
          timeoutMs: Math.min(MODEL_CLICK_TIMEOUT_MS, remaining),
        });
      } catch (err) {
        // 点击失败先消歧:页面故障(含断连竞态)与登录失效绝不重试(§六)
        lastErr = err;
        const lifecycle = this.lifecycleError(page, err);
        if (lifecycle) {
          throw lifecycle;
        }
        this.assertNotLoggedOut(page);
        this.logger.warn(
          { err, remainingMs: remaining },
          "gemini model trigger click failed, retrying within budget",
        );
        await sleep(this.opts.pollIntervalMs);
        continue;
      }
      // 点击被页面接受 → 等菜单出现;等待窗口仍是 modelMenuTimeoutMs,但被
      // 同一 deadline 封顶(remaining 不足时提前失败,不把最坏等待叠乘)
      const menuDeadline = Math.min(Date.now() + this.opts.modelMenuTimeoutMs, deadline);
      let visible = false;
      while (Date.now() < menuDeadline) {
        if (page.isCrashed()) {
          throw browserCrashed("renderer-crash-during-model-menu");
        }
        if (page.isClosed()) {
          throw pageClosed();
        }
        if ((await this.countMenuElements(page, GEMINI_MODEL_SELECTORS.modeMenu)) > 0) {
          visible = true;
          break;
        }
        await sleep(this.opts.pollIntervalMs);
      }
      if (visible) {
        return;
      }
      // 点击成功但菜单始终未出现:重试点击有误二次开合的风险,按 DOM 变更处理
      this.assertNotLoggedOut(page);
      throw domChanged("model menu did not open");
    }
    this.assertNotLoggedOut(page);
    throw domChanged("model menu trigger is not clickable", lastErr);
  }

  /** 关闭模型菜单(再点 trigger,§十)并确认不可见;返回 false = 窗口内无法确认关闭 */
  private async closeModelMenu(page: BrowserPageHandle): Promise<boolean> {
    if (page.isCrashed()) {
      throw browserCrashed("renderer-crash-during-model-menu");
    }
    if (page.isClosed()) {
      throw pageClosed();
    }
    if ((await this.countMenuElements(page, GEMINI_MODEL_SELECTORS.modeMenu)) === 0) {
      return true;
    }
    try {
      await page.click(GEMINI_MODEL_SELECTORS.modeTrigger, { timeoutMs: MODEL_CLICK_TIMEOUT_MS });
    } catch (err) {
      // 关闭路径中的页面故障(含断连竞态,FIX-05)是真实故障,上抛收敛为错误码,
      // 不得静默降级成 "menu did not close" 的 DOM_CHANGED;普通点击失败仍走 false
      const lifecycle = this.lifecycleError(page, err);
      if (lifecycle) {
        throw lifecycle;
      }
      this.logger.warn({ err }, "gemini model menu trigger click failed while closing");
      return false;
    }
    return this.waitForModelMenuHidden(page, Date.now() + this.opts.modelMenuTimeoutMs);
  }

  /** 失败路径上的收尾:尽力恢复页面(菜单不可见),绝不覆盖主错误 */
  private async closeModelMenuQuietly(page: BrowserPageHandle): Promise<void> {
    try {
      const closed = await this.closeModelMenu(page);
      if (!closed) {
        this.logger.warn("gemini model menu did not close while recovering from an error");
      }
    } catch (err) {
      this.logger.warn({ err }, "gemini model menu close failed while recovering from an error");
    }
  }

  private async waitForModelMenuHidden(
    page: BrowserPageHandle,
    deadline: number,
  ): Promise<boolean> {
    while (Date.now() < deadline) {
      if (page.isCrashed()) {
        throw browserCrashed("renderer-crash-during-model-menu");
      }
      if (page.isClosed()) {
        throw pageClosed();
      }
      if ((await this.countMenuElements(page, GEMINI_MODEL_SELECTORS.modeMenu)) === 0) {
        return true;
      }
      await sleep(this.opts.pollIntervalMs);
    }
    return false;
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

/**
 * §十三:innerText 的首个非空行。菜单项实际是「标题行 + 描述行」(如
 * "3.1 Pro\nRaciocínio avançado"),label 只取标题,绝不把描述拼进去。
 */
function firstNonEmptyLine(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return null;
}

/**
 * §十一~§十六:把菜单项快照解析成 catalog。
 * 任何结构性异常(空菜单 / 缺 data-mode-id / 重复 key / 无有效 label / 多个 selected)
 * 都抛 PROVIDER_DOM_CHANGED,禁止猜测补全;selected 以 class token 判定,
 * data-active / tabindex / aria-label 一概不参与(§十四)。
 */
function parseModelCatalog(snapshots: BrowserElementSnapshot[]): GeminiModelCatalog {
  if (snapshots.length === 0) {
    throw domChanged("model menu has no options");
  }
  const models: GeminiModelOption[] = [];
  const seenKeys = new Set<string>();
  let selectedKey: string | null = null;
  let selectedCount = 0;
  for (const snap of snapshots) {
    const key = (snap.attrs["data-mode-id"] ?? "").trim();
    if (key.length === 0) {
      throw domChanged("model option has no data-mode-id");
    }
    if (seenKeys.has(key)) {
      throw domChanged("duplicate data-mode-id in model menu");
    }
    seenKeys.add(key);
    const label = firstNonEmptyLine(snap.text);
    if (label === null) {
      throw domChanged("model option has no readable label");
    }
    const classTokens = (snap.attrs["class"] ?? "").split(/\s+/).filter(Boolean);
    const selected = classTokens.includes("selected");
    if (selected) {
      selectedCount += 1;
      selectedKey = key;
    }
    models.push({
      key,
      label,
      selected,
      // §十五:aria-disabled="true" / disabled 属性存在 / class 含 disabled token;
      // aria-disabled="false" 不算禁用
      disabled:
        snap.attrs["aria-disabled"] === "true" ||
        snap.attrs["disabled"] != null ||
        classTokens.includes("disabled"),
    });
  }
  if (selectedCount > 1) {
    throw domChanged("multiple selected model options");
  }
  return { models, currentModelKey: selectedKey };
}
