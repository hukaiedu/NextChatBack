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

  // P1-01:browser:login 与 main.ts 同款加载 .env;此默认值是 CLI/后端未配置时的共同兜底
  it("BROWSER_PROFILE_DIR 未设置时套用默认值", () => {
    expect(parseEnv({ ...base }).BROWSER_PROFILE_DIR).toBe(
      "./data/browser-profile",
    );
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

/**
 * P8:BROWSER_PROXY_URL 可选显式代理的启动校验(P8-PROXY-03)。
 * 只接受 http/https/socks5 且不得携带 credentials;未设置与空串合法(不传 proxy,
 * Windows 开发环境沿用 Chromium 继承的系统代理)。
 */
describe("parseEnv BROWSER_PROXY_URL(P8-PROXY-03)", () => {
  it("合法代理协议 http/https/socks5 均解析通过并原样保留", () => {
    for (const url of [
      "http://127.0.0.1:7892",
      "https://proxy.example.com:8443",
      "socks5://127.0.0.1:1080",
    ]) {
      const env = parseEnv({ ...base, BROWSER_PROXY_URL: url });
      expect(env.BROWSER_PROXY_URL).toBe(url);
    }
  });

  it("未设置或空串通过(不强制代理)", () => {
    expect(parseEnv({ ...base }).BROWSER_PROXY_URL).toBeUndefined();
    expect(parseEnv({ ...base, BROWSER_PROXY_URL: "" }).BROWSER_PROXY_URL).toBe("");
  });

  it("拒绝不支持的协议(ftp/file)与畸形 URL,错误消息含 BROWSER_PROXY_URL", () => {
    for (const url of ["ftp://proxy.local:2121", "file:///C:/proxy", "not a url", "http://"]) {
      expect(() => parseEnv({ ...base, BROWSER_PROXY_URL: url })).toThrow(
        /BROWSER_PROXY_URL/,
      );
    }
  });

  it("拒绝携带 credentials 的代理 URL,且错误消息不打印 URL 内容", () => {
    let caught: unknown = null;
    try {
      parseEnv({ ...base, BROWSER_PROXY_URL: "http://user:secret@127.0.0.1:7892" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCodes.VALIDATION_ERROR);
    const message = (caught as AppError).message;
    expect(message).toMatch(/BROWSER_PROXY_URL/);
    expect(message).not.toContain("secret");
  });
});
