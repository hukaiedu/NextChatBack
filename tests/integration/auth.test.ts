import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { AUTH_COOKIE_NAME } from "../../src/config/constants.js";
import { parseEnv } from "../../src/config/env.js";
import { LoginRateLimiter } from "../../src/modules/auth/auth.rate-limit.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import { setupTestContext, type TestContext } from "../helpers.js";

const PASSWORD = "test-password-123";
const SECRET = "0123456789abcdef0123456789abcdef";
const TTL = 3600;

function authDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    enabled: true,
    password: PASSWORD,
    secret: SECRET,
    ttlSeconds: TTL,
    allowedOrigins: null,
    trustProxy: false,
    cookieSecureAlways: false,
    ...overrides,
  };
}

/** 每用例独立 app(登录限流在 app 内部累积,必须隔离),用完即拆 */
async function withApp<T>(
  fn: (ctx: TestContext) => Promise<T>,
  auth: AuthDeps | null = authDeps(),
  limiter?: LoginRateLimiter,
): Promise<T> {
  const ctx = await setupTestContext({ auth, loginRateLimiter: limiter });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
    limiter?.dispose();
  }
}

function fakeClock() {
  let now = Date.now();
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function login(
  baseUrl: string,
  password: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

function cookieHeader(res: Response): string | null {
  const raw = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  return raw ? raw.split(";")[0] : null;
}

function sessionCookie(token: string): string {
  return `${AUTH_COOKIE_NAME}=${token}`;
}

/** 用指定 payload + 正确 HMAC 构造 token(过期/字段异常场景) */
function craftToken(payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payloadB64, "ascii").digest();
  return `${payloadB64}.${signature.toString("base64url")}`;
}

describe("AUTH-01 未认证访问业务 API → 401 AUTH_REQUIRED", () => {
  it("五组业务 router 代表端点统一 401", async () => {
    await withApp(async (ctx) => {
      const cases: Array<[string, RequestInit]> = [
        ["/api/conversations", { method: "POST", body: "{}" }],
        ["/api/conversations", { method: "GET" }],
        ["/api/conversations/some-id", { method: "PATCH", body: "{}" }],
        ["/api/conversations/some-id/messages", { method: "POST", body: "{}" }],
        ["/api/requests/some-id/cancel", { method: "POST" }],
        ["/api/provider/models", { method: "GET" }],
        ["/api/browser/status", { method: "GET" }],
      ];
      for (const [path, init] of cases) {
        const res = await fetch(`${ctx.baseUrl}${path}`, {
          ...init,
          headers: { "Content-Type": "application/json", ...init.headers },
        });
        expect(res.status, path).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code, path).toBe(ErrorCodes.AUTH_REQUIRED);
      }
    });
  });
});

describe("AUTH-02 有效 cookie 访问业务 API", () => {
  it("登录后 CRUD + 消息 + 取消端点正常", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      expect(loginRes.status).toBe(200);
      const cookie = cookieHeader(loginRes);
      expect(cookie).not.toBeNull();
      const authed = { Cookie: cookie!, "Content-Type": "application/json" };

      const createRes = await fetch(`${ctx.baseUrl}/api/conversations`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ title: "sec1" }),
      });
      expect(createRes.status).toBe(201);
      const conversation = (await createRes.json()) as { data: { id: string } };

      const patchRes = await fetch(`${ctx.baseUrl}/api/conversations/${conversation.data.id}`, {
        method: "PATCH",
        headers: authed,
        body: JSON.stringify({ title: "sec1-renamed" }),
      });
      expect(patchRes.status).toBe(200);

      const messageRes = await fetch(
        `${ctx.baseUrl}/api/conversations/${conversation.data.id}/messages`,
        {
          method: "POST",
          headers: { ...authed, "Idempotency-Key": "auth-02-key" },
          body: JSON.stringify({ content: "hello" }),
        },
      );
      expect(messageRes.status).toBe(202);
      const message = (await messageRes.json()) as { data: { request: { id: string } } };

      const cancelRes = await fetch(
        `${ctx.baseUrl}/api/requests/${message.data.request.id}/cancel`,
        { method: "POST", headers: authed },
      );
      expect(cancelRes.status).toBe(200);

      const listRes = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: authed,
      });
      expect(listRes.status).toBe(200);

      const deleteRes = await fetch(`${ctx.baseUrl}/api/conversations/${conversation.data.id}`, {
        method: "DELETE",
        headers: authed,
      });
      expect(deleteRes.status).toBe(204);
    });
  });
});

