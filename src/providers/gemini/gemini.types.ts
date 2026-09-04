/** Gemini Adapter 可调时间参数;只有回答上限来自 env,其余为实测得出的固定节奏 */
export interface GeminiAdapterOptions {
  /** Prompt 被页面接受后,等最终回答稳定的上限(不含页面就绪等待) */
  responseTimeoutMs: number;
  /** 等页面渲染出可交互输入框的上限 */
  composerReadyTimeoutMs?: number;
  /** 等用户气泡出现(确认 Prompt 已被页面接受)的上限 */
  sendAckTimeoutMs?: number;
  /** 打开已有会话后,等重定向稳定下来的宽限期(实测无效会话会被踢回 /app) */
  urlGraceMs?: number;
  /** 复用会话时,等历史轮次渲染完成(轮次计数停止变化)的上限 */
  historySettleTimeoutMs?: number;
  /** 轮询间隔 */
  pollIntervalMs?: number;
  /** 回答文本连续不变多久算生成结束 */
  stableWindowMs?: number;
  /** 点击停止按钮后等「三条件确认」的上限(生产默认 10s;单测压毫秒级) */
  stopConfirmTimeoutMs?: number;
}

/** 一次 Prompt 执行的输入 */
export interface GeminiPromptRunInput {
  /** 要发送的 Prompt(已 trim 非空) */
  prompt: string;
  /** 本地已保存的 Provider Conversation URL;null 表示本次要开新会话 */
  existingUrl: string | null;
  /**
   * 检测到 Provider Conversation URL 时被 await(prd §6.3:URL 一旦确定必须立即持久化)。
   * 钩子内抛错 → 整次执行失败,且不再读取回答。
   */
  onConversationUrl: (conversationUrl: string) => Promise<void>;
  /**
   * 流式读取钩子(第 6 阶段):本轮回答文本每次变化时被 await,参数是**当前完整文本**
   * 而非增量 —— 增量由业务层按消费端前缀推导,Adapter 不理解 delta/snapshot。
   * 省略则退化为「只等最终回答」(第 4/5 阶段行为)。抛错 → 整次执行失败,与 URL 钩子同构。
   */
  onText?: (text: string) => Promise<void>;
  /**
   * 取消信号(第 8 阶段):被 abort 时 Adapter 调用 stopGeneration 尝试让 Gemini 停止生成。
   * 未提供则不支持取消(向后兼容既有测试 Fake)。
   */
  signal?: AbortSignal;
}

/** 一次 Prompt 执行的结果 */
export interface GeminiPromptResult {
  /** 末条回答的渲染文本 */
  answer: string;
  /** 本次执行的会话 URL(规范化后);URL 从未出现时适配器直接失败,不会走到成功返回 */
  conversationUrl: string;
  /**
   * 本次执行首次观察到会话 id 的耗时。复用已存会话时同样会触发一次
   * (落库钩子幂等,重报一次可自愈上一次写入失败);执行中 id 变化会再次触发。
   */
  urlDetectedElapsedMs: number | null;
  /** 从执行开始到回答稳定的耗时 */
  answerElapsedMs: number;
  /** true = 通过 stopGeneration 确认 Gemini 已停止生成(§11.3) */
  cancelled?: boolean;
}

/**
 * Gemini 页面自动化契约(prd §3.1:URL / DOM / Selector / 输入 / 回答读取)。
 * 抽成接口是为了 Scheduler 与服务层能注入 Fake 做无浏览器测试。
 */
export interface GeminiAdapter {
  /**
   * 打开会话:existingUrl 为 null → 新会话首页;非 null → 打开该 URL 并校验仍然有效。
   * 已保存会话失效时抛 PROVIDER_CONVERSATION_UNAVAILABLE,禁止自动新建(prd §6.4)。
   */
  openConversation(existingUrl: string | null): Promise<void>;
  /** 发送 Prompt,检测到会话 URL 时 await 落库钩子;提供 onText 则边生成边回调,最后等回答稳定返回文本 */
  runPrompt(input: GeminiPromptRunInput): Promise<GeminiPromptResult>;
  /**
   * 确认 Gemini 页面当前没有正在进行的生成(§三:槽位释放以「页面真的静默了」为准)。
   * page 为 null/closed 返回 true(页面已没了就不存在「仍在进行的生成」)。
   */
  confirmIdle(): Promise<boolean>;
}
