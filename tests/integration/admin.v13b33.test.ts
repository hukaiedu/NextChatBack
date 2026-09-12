import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { ADMIN_USER_ID, AUTH_COOKIE_NAME } from "../../src/config/constants.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import {
  ADMIN_AUTH,
  loginAdmin,
  loginAnonymous,
  setupTestContext,
  withAdminCookie,
} from "../helpers.js";
import type { TestContext } from "../helpers.js";

/** §23 canonical Admin API 全集 */
const CANONICAL_ENDPOINTS = [
  { method: "GET", path: "/api/admin/browser/status" },
  { method: "POST", path: "/api/admin/browser/restart" },
  { method: "GET", path: "/api/admin/provider/status" },
  { method: "POST", path: "/api/admin/provider/open" },
  { method: "POST", path: "/api/admin/provider/restart" },
  { method: "POST", path: "/api/admin/sessions/revoke-all" },
] as const;

/** §25(V1.3-C)已退役的旧路径:router 不再挂载,任何身份都只会得到 404 */
const LEGACY_ENDPOINTS = [
  { method: "GET", path: "/api/browser/status" },
  { method: "POST", path: "/api/browser/restart" },
  { method: "GET", path: "/api/provider/status" },
  { method: "POST", path: "/api/provider/open" },
  { method: "POST", path: "/api/provider/restart" },
] as const;

async function errorCodeOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** 退役路径由 Express 默认 404 处理:没有 JSON 错误信封,判据只有状态码 */
function assertRetired(res: Response): void {
  expect(res.status).toBe(404);
}