describe("AUTH-03/04/05 login 契约", () => {
  it("AUTH-03 正确密码 → Set-Cookie 属性(HttpOnly/SameSite=Strict/Path=/Max-Age;http 无 Secure)", async () => {
    await withApp(async (ctx) => {
      const res = await login(ctx.baseUrl, PASSWORD);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { authenticated: boolean; expiresAt: string } };
      expect(body.data.authenticated).toBe(true);
      expect(Number.isNaN(Date.parse(body.data.expiresAt))).toBe(false);

      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toMatch(/SameSite=Strict/i);
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain(`Max-Age=${TTL}`);
      expect(setCookie).not.toContain("Secure");
    });
  });

  it("AUTH-04 错误密码 → 401 AUTH_INVALID_CREDENTIALS", async () => {
    await withApp(async (ctx) => {
      const res = await login(ctx.baseUrl, "wrong-password-x");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
    });
  });

  it("AUTH-05 body 缺失/类型错 → 400 VALIDATION_ERROR,且不计入限流", async () => {
    await withApp(async (ctx) => {
      const missing = await login(ctx.baseUrl, undefined);
      expect(missing.status).toBe(400);
      const badType = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: 12345 }),
      });
      expect(badType.status).toBe(400);

      // 400 不计数:之后仍可正常登录
      const ok = await login(ctx.baseUrl, PASSWORD);
      expect(ok.status).toBe(200);
    });
  });
});

describe("AUTH-06..08 登录限流", () => {
  it("AUTH-06 连续 5 次失败后第 6 次 → 429 + Retry-After(即使密码正确)", async () => {
    await withApp(async (ctx) => {
      for (let i = 0; i < 5; i += 1) {
        const res = await login(ctx.baseUrl, "wrong-password-x");
        expect(res.status).toBe(401);
      }
      const blocked = await login(ctx.baseUrl, PASSWORD);
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.AUTH_RATE_LIMITED);
      expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    });
  });

  it("AUTH-07 窗口过期后(注入时钟推进)恢复可登录", async () => {
    const clock = fakeClock();
    const limiter = new LoginRateLimiter({ clock, sweepIntervalMs: 3_600_000 });
    await withApp(
      async (ctx) => {
        for (let i = 0; i < 5; i += 1) {
          await login(ctx.baseUrl, "wrong-password-x");
        }
        expect((await login(ctx.baseUrl, PASSWORD)).status).toBe(429);

        clock.advance(10 * 60 * 1000 + 1);
        expect((await login(ctx.baseUrl, PASSWORD)).status).toBe(200);
      },
      authDeps(),
      limiter,
    );
  });

  it("AUTH-08 登录成功清零失败计数(4 失败 + 1 成功 → 再失败从 1 起算)", async () => {
    await withApp(async (ctx) => {
      for (let i = 0; i < 4; i += 1) {
        await login(ctx.baseUrl, "wrong-password-x");
      }
      expect((await login(ctx.baseUrl, PASSWORD)).status).toBe(200);

      // 清零后 4 次失败不 429,第 5 次失败起窗口内全拦截
      for (let i = 0; i < 4; i += 1) {
        expect((await login(ctx.baseUrl, "wrong-password-x")).status).toBe(401);
      }
      expect((await login(ctx.baseUrl, "wrong-password-x")).status).toBe(401);
      expect((await login(ctx.baseUrl, PASSWORD)).status).toBe(429);
    });
  });
});

