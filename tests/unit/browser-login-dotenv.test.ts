/**
 * P1-01 回归:browser-login CLI 必须与 main.ts 一样先加载 .env(dotenv/config)。
 * 否则 .env 覆盖的 BROWSER_PROFILE_DIR 只有后端生效,登录态会被写进默认目录。
 * 手法:用 DOTENV_CONFIG_PATH 指向临时 env 文件,验证「import 本模块 = 触发 dotenv 加载」。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PROBE_KEY = "P1_01_DOTENV_PROBE";

describe("browser-login dotenv 加载(P1-01)", () => {
  it("import 模块即加载 .env(与 main.ts 同款 dotenv/config)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p1-01-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, `${PROBE_KEY}=loaded-from-dotenv\n`);
      process.env.DOTENV_CONFIG_PATH = envPath;
      delete process.env[PROBE_KEY];

      await import("../../src/scripts/browser-login.js");

      expect(process.env[PROBE_KEY]).toBe("loaded-from-dotenv");
    } finally {
      delete process.env.DOTENV_CONFIG_PATH;
      delete process.env[PROBE_KEY];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
