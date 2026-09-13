import { describe, expect, it } from "vitest";

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  isValidUsername,
  normalizeUsername,
} from "../../src/modules/auth/auth.username.js";

/**
 * V1.4 U2 §94:username 规则与归一化。
 *
 * 这里测的是**规则本身**;「同名只能有一个」由 DB UNIQUE 保证(MIG-06),
 * 「Sky 与 SKY 撞车」是这两者合起来的效果 —— 少任何一侧都不成立。
 */
describe("auth.username(V1.4 U2)", () => {
  it("USR-01/02 边界长度 3 与 32 合法", () => {
    expect(USERNAME_MIN_LENGTH).toBe(3);
    expect(USERNAME_MAX_LENGTH).toBe(32);
    expect(isValidUsername("abc")).toBe(true);
    expect(isValidUsername("a".repeat(32))).toBe(true);
  });

  it("USR-03/04 长度 2 与 33 拒绝", () => {
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("a".repeat(33))).toBe(false);
  });

  it("USR-05/06/07 字母、数字、下划线与连字符都允许", () => {
    for (const ok of ["Alice", "abc123", "a_b-c", "_start", "end-", "9lives", "A-Z_0"]) {
      expect(isValidUsername(ok), ok).toBe(true);
    }
  });

  it("USR-08 空白、点、@、斜杠等一律拒绝(不做 trim,避免『看起来一样』的账号)", () => {
    for (const bad of ["ab c", " abc", "abc ", "a.b", "a@b", "a/b", "a\\b", "a+b", "ab!", ""]) {
      expect(isValidUsername(bad), bad).toBe(false);
    }
  });

  it("USR-09 非 ASCII 一律拒绝(中文、全角、带变音符号、emoji)", () => {
    for (const bad of ["凯", "ｉｑ", "café", "Straße", "🐱cat", "ab\u00A0c"]) {
      expect(isValidUsername(bad), bad).toBe(false);
      expect(USERNAME_PATTERN.test(bad)).toBe(false);
    }
  });

  it("USR-10 归一化收敛大小写:Sky / SKY / sKy 全落 sky", () => {
    expect(normalizeUsername("Sky")).toBe("sky");
    expect(normalizeUsername("SKY")).toBe("sky");
    expect(normalizeUsername("sKy")).toBe("sky");
    expect(normalizeUsername("Alice_9-B")).toBe("alice_9-b");
  });

  it("USR-11 归一化与 locale 无关:用的是 toLowerCase 而不是 toLocaleLowerCase", () => {
    // 'I' 在土耳其语 locale 下 toLocaleLowerCase() → 'ı'(U+0131),与 'i'(U+0069)不同码位。
    // 若归一化随运行机器 locale 漂移,"IQ" 与 "iq" 就会归一化成两个值 ⇒ UNIQUE 形同失效。
    expect(normalizeUsername("IQ")).toBe("iq");
    expect([...normalizeUsername("IQ")].map((c) => c.codePointAt(0))).toEqual([0x69, 0x71]);
    const localeVariant = "IQ".toLocaleLowerCase("tr-TR");
    expect(localeVariant).not.toBe(normalizeUsername("IQ"));
  });

  it("正则本身要求整串匹配(前后不能挂垃圾字符)", () => {
    expect(USERNAME_PATTERN.test("abc$")).toBe(false);
    expect(USERNAME_PATTERN.test("x".repeat(32) + "y")).toBe(false);
    expect(USERNAME_PATTERN.test("multi\nline")).toBe(false);
  });
});
