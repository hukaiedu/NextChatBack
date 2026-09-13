import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { ErrorCode } from "../../src/common/errors/error-codes.js";
import { PublicErrorCodes, toPublicError } from "../../src/common/errors/public-error.js";

/**
 * V1.3-B3-2 §12..§17:Public 错误映射表。
 *
 * 这里的分区是**独立写出的第二份事实**(不是从生产实现里读回来的),
 * 目的正是让「新增一个内部错误码但忘了归类」在测试里红掉。
 */
const PASSTHROUGH: readonly string[] = [
  ErrorCodes.VALIDATION_ERROR,
  ErrorCodes.PAYLOAD_TOO_LARGE,
  ErrorCodes.CONVERSATION_NOT_FOUND,
  ErrorCodes.CONVERSATION_DELETED,
  ErrorCodes.CONVERSATION_ARCHIVED,
  ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
  ErrorCodes.REQUEST_NOT_FOUND,
  ErrorCodes.REQUEST_NOT_CANCELLABLE,
  ErrorCodes.IDEMPOTENCY_KEY_REUSED,
  ErrorCodes.ATTACHMENT_TOO_LARGE,
  ErrorCodes.UNSUPPORTED_ATTACHMENT_TYPE,
  ErrorCodes.AUTH_REQUIRED,
  ErrorCodes.AUTH_INVALID_CREDENTIALS,
  ErrorCodes.AUTH_RATE_LIMITED,
  ErrorCodes.AUTH_CSRF_REJECTED,
  ErrorCodes.AUTH_FORBIDDEN,
  // V1.4 U2:注册/账号面板需要逐字分支的三项业务码(design §15),一律 Public 透传
  ErrorCodes.AUTH_USERNAME_ALREADY_TAKEN,
  ErrorCodes.AUTH_IDENTITY_NOT_ANONYMOUS,
  ErrorCodes.AUTH_USER_DISABLED,
];

const BUSY: readonly string[] = [
  ErrorCodes.PROVIDER_RATE_LIMITED,
  ErrorCodes.ATTACHMENT_CAPACITY_EXCEEDED,
  ErrorCodes.PROVIDER_NOT_READY,
  // V1.3 P6:提交频率超限与两级排队容量,对外一律「服务忙」
  ErrorCodes.CHAT_SUBMIT_RATE_LIMITED,
  ErrorCodes.USER_PENDING_LIMIT_REACHED,
  ErrorCodes.GLOBAL_QUEUE_FULL,
  // V1.3 P10 §49:限流器自身满容量,对外同样只折 SERVICE_BUSY
  ErrorCodes.RATE_LIMITER_CAPACITY_EXCEEDED,
];

const TIMEOUT: readonly string[] = [
  ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
  ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED,
  ErrorCodes.PROVIDER_ATTACHMENT_TIMEOUT,
  ErrorCodes.BROWSER_RESTART_TIMEOUT,
];

/** 其余全部内部实现错误 → CHAT_FAILED(§17) */
const FAILED: readonly string[] = [
  ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING,
  ErrorCodes.SERVER_RESTARTED_DURING_CANCELLING,
  ErrorCodes.STREAMING_UPDATE_FAILED,
  ErrorCodes.SSE_CONNECTION_ERROR,
  ErrorCodes.PROVIDER_LOGIN_REQUIRED,
  ErrorCodes.PROVIDER_PROFILE_IN_USE,
  ErrorCodes.PROVIDER_BROWSER_START_FAILED,
  ErrorCodes.PROVIDER_PAGE_CLOSED,
  ErrorCodes.PROVIDER_BROWSER_CRASHED,
  ErrorCodes.PROVIDER_NAVIGATION_FAILED,
  ErrorCodes.PROVIDER_DOM_CHANGED,
  ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
  ErrorCodes.PROVIDER_MODEL_UNAVAILABLE,
  ErrorCodes.PROVIDER_MODEL_SWITCH_FAILED,
  ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
  ErrorCodes.BROWSER_RESTART_CONFLICT,
  ErrorCodes.BROWSER_LAUNCH_FAILED,
  ErrorCodes.BROWSER_RESTART_FAILED,
  ErrorCodes.DATABASE_ERROR,
  ErrorCodes.INTERNAL_ERROR,
];

const GENERIC_MESSAGE: Record<string, string> = {
  CHAT_FAILED: "Chat request failed.",
  SERVICE_BUSY: "Service is busy. Please try again.",
  REQUEST_TIMEOUT: "Request timed out. Please try again.",
};

const ALL_CODES = Object.values(ErrorCodes) as ErrorCode[];

function expectedBucket(code: string): "passthrough" | "busy" | "timeout" | "failed" {
  if (PASSTHROUGH.includes(code)) return "passthrough";
  if (BUSY.includes(code)) return "busy";
  if (TIMEOUT.includes(code)) return "timeout";
  if (FAILED.includes(code)) return "failed";
  // 三个通用码本身就是对外码
  return "passthrough-generic";
}

