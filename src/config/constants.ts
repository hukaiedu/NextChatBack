export const APP_NAME = "personchat-back";

/** 业务 Provider 标识 */
export const PROVIDER_GEMINI_WEB = "GEMINI_WEB";

/** HTTP 头名:请求链路 ID */
export const REQUEST_ID_HEADER = "x-request-id";

/** Health 检查路径 */
export const HEALTH_PATH = "/api/health";

// —— SEC-1 服务端鉴权(docs/SEC1_AUTH_DESIGN.md §3.3:成代码常量,不成 env)——

/** Session Cookie 名 */
export const AUTH_COOKIE_NAME = "personchat_session";

/** 登录限流:fixed window 内最大失败次数 */
export const AUTH_LOGIN_MAX_ATTEMPTS = 5;

/** 登录限流:fixed window 长度(10 分钟) */
export const AUTH_LOGIN_WINDOW_MS = 10 * 60 * 1000;