describe("AUTH-09..11 token 校验(requireAuth)", () => {
  it("AUTH-09 篡改签名(token 尾段改 1 字符)→ 401", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const raw = cookieHeader(loginRes)!;
      const token = raw.slice(AUTH_COOKIE_NAME.length + 1);
      const [payloadB64, sigB64] = token.split(".");
      // base64url 末字符的低 4 位是填充位,解码端忽略;只翻转末字符有概率
      // 解出完全相同的签名字节导致校验通过。首字符参与首字节高 6 位,
      // 翻转必然改变解码结果
      const flipped = sigB64!.at(0) === "A" ? "B" : "A";
      const tampered = `${payloadB64}.${flipped}${sigB64!.slice(1)}`;

      const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: sessionCookie(tampered) },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.AUTH_REQUIRED);
    });
  });

  it("AUTH-10 过期 token(exp 已过)→ 401", async () => {
    await withApp(async (ctx) => {
      const expired = craftToken({
        v: 1,
        iat: Math.floor(Date.now() / 1000) - 100,
        exp: Math.floor(Date.now() / 1000) - 1,
        sid: "a".repeat(32),
      });
      const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: sessionCookie(expired) },
      });
      expect(res.status).toBe(401);
    });
  });

  it("AUTH-11 非法格式(无点/三段/非 base64url/超长)→ 401", async () => {
    await withApp(async (ctx) => {
      const invalid = [
        "nodot",
        "a.b.c",
        "abc+.def",
        `${"a".repeat(1025)}`,
        `${Buffer.from("ok", "utf8").toString("base64url")}.a${"b".repeat(30)}`, // sig 解码 31 字节
      ];
      for (const token of invalid) {
        const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
          headers: { Cookie: sessionCookie(token) },
        });
        expect(res.status, token.slice(0, 20)).toBe(401);
      }
    });
  });
});

describe("AUTH-12/13 session 探测", () => {
  it("AUTH-12 匿名 → 200 {authenticated:false}", async () => {
    await withApp(async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/session`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { authenticated: boolean; expiresAt: null } };
      expect(body.data.authenticated).toBe(false);
      expect(body.data.expiresAt).toBeNull();
    });
  });

  it("AUTH-13 有效 cookie → 200 {authenticated:true, expiresAt ISO}", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const res = await fetch(`${ctx.baseUrl}/api/auth/session`, {
        headers: { Cookie: cookieHeader(loginRes)! },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { authenticated: boolean; expiresAt: string } };
      expect(body.data.authenticated).toBe(true);
      expect(Number.isNaN(Date.parse(body.data.expiresAt))).toBe(false);
    });
  });
});

describe("AUTH-14 logout", () => {
  it("204 + Max-Age=0;旧 token 在 exp 前重放仍有效(§5.5 无状态语义)", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const cookie = cookieHeader(loginRes)!;

      const logoutRes = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(logoutRes.status).toBe(204);
      const setCookie = logoutRes.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("Max-Age=0");
      expect(setCookie).toContain("Path=/");

      // 无状态:logout 不吊销 token 本身
      const replay = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: cookie },
      });
      expect(replay.status).toBe(200);
    });
  });
});

describe("AUTH-15 SSE 建连认证", () => {
  it("未认证 GET /api/requests/:id/events → 401,非 event-stream", async () => {
    await withApp(async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/api/requests/some-id/events`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).not.toContain("text/event-stream");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.AUTH_REQUIRED);
    });
  });
});

describe("AUTH-16 health 匿名", () => {
  it("GET /api/health → 200 且仅 status/database 两字段", async () => {
    await withApp(async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, string> };
      expect(Object.keys(body.data).sort()).toEqual(["database", "status"]);
    });
  });
});

describe("AUTH-17 Origin 白名单拒绝", () => {
  it("unsafe method 非白名单 Origin / null / 解析失败 → 403 AUTH_CSRF_REJECTED", async () => {
    await withApp(async (ctx) => {
      const cases: Array<[string, string | null]> = [
        ["/api/conversations", "https://evil.example"],
        ["/api/conversations", "null"],
        ["/api/conversations", "not-a-url"],
        ["/api/auth/login", "https://evil.example"],
        ["/api/conversations/some-id", "https://evil.example"],
      ];
      for (const [path, origin] of cases) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (origin !== null) headers.Origin = origin;
        else headers.Origin = "null";
        const res = await fetch(`${ctx.baseUrl}${path}`, {
          method: path === "/api/conversations/some-id" ? "PATCH" : "POST",
          headers,
          body: JSON.stringify({}),
        });
        expect(res.status, `${path} Origin=${origin}`).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code, path).toBe(ErrorCodes.AUTH_CSRF_REJECTED);
      }
    });
  });
});

