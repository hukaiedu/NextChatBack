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
