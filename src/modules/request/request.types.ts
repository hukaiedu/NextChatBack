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
