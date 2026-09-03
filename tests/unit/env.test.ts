import { describe, expect, it } from "vitest";

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
