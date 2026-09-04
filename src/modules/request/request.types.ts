export const REQUEST_STATUSES = [
  "PENDING",
  "PROCESSING",
  "CANCELLING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
] as const;
export type RequestStatusValue = (typeof REQUEST_STATUSES)[number];

/** 活动 Request:同 Conversation 最多一个(数据库 partial unique index 兜底) */
export const REQUEST_ACTIVE_STATUSES = ["PENDING", "PROCESSING", "CANCELLING"] as const;
export type RequestActiveStatus = (typeof REQUEST_ACTIVE_STATUSES)[number];

/**
 * 在飞 Request:Gemini 页面上可能仍在生成,因此可以走向任意终态。
 *
 * 第 8 阶段引入 Cancel 之后 complete/fail 不能再只认 PROCESSING —— prd §11.1 允许
 * CANCELLING → SUCCESS(Adapter 明确确认生成完成时,不能人为强制标为 CANCELLED)与
 * CANCELLING → FAILED。repository 的条件写与 service 的 requireInFlight 共用这一份定义。
 */
export const REQUEST_IN_FLIGHT_STATUSES = ["PROCESSING", "CANCELLING"] as const;
export type RequestInFlightStatus = (typeof REQUEST_IN_FLIGHT_STATUSES)[number];