describe("Public Error 映射分区完整性(§14:allowlist 必须来自仓库真实码枚举)", () => {
  it("ER-PART-01 真实 ErrorCode 全集必须被四个分区完整覆盖,且互不重叠", () => {
    const buckets = [PASSTHROUGH, BUSY, TIMEOUT, FAILED];
    const union = buckets.flat();
    for (const bucket of buckets) {
      expect(new Set(bucket).size).toBe(bucket.length);
    }
    expect(union.length).toBe(new Set(union).size);
    // 通用码不参与分区,其余每个真实码必须恰好归入一类
    const classified = union.filter((c) => !(c in PublicErrorCodes));
    const rest = ALL_CODES.filter((c) => !(c in PublicErrorCodes));
    expect(new Set(classified)).toEqual(new Set(rest));
  });

  it("ER-PART-02 每个内部码都映射到预期的通用码", () => {
    for (const code of ALL_CODES) {
      const bucket = expectedBucket(code);
      const mapped = toPublicError(code, `raw ${code} detail`);
      if (bucket === "passthrough") {
        expect(mapped.code, code).toBe(code);
      } else if (bucket === "busy") {
        expect(mapped.code, code).toBe(PublicErrorCodes.SERVICE_BUSY);
      } else if (bucket === "timeout") {
        expect(mapped.code, code).toBe(PublicErrorCodes.REQUEST_TIMEOUT);
      } else if (bucket === "failed") {
        expect(mapped.code, code).toBe(PublicErrorCodes.CHAT_FAILED);
      }
    }
  });

  it("ER-PART-03 §52:Public 映射结果里 PROVIDER_* = 0,退役的兼容例外不得复活", () => {
    for (const code of ALL_CODES) {
      const mapped = toPublicError(code, `raw ${code} detail`);
      expect(mapped.code, code).not.toContain("PROVIDER_");
      expect(mapped.message, code).not.toContain("PROVIDER_");
    }
    // 曾经是唯一的 PROVIDER_* 透传项(FIX-02D 兼容例外),现已归入 BUSY
    expect(toPublicError(ErrorCodes.PROVIDER_NOT_READY, "provider not ready")).toEqual({
      code: PublicErrorCodes.SERVICE_BUSY,
      message: GENERIC_MESSAGE.SERVICE_BUSY,
    });
    // Admin surface 反面对照:原码原文照旧保留(§32)
    expect(
      toPublicError(ErrorCodes.PROVIDER_NOT_READY, "provider not ready", { internal: true }),
    ).toEqual({ code: "PROVIDER_NOT_READY", message: "provider not ready" });
  });
});

describe("Public Error message 语义(§13)", () => {
  it("ER-MSG-01 透传类保留原 message,映射类换成稳定通用文本", () => {
    expect(toPublicError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation nope-1 not found")).toEqual(
      { code: "CONVERSATION_NOT_FOUND", message: "Conversation nope-1 not found" },
    );
    expect(toPublicError(ErrorCodes.PROVIDER_DOM_CHANGED, "Gemini selector .x missing").message).toBe(
      GENERIC_MESSAGE.CHAT_FAILED,
    );
    expect(toPublicError(ErrorCodes.PROVIDER_RATE_LIMITED, "gemini 429").message).toBe(
      GENERIC_MESSAGE.SERVICE_BUSY,
    );
    expect(toPublicError(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT, "waited 600s").message).toBe(
      GENERIC_MESSAGE.REQUEST_TIMEOUT,
    );
  });

  it("ER-MSG-02 通用文本绝不拼接原始 message(§13)", () => {
    const raw = "SECRET_PROVIDER_INTERNAL_DETAIL_123 at Gemini page .cib-task-item";
    for (const code of [
      ErrorCodes.PROVIDER_DOM_CHANGED,
      ErrorCodes.PROVIDER_PROFILE_IN_USE,
      ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
      ErrorCodes.ATTACHMENT_CAPACITY_EXCEEDED,
      ErrorCodes.DATABASE_ERROR,
      ErrorCodes.INTERNAL_ERROR,
    ]) {
      expect(toPublicError(code, raw).message).not.toContain("SECRET_PROVIDER_INTERNAL_DETAIL_123");
      expect(toPublicError(code, raw).message).not.toContain("Gemini");
    }
  });

  it("ER-MSG-03 映射后的 message 不含任何实现关键词(§17 泄露词表)", () => {
    const forbidden = /gemini|playwright|chromium|browser profile|selector|provider page|dom|sqlite|prisma/i;
    for (const code of [...BUSY, ...TIMEOUT, ...FAILED]) {
      const mapped = toPublicError(code, `raw detail for ${code}`);
      expect(forbidden.test(`${mapped.code} ${mapped.message}`), code).toBe(false);
    }
  });
});

describe("Public Error 失败闭合与边界(§14/§18/§32)", () => {
  it("ER-FAIL-01 未来新增的内部码默认落 CHAT_FAILED,不会自动透传", () => {
    expect(toPublicError("PROVIDER_SOMETHING_BRAND_NEW", "internal detail")).toEqual({
      code: "CHAT_FAILED",
      message: GENERIC_MESSAGE.CHAT_FAILED,
    });
  });

  it("ER-FAIL-02 映射是幂等的:二次映射不改变结果", () => {
    for (const code of ALL_CODES) {
      const once = toPublicError(code, "raw");
      expect(toPublicError(once.code, once.message)).toEqual(once);
    }
  });

  it("ER-FAIL-03 internal=true 保留原码原文(ADMIN 运维视图,§32)", () => {
    expect(
      toPublicError(ErrorCodes.PROVIDER_PROFILE_IN_USE, "User data directory is already in use", {
        internal: true,
      }),
    ).toEqual({
      code: "PROVIDER_PROFILE_IN_USE",
      message: "User data directory is already in use",
    });
    expect(
      toPublicError(ErrorCodes.PROVIDER_DOM_CHANGED, "Gemini DOM changed", { internal: true }),
    ).toEqual({ code: "PROVIDER_DOM_CHANGED", message: "Gemini DOM changed" });
  });
});
