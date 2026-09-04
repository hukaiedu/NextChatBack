import { describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { parseEnv } from "../../src/config/env.js";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "file:./data/database/test.db",
  PORT: "3011",
};

describe("parseEnv", () => {
  it("解析合法环境变量并套用默认值", () => {
    const env = parseEnv({ ...base });

    expect(env.NODE_ENV).toBe("test");
    expect(env.DATABASE_URL).toBe("file:./data/database/test.db");
    expect(env.PORT).toBe(3011);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.LOG_LEVEL).toBe("info");
    // 执行 watchdog 默认 10 分钟,高于 Adapter 的 5 分钟回答上限
    expect(env.GEMINI_RESPONSE_TIMEOUT_MS).toBe(300_000);
    expect(env.REQUEST_EXECUTION_TIMEOUT_MS).toBe(600_000);
  });

  it("缺少 DATABASE_URL 时抛 VALIDATION_ERROR", () => {
    const raw = { ...base };
    delete raw.DATABASE_URL;

    expect(() => parseEnv(raw)).toThrow(/DATABASE_URL/);
  });

  it("PORT 非数字时抛错", () => {
    expect(() => parseEnv({ ...base, PORT: "abc" })).toThrow(/PORT/);
  });

  it("PORT 超出范围时抛错", () => {
    expect(() => parseEnv({ ...base, PORT: "70000" })).toThrow(/PORT/);
  });

  it("LOG_LEVEL 非法时抛错", () => {
    expect(() => parseEnv({ ...base, LOG_LEVEL: "chatty" })).toThrow(/LOG_LEVEL/);
  });
});

// ISSUE-03:REQUEST_EXECUTION_TIMEOUT_MS 与 GEMINI_RESPONSE_TIMEOUT_MS 的跨字段约束。
// 执行 watchdog 上限必须严格高于单次 Prompt 响应上限;相等或更小都非法,
// 启动即 VALIDATION_ERROR + fail-fast(不能只写在注释里)。
describe("parseEnv 超时跨字段约束(ISSUE-03)", () => {
  it("EXEC > RESPONSE → PASS", () => {
    const env = parseEnv({
      ...base,
      GEMINI_RESPONSE_TIMEOUT_MS: "300000",
      REQUEST_EXECUTION_TIMEOUT_MS: "300001",
    });
    expect(env.GEMINI_RESPONSE_TIMEOUT_MS).toBe(300_000);
    expect(env.REQUEST_EXECUTION_TIMEOUT_MS).toBe(300_001);
  });

  it("EXEC = RESPONSE → FAIL(相等同样非法)", () => {
    expect(() =>
      parseEnv({
        ...base,
        GEMINI_RESPONSE_TIMEOUT_MS: "300000",
        REQUEST_EXECUTION_TIMEOUT_MS: "300000",
      }),
    ).toThrow(/REQUEST_EXECUTION_TIMEOUT_MS must be greater than GEMINI_RESPONSE_TIMEOUT_MS/);
  });

  it("EXEC < RESPONSE → FAIL(验收计划示例 200000 < 300000)", () => {
    expect(() =>
      parseEnv({
        ...base,
        GEMINI_RESPONSE_TIMEOUT_MS: "300000",
        REQUEST_EXECUTION_TIMEOUT_MS: "200000",
      }),
    ).toThrow(/REQUEST_EXECUTION_TIMEOUT_MS/);
  });

  it("非法配置抛 AppError(VALIDATION_ERROR) 且 HTTP 400,fail-fast", () => {
    let caught: unknown = null;
    try {
      parseEnv({
        ...base,
        GEMINI_RESPONSE_TIMEOUT_MS: "300000",
        REQUEST_EXECUTION_TIMEOUT_MS: "300000",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect((caught as AppError).statusCode).toBe(400);
  });
});
