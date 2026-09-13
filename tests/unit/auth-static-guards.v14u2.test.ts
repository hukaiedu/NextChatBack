import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * V1.4 U2 §77/§78/§92/§96/§105:范围明确的源码静态守卫。
 *
 * 刻意不引入 AST/parser 依赖 —— 这几条规则的表达形式本身就是要钉的东西:
 * auth 模块**没有**日志出口能拿到口令/请求体,也**没有**任何一条语句能写业务表。
 * 用「整模块零命中」来保证,比逐条审查调用点更抗腐蚀(新增文件自动被扫进来)。
 *
 * 扫描前先剥掉注释:文档注释里会出现 "passwordHash"、"req.body" 这些词本身。
 */

const AUTH_DIR = join(process.cwd(), "src", "modules", "auth");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** 去掉行注释与块注释,只留代码 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function codeOf(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

const files = sourceFiles(AUTH_DIR);
const rel = (path: string) => relative(process.cwd(), path).replace(/\\/g, "/");

describe("V1.4 U2 auth 模块静态守卫", () => {
  it("守卫确实扫到了预期范围的文件(空目录等于守卫失效)", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.map(rel)).toEqual(
      expect.arrayContaining([
        "src/modules/auth/auth.controller.ts",
        "src/modules/auth/auth.password.ts",
        "src/modules/auth/auth.username.ts",
        "src/modules/auth/auth.session.service.ts",
        "src/modules/auth/auth.user.repository.ts",
      ]),
    );
  });

  it("§76/§105 没有任何日志/console 调用带口令、摘要或请求体", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      // logger.<m>({...}, "...") / console.<m>(...) —— 实参与消息里都不许出现这些词
      const calls = code.match(/(?:logger|console)\s*\.\s*\w+\s*\([\s\S]*?\);/g) ?? [];
      for (const call of calls) {
        if (/password|passwordhash|authorization|cookie|req\.body/i.test(call)) {
          offenders.push(`${rel(file)}: ${call.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      }
      if (/(?:logger|console)\s*\.\s*\w+\s*\([^)]*\bbody\b/i.test(code)) {
        offenders.push(`${rel(file)}: 日志实参引用了 body`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("§105 req.body 只出现在 schema 校验实参位,不进任何日志/拼接", () => {
    for (const file of files) {
      for (const line of codeOf(file).split("\n")) {
        if (!line.includes("req.body")) continue;
        expect(
          /safeParse\(req\.body|parse\(req\.body/.test(line),
          `${rel(file)}: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  it("§78/§96 每条响应载荷都只能出自白名单构造器", () => {
    const controller = codeOf(join(AUTH_DIR, "auth.controller.ts"));
    const payloads = [...controller.matchAll(/\.json\(\{([\s\S]{0,160}?)\}\)/g)].map((m) =>
      m[1].replace(/\s+/g, " ").trim(),
    );
    // 4 处成功响应 + COMPAT 那处 + revoke-all 的 { revoked }
    expect(payloads.length).toBeGreaterThanOrEqual(6);
    for (const payload of payloads) {
      expect(
        /^data:\s*(authenticatedPayload\(|sessionPayload\(|\{ revoked)/.test(payload),
        `未走白名单构造器的响应载荷:${payload}`,
      ).toBe(true);
    }
    // 白名单构造器本身只有四个键,凭据列无从出现
    const builder = controller.slice(
      controller.indexOf("function authenticatedPayload"),
      controller.indexOf("function sessionPayload"),
    );
    expect(builder).toMatch(/username/);
    expect(builder).not.toMatch(/password|tokenHash|userId|sessionId/);
    // Session 解析投影刻意不含凭据列:DTO 与凭据读取是两条互不复用的查询
    const sessionRepo = codeOf(join(AUTH_DIR, "auth.session.repository.ts"));
    expect(sessionRepo).not.toContain("passwordHash");
    expect(sessionRepo).not.toContain("usernameNormalized");
  });

  it("§92 auth 模块不碰任何业务表,注册/登录/改密不可能迁数据", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      for (const model of ["conversation", "message", "modelRequest"]) {
        // db.<model>.xxx / tx.<model>.xxx / "<Model>Repository" 三类真实访问形式
        if (new RegExp(`\\b(?:db|prisma|tx)\\.${model}\\s*\\.`).test(code)) {
          offenders.push(`${rel(file)}: ${model} 模型访问`);
        }
        if (new RegExp(`\\b${model.charAt(0).toUpperCase()}${model.slice(1)}Repository\\b`).test(code)) {
          offenders.push(`${rel(file)}: ${model} repository`);
        }
      }
      if (/from "\.\.\/(conversation|message|request)\//.test(code)) {
        offenders.push(`${rel(file)}: import 了业务模块`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("§22 归一化只用 toLowerCase,不用 locale 变体", () => {
    for (const file of files) {
      expect(codeOf(file), rel(file)).not.toContain("toLocaleLowerCase");
    }
  });

  it("§15 请求路径只用 async 散列 API,不用 *Sync", () => {
    const password = codeOf(join(AUTH_DIR, "auth.password.ts"));
    expect(password).not.toMatch(/hashSync|verifySync|hashRawSync/);
    expect(password).toMatch(/export function hashPassword/);
  });
});