describe("AUTH-18 Origin 放行与规范化", () => {
  it("无 Origin 头放行;dev 默认白名单(localhost 任意端口)匹配", async () => {
    await withApp(async (ctx) => {
      // 无 Origin(curl/supertest 语义)→ 走到密码校验,401 而非 403
      const noOrigin = await login(ctx.baseUrl, "wrong-password-x");
      expect(noOrigin.status).toBe(401);

      // dev 默认白名单 http://localhost:* 放行(同样 401 非 403)
      const localhost = await login(ctx.baseUrl, "wrong-password-x", {
        Origin: "http://localhost:3000",
      });
      expect(localhost.status).toBe(401);
    });
  });

  it("显式白名单:请求侧 Origin 默认端口规范化后匹配;端口不匹配/子域不匹配拒绝", async () => {
    await withApp(
      async (ctx) => {
        // 配置项必须是规范化 origin;请求侧 https://example.com:443 规范化后匹配
        const plain = await login(ctx.baseUrl, "wrong-password-x", {
          Origin: "https://example.com",
        });
        expect(plain.status).toBe(401);

        const explicitPort = await login(ctx.baseUrl, "wrong-password-x", {
          Origin: "https://example.com:443",
        });
        expect(explicitPort.status).toBe(401);

        for (const origin of ["http://example.com", "https://example.com:8443", "https://sub.example.com"]) {
          const rejected = await login(ctx.baseUrl, "wrong-password-x", { Origin: origin });
          expect(rejected.status, origin).toBe(403);
        }
      },
      authDeps({ allowedOrigins: ["https://example.com"] }),
    );
  });
});

describe("AUTH-19/20/26 env fail-fast", () => {
  const base = {
    DATABASE_URL: "file:./data/database/test.db",
  };

  it("AUTH-19 AUTH_ENABLED=true 缺 AUTH_PASSWORD 或 SECRET → 抛错", () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "test",
        AUTH_ENABLED: "true",
        AUTH_SESSION_SECRET: SECRET,
      }),
    ).toThrow(/AUTH_PASSWORD/);

    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "test",
        AUTH_ENABLED: "true",
        AUTH_PASSWORD: PASSWORD,
      }),
    ).toThrow(/AUTH_SESSION_SECRET/);
  });

  it("AUTH-20 NODE_ENV=production + AUTH_ENABLED=false → 抛错", () => {
    expect(() =>
      parseEnv({ ...base, NODE_ENV: "production", AUTH_ENABLED: "false" }),
    ).toThrow(/AUTH_ENABLED/);
  });

  it("AUTH-26 production + 白名单含 http:// origin → 抛错", () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        AUTH_ENABLED: "true",
        AUTH_PASSWORD: PASSWORD,
        AUTH_SESSION_SECRET: SECRET,
        AUTH_ALLOWED_ORIGINS: "https://ok.example,http://bad.example",
      }),
    ).toThrow(/https/);
  });
});

