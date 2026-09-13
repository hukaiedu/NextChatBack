export const APP_NAME = "personchat-back";

/** 业务 Provider 标识 */
export const PROVIDER_GEMINI_WEB = "GEMINI_WEB";

/** HTTP 头名:请求链路 ID */
export const REQUEST_ID_HEADER = "x-request-id";

/** Health 检查路径 */
export const HEALTH_PATH = "/api/health";

// —— V1.2 图片附件契约(I1;设计见 docs/PERSONCHAT_V12_IMAGE_UPLOAD_I01_REVIEW_FIX.md §1/§3/§4)——

/** messages 集合路由:路由挂载与大 body limit 白名单共用同一真值 */
export const MESSAGES_COLLECTION_PATH = "/api/conversations/:conversationId/messages";

/**
 * 精确匹配 messages 集合 URL 的锚定正则(I0.1 §1.2)。
 *
 * 必须锚定且由 MESSAGES_COLLECTION_PATH 派生:改前缀只有一处要改;而用 Express 路径前缀
 * 挂载会把大额度泄漏给该前缀下的任意子路由与未来新增路由 —— I0.1 §1.1 方案 C 实测已证。
 */
export const MESSAGES_BODY_PATH: RegExp = new RegExp(
  `^${MESSAGES_COLLECTION_PATH.replace(":conversationId", "[^/]+")}$`,
);

/** 接受的图片 MIME(I0.1 §4.3);HEIC/AVIF/SVG/TIFF 在 V1 一律 415(SVG 另有 XSS 面) */
export const ATTACHMENT_MIME_WHITELIST = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_WHITELIST)[number];

/** 单次请求最多 4 张 */
export const ATTACHMENT_MAX_COUNT = 4;
/** 单图解码后 ≤ 5MB */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** 全部附件解码后 ≤ 10MB */
export const ATTACHMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
/** 文件名清洗后的长度上限 */
export const ATTACHMENT_NAME_MAX_LENGTH = 128;
/**
 * 单张 dataURL 字符数上限 = base64 膨胀(⌈bytes/3⌉×4)+ 前缀余量。
 * 先按字符数拒绝,免得为了判定超限而先解码一份必然超限的大 Buffer。
 */
export const ATTACHMENT_DATA_URL_MAX_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 64;
/**
 * messages 路由 body 上限(I0.1 §1.4 推导):4×5MB base64 膨胀 = 13,980,700B
 * + content 最坏 150KB + JSON 包裹余量 ≈ 14.19MB → 取 14MB,余量约 400KB。
 * 与上面的限额同源于这份算术,故写死成常量:能装下合法请求,且装不下越界请求。
 */
export const ATTACHMENT_BODY_LIMIT = "14mb";

/** 附件字节常驻内存的硬上限:超限入口拒绝(503),绝不淘汰已有条目(I0.1 §3.4) */
export const ATTACHMENT_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** 孤儿回收扫描周期:以数据库状态为唯一权威,不按年龄删 */
export const ATTACHMENT_ORPHAN_SWEEP_MS = 60_000;
/** RESERVED 宽限期:事务可能正在进行,期内永不回收 */
export const ATTACHMENT_RESERVED_GRACE_MS = 5 * 60_000;
/** sweep 里 findActiveByIds 的分块大小,防 SQLite 变量上限 */
export const ATTACHMENT_SWEEP_CHUNK_SIZE = 500;

// —— SEC-1 服务端鉴权(docs/SEC1_AUTH_DESIGN.md §3.3:成代码常量,不成 env)——

/** Session Cookie 名 */
export const AUTH_COOKIE_NAME = "personchat_session";

/** 登录限流:fixed window 内最大失败次数 */
export const AUTH_LOGIN_MAX_ATTEMPTS = 5;

/** 登录限流:fixed window 长度(10 分钟) */
export const AUTH_LOGIN_WINDOW_MS = 10 * 60 * 1000;

/** req.ip 取不到时的兜底限流键(只决定分组,绝不落日志/响应) */
export const UNKNOWN_RATE_LIMIT_KEY = "unknown";

// —— V1.3 P6 入口防刷与队列容量(docs:任务书 §11/§12;env 可覆盖,这里是唯一默认值来源)——

/** 匿名身份新建:同一 IP 每小时最多新建多少身份(Abuse-01 保护「建新身份」而非「使用身份」) */
export const ANONYMOUS_IP_LIMIT_PER_HOUR = 20;

/** 匿名身份新建:同一 IP 每 24 小时最多新建多少身份 */
export const ANONYMOUS_IP_LIMIT_PER_DAY = 100;

/** 匿名身份新建:小时窗口长度 */
export const ANONYMOUS_IP_HOUR_WINDOW_MS = 60 * 60 * 1000;

/** 匿名身份新建:天窗口长度 */
export const ANONYMOUS_IP_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 消息提交频率:单用户每分钟最多提交多少条(键 = req.auth.userId,ADMIN/COMPAT 同样受限) */
export const CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE = 30;

/** 消息提交频率窗口长度(1 分钟) */
export const CHAT_SUBMIT_RATE_WINDOW_MS = 60 * 1000;

/** 单用户 PENDING 上限(§33) */
export const USER_MAX_PENDING_REQUESTS = 5;

/**
 * 单用户在飞(PROCESSING/CANCELLING)上限(§57)。
 * 当前一进程 = 一 Gemini Page = 一 worker,因此 >1 不提高并行度,只是调度不变量与未来边界。
 */
export const USER_MAX_ACTIVE_REQUESTS = 1;

/** 全库 PENDING 上限(§34:服务容量,超限 503 而非用户违规) */
export const GLOBAL_MAX_PENDING_REQUESTS = 100;

/** quota 拒绝的 Retry-After 建议秒数(§33:1~5 秒之间取一个固定值并保持一致) */
export const QUEUE_FULL_RETRY_AFTER_SECONDS = 3;

// —— V1.3 多用户:哨兵 User 常量(值必须与 B1 migration 的 INSERT OR IGNORE 逐字一致)——

/** 固定 ADMIN User:共享密码登录后的唯一管理员身份 */
export const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001";

/** 固定 COMPAT User:仅 AUTH_ENABLED=false + loopback 的 test/dev 兼容身份(type=ANONYMOUS,非 ADMIN) */
export const COMPAT_USER_ID = "00000000-0000-0000-0000-000000000002";

/** 过期 Session 清理周期(ms,§19);定时器 unref,不阻止进程退出 */
export const AUTH_SESSION_SWEEP_INTERVAL_MS = 60_000;