describe("V1.3-B3-3 Admin / Public 边界(§21..§34)", () => {
  let ctx: TestContext;
  let driver: FakeDriver;

  afterEach(async () => {
    await ctx.close();
  });

  /** 每个用例一套独立 app + Fake Browser,避免运维状态串扰 */
  async function mountAuthed(): Promise<void> {
    driver = new FakeDriver();
    ctx = await setupTestContext({
      browserManager: createFakeManager(driver),
      geminiAdapter: new FakeGeminiAdapter({ answer: "假回答" }),
      auth: ADMIN_AUTH,
    });
    await ctx.reset();
  }

  async function mountCompat(): Promise<void> {
    ctx = await setupTestContext({
      browserManager: createFakeManager(new FakeDriver()),
      geminiAdapter: new FakeGeminiAdapter({ answer: "假回答" }),
    });
    await ctx.reset();
  }

  it.each(CANONICAL_ENDPOINTS)(
    "ADM-M01 $method$path:无 Cookie(未认证)→ 401 AUTH_REQUIRED",
    async ({ method, path }) => {
      await mountAuthed();
      const res = await fetch(`${ctx.baseUrl}${path}`, { method });
      expect(res.status).toBe(401);
      expect(await errorCodeOf(res)).toBe(ErrorCodes.AUTH_REQUIRED);
    },
  );

  it.each(CANONICAL_ENDPOINTS)(
    "ADM-M02 $method$path:已登录匿名用户 → 403 AUTH_FORBIDDEN",
    async ({ method, path }) => {
      await mountAuthed();
      const cookie = await loginAnonymous(ctx.baseUrl);
      const res = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        ...withAdminCookie(cookie),
      });
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe(ErrorCodes.AUTH_FORBIDDEN);
    },
  );

  it.each(LEGACY_ENDPOINTS)(
    "ADM-M03 $method$path:旧 alias 已退役 → 404,不再是权限判断(§25)",
    async ({ method, path }) => {
      await mountAuthed();
      const cookie = await loginAnonymous(ctx.baseUrl);
      const res = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        ...withAdminCookie(cookie),
      });
      assertRetired(res);
    },
  );

  it.each(CANONICAL_ENDPOINTS)(
    "ADM-M04 $method$path:COMPAT(AUTH_ENABLED=false)绝不因本地模式变管理员(§22)",
    async ({ method, path }) => {
      await mountCompat();
      const res = await fetch(`${ctx.baseUrl}${path}`, { method });
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe(ErrorCodes.AUTH_FORBIDDEN);
    },
  );

  it.each(LEGACY_ENDPOINTS)(
    "ADM-M04B $method$path:COMPAT 下旧 alias 同样是 404,不因本地模式复活(§25)",
    async ({ method, path }) => {
      await mountCompat();
      const res = await fetch(`${ctx.baseUrl}${path}`, { method });
      assertRetired(res);
    },
  );

  it("ADM-M05 全部 Admin 路由的 403 message 不泄露运维信息", async () => {
    await mountAuthed();
    const cookie = await loginAnonymous(ctx.baseUrl);
    const res = await fetch(`${ctx.baseUrl}/api/admin/browser/status`, {
      ...withAdminCookie(cookie),
    });
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ErrorCodes.AUTH_FORBIDDEN);
    expect(body.error.message).toBe("Administrator privileges required");
    expect(JSON.stringify(body)).not.toContain("profile");
    expect(JSON.stringify(body)).not.toContain("Gemini");
  });

  it("ADM-A01 ADMIN 走 canonical:运维能力保持原正常行为(§32)", async () => {
    await mountAuthed();
    const cookie = await loginAdmin(ctx.baseUrl);

    const browserStatus = await fetch(
      `${ctx.baseUrl}/api/admin/browser/status`,
      withAdminCookie(cookie),
    );
    expect(browserStatus.status).toBe(200);
    const snapshot = ((await browserStatus.json()) as {
      data: Record<string, unknown>;
    }).data;
    // §27:这些运维字段只在 ADMIN 侧存在
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "activeRequests",
        "browserType",
        "headless",
        "lastError",
        "observedAt",
        "profileDir",
        "provider",
        "providerLoggedIn",
        "startedAt",
        "state",
        "uptimeMs",
      ].sort(),
    );

    const providerStatus = await fetch(
      `${ctx.baseUrl}/api/admin/provider/status`,
      withAdminCookie(cookie),
    );
    expect(((await providerStatus.json()) as { data: { status: string } }).data.status).toBe(
      "STOPPED",
    );

    const open = await fetch(
      `${ctx.baseUrl}/api/admin/provider/open`,
      withAdminCookie(cookie, { method: "POST" }),
    );
    expect(open.status).toBe(200);
    expect(((await open.json()) as { data: { status: string } }).data.status).toBe("READY");

    const providerRestart = await fetch(
      `${ctx.baseUrl}/api/admin/provider/restart`,
      withAdminCookie(cookie, { method: "POST" }),
    );
    expect(providerRestart.status).toBe(200);

    const browserRestart = await fetch(
      `${ctx.baseUrl}/api/admin/browser/restart`,
      withAdminCookie(cookie, { method: "POST" }),
    );
    expect(browserRestart.status).toBe(200);
    expect(
      ((await browserRestart.json()) as { data: { state: string } }).data.state,
    ).toBe("RUNNING");
  });

  it("ADM-A02 兼容窗口已关闭:ADMIN 调旧路径一律 404,canonical 照常返回运维快照(§25/§58)", async () => {
    await mountAuthed();
    const cookie = await loginAdmin(ctx.baseUrl);

    for (const { method, path } of LEGACY_ENDPOINTS) {
      assertRetired(
        await fetch(
          `${ctx.baseUrl}${path}`,
          withAdminCookie(cookie, { method }),
        ),
      );
    }

    // 唯一挂载点仍然工作:canonical 给出运维字段,旧路径的缺失不是路由整体失效
    const canonicalBrowser = await fetch(
      `${ctx.baseUrl}/api/admin/browser/status`,
      withAdminCookie(cookie),
    );
    expect(canonicalBrowser.status).toBe(200);
    const snapshot = ((await canonicalBrowser.json()) as {
      data: Record<string, unknown>;
    }).data;
    expect(snapshot).toHaveProperty("profileDir");
    expect(snapshot).toHaveProperty("providerLoggedIn");
  });

  it("ADM-A03 ADMIN 的 HTTP 错误信封保留原始运维码(§32「原正常行为」)", async () => {
    await mountAuthed();
    const cookie = await loginAdmin(ctx.baseUrl);
    // 登录后再注入启动故障:运维端点必须还能区分「启动崩了」这一具体原因
    driver.throwOnLaunch = new Error("crash in launch");

    const res = await fetch(
      `${ctx.baseUrl}/api/admin/browser/restart`,
      withAdminCookie(cookie, { method: "POST" }),
    );
    expect(res.status).toBe(500);
    // 对照 §17:同一个码出现在 Public 面时会被映射成 CHAT_FAILED
    expect(await errorCodeOf(res)).toBe(ErrorCodes.BROWSER_LAUNCH_FAILED);
  });

  it("ADM-P01 GET /api/provider/models 对匿名用户保持 Public(§24/§33)", async () => {
    await mountAuthed();
    // 先用 ADMIN 把 Provider 置 READY(运维准备是管理员的事)
    const admin = await loginAdmin(ctx.baseUrl);
    const opened = await fetch(
      `${ctx.baseUrl}/api/admin/provider/open`,
      withAdminCookie(admin, { method: "POST" }),
    );
    expect(((await opened.json()) as { data: { status: string } }).data.status).toBe("READY");

    // 匿名聊天用户随后读模型目录:必须是 Public 能力,不是 403
    const anon = await loginAnonymous(ctx.baseUrl);
    const res = await fetch(`${ctx.baseUrl}/api/provider/models`, withAdminCookie(anon));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { models: unknown[] } };
    expect(body.data.models.length).toBeGreaterThan(0);
  });

  it("ADM-O01 ADMIN 不获得任何 ownership 旁路:看不到匿名用户的会话(§34)", async () => {
    await mountAuthed();
    const anon = await loginAnonymous(ctx.baseUrl);
    const admin = await loginAdmin(ctx.baseUrl);

    const created = await (
      await fetch(
        `${ctx.baseUrl}/api/conversations`,
        withAdminCookie(anon, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "匿名私有会话" }),
        }),
      )
    ).json() as { data: { id: string } };

    const adminList = (await (
      await fetch(`${ctx.baseUrl}/api/conversations`, withAdminCookie(admin))
    ).json()) as { data: Array<{ id: string }> };
    expect(adminList.data.map((c) => c.id)).not.toContain(created.data.id);

    const stolen = await fetch(
      `${ctx.baseUrl}/api/conversations/${created.data.id}`,
      withAdminCookie(admin),
    );
    expect(stolen.status).toBe(404);
  });

  it("ADM-R01 revoke-all:只删 ADMIN 全部 Session(含当前),匿名 Session 不动(§29/§31)", async () => {
    await mountAuthed();
    const adminA = await loginAdmin(ctx.baseUrl);
    const adminB = await loginAdmin(ctx.baseUrl);
    const anonC = await loginAnonymous(ctx.baseUrl);

    expect(await ctx.prisma.session.count()).toBe(3);

    const res = await fetch(
      `${ctx.baseUrl}/api/admin/sessions/revoke-all`,
      withAdminCookie(adminA, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { revoked: number } }).data.revoked).toBe(2);

    // §29:成功响应必须清 Cookie(Max-Age=0),同名同 Path
    const cleared = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Max-Age=0");

    // A/B 两个 ADMIN Session 都已失效,C 仍可用
    for (const cookie of [adminA, adminB]) {
      const after = await fetch(
        `${ctx.baseUrl}/api/conversations`,
        withAdminCookie(cookie),
      );
      expect(after.status).toBe(401);
    }
    const anonStillWorks = await fetch(
      `${ctx.baseUrl}/api/conversations`,
      withAdminCookie(anonC),
    );
    expect(anonStillWorks.status).toBe(200);

    expect(await ctx.prisma.session.count({ where: { userId: ADMIN_USER_ID } })).toBe(0);
    expect(await ctx.prisma.session.count()).toBe(1);
  });

  it("ADM-R02 删库失败 ⇒ 既不假装成功,也不单独清 Cookie(§30)", async () => {
    await mountAuthed();
    const admin = await loginAdmin(ctx.baseUrl);
    const sessions = ctx.authSessions;
    if (sessions === null) {
      throw new Error("auth session runtime is expected in AUTH_ENABLED mode");
    }
    const failure = vi
      .spyOn(sessions, "revokeAllForUser")
      .mockRejectedValue(new Error("database unavailable"));

    const res = await fetch(
      `${ctx.baseUrl}/api/admin/sessions/revoke-all`,
      withAdminCookie(admin, { method: "POST" }),
    );
    expect(res.status).toBe(500);
    // 该端点只有 ADMIN 能到达,按 §32 保留原始码;Public 面的映射由错误专项测试覆盖
    expect(await errorCodeOf(res)).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(
      res.headers.getSetCookie().filter((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`)),
    ).toHaveLength(0);
    expect(failure).toHaveBeenCalledTimes(1);
    failure.mockRestore();

    // Session 还在:调用者身份不受一次失败的吊销影响
    const stillWorks = await fetch(`${ctx.baseUrl}/api/conversations`, withAdminCookie(admin));
    expect(stillWorks.status).toBe(200);
    expect(await ctx.prisma.session.count({ where: { userId: ADMIN_USER_ID } })).toBe(1);
  });
});