describe("AUTH-21 AUTH_ENABLED=false", () => {
  it("session 返回 authenticated:true;业务 API 无 cookie 正常;login/logout no-op", async () => {
    await withApp(
      async (ctx) => {
        const session = await fetch(`${ctx.baseUrl}/api/auth/session`);
        expect(session.status).toBe(200);
        const sessionBody = (await session.json()) as {
          data: { authenticated: boolean; expiresAt: string | null };
        };
        expect(sessionBody.data.authenticated).toBe(true);
        expect(sessionBody.data.expiresAt).toBeNull();

        const loginRes = await login(ctx.baseUrl, PASSWORD);
        expect(loginRes.status).toBe(200);
        expect(loginRes.headers.getSetCookie()).toHaveLength(0);

        const createRes = await fetch(`${ctx.baseUrl}/api/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "disabled" }),
        });
        expect(createRes.status).toBe(201);

        const logoutRes = await fetch(`${ctx.baseUrl}/api/auth/logout`, { method: "POST" });
        expect(logoutRes.status).toBe(204);
      },
      null,
    );
  });
});

describe("AUTH-22A AUTH_TRUST_PROXY=false:req.ip 忽略客户端伪造 XFF", () => {
  it("分桶键=socket 地址:轮换 XFF 无法开辟新桶(公网 fallback 语义)", async () => {
    await withApp(
      async (ctx) => {
        const spoofed = { "X-Forwarded-For": "1.2.3.4" };
        for (let i = 0; i < 5; i += 1) {
          const res = await login(ctx.baseUrl, "wrong-password-x", spoofed);
          expect(res.status).toBe(401);
        }
        // trustProxy=false 时 XFF 不参与 req.ip:同一 socket 全部落入同一桶
        const noXff = await login(ctx.baseUrl, PASSWORD);
        expect(noXff.status).toBe(429);
        const rotatedXff = await login(ctx.baseUrl, "wrong-password-x", {
          "X-Forwarded-For": "5.6.7.8",
        });
        expect(rotatedXff.status).toBe(429);
      },
      authDeps({ trustProxy: false }),
    );
  });
});

describe("AUTH-22B AUTH_TRUST_PROXY=true:Express 按可信代理链解析 req.ip", () => {
  // 本用例只验证 Express 在 trustProxy=true 下的 XFF 解析行为(loopback 模拟)。
  // 客户端自带 XFF 可影响 req.ip 是该模式的预期语义,不构成公网 spoof 防护;
  // 公网安全依赖真实反向代理覆盖/清洗 XFF,由 AUTH-REAL-09B 真机验收。
  it("同 XFF 同桶 429,不同 XFF 独立桶,无 XFF 落 socket 桶", async () => {
    await withApp(
      async (ctx) => {
        const xff = { "X-Forwarded-For": "1.2.3.4" };
        for (let i = 0; i < 5; i += 1) {
          const res = await login(ctx.baseUrl, "wrong-password-x", xff);
          expect(res.status).toBe(401);
        }
        // 同一 XFF 桶:正确密码也被 429
        const sameBucket = await login(ctx.baseUrl, PASSWORD, xff);
        expect(sameBucket.status).toBe(429);

        // 不同 XFF = 不同桶:不 429,落到密码校验 401
        const otherBucket = await login(ctx.baseUrl, "wrong-password-x", {
          "X-Forwarded-For": "5.6.7.8",
        });
        expect(otherBucket.status).toBe(401);

        // 无 XFF(socket 地址桶):不 429
        const noXff = await login(ctx.baseUrl, "wrong-password-x");
        expect(noXff.status).toBe(401);
      },
      authDeps({ trustProxy: true }),
    );
  });
});

describe("AUTH-23/24 单元覆盖说明", () => {
  it("由 tests/unit/auth.service.test.ts 与 auth.rate-limit.test.ts 覆盖", () => {
    expect(true).toBe(true);
  });
});

describe("AUTH-25 production Cookie Secure 恒在", () => {
  it("cookieSecureAlways=true 时 http 请求也返回 Secure(Set-Cookie fail-closed)", async () => {
    await withApp(
      async (ctx) => {
        const res = await login(ctx.baseUrl, PASSWORD);
        expect(res.status).toBe(200);
        const setCookie = res.headers
          .getSetCookie()
          .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
        expect(setCookie).toContain("Secure");
        expect(setCookie).toContain("HttpOnly");
      },
      authDeps({ cookieSecureAlways: true }),
    );
  });

  it("反向验证:cookieSecureAlways=false 的 dev 场景无 Secure(AUTH-03)", async () => {
    await withApp(async (ctx) => {
      const res = await login(ctx.baseUrl, PASSWORD);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
      expect(setCookie).not.toContain("Secure");
    });
  });
});

describe("AUTH-27 三个 Auth endpoint 携带 Cache-Control: no-store", () => {
  it("login(200/401)/session(200)/logout(204)全部 no-store", async () => {
    await withApp(async (ctx) => {
      const ok = await login(ctx.baseUrl, PASSWORD);
      expect(ok.headers.get("cache-control")).toBe("no-store");

      const bad = await login(ctx.baseUrl, "wrong-password-x");
      expect(bad.headers.get("cache-control")).toBe("no-store");

      const session = await fetch(`${ctx.baseUrl}/api/auth/session`);
      expect(session.headers.get("cache-control")).toBe("no-store");

      const logout = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookieHeader(ok)! },
      });
      expect(logout.headers.get("cache-control")).toBe("no-store");
    });
  });
});

describe("AUTH-26(配置侧)parseAllowedOrigins 形态校验", () => {
  it("带 path/query/credentials/通配的 origin → VALIDATION_ERROR", async () => {
    const { parseAllowedOrigins } = await import(
      "../../src/modules/auth/auth.middleware.js"
    );
    for (const raw of [
      "https://example.com/path",
      "https://example.com?x=1",
      "https://user:pass@example.com",
      "*",
      "https://*.example.com",
      "https://Example.com:443",
      "https://a.com,,https://b.com",
    ]) {
      expect(() => parseAllowedOrigins(raw, false), raw).toThrow();
    }
    expect(parseAllowedOrigins("https://example.com/", false)).toEqual(["https://example.com"]);
    expect(parseAllowedOrigins(undefined, false)).toBeNull();
  });
});
