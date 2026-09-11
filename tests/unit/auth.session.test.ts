import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import { ADMIN_USER_ID } from "../../src/config/constants.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { AuthSessionRepository } from "../../src/modules/auth/auth.session.repository.js";
import { AuthSessionService } from "../../src/modules/auth/auth.session.service.js";
import {
  generateSessionToken,
  hashSessionToken,
  parseSessionToken,
} from "../../src/modules/auth/auth.session-token.js";
import { AuthUserRepository } from "../../src/modules/auth/auth.user.repository.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const TTL_ANON = 7200;
const TTL_ADMIN = 3600;
const TOUCH_INTERVAL = 60;

function createHarness(overrides?: { now?: Date }) {
  const sessions = {
    findByTokenHash: vi.fn(),
    create: vi.fn(),
    deleteByTokenHash: vi.fn(),
    deleteById: vi.fn(),
    deleteExpired: vi.fn(),
    touchIfDue: vi.fn(),
  };
  const users = { findById: vi.fn(), createAnonymous: vi.fn() };
  // tx 单独持有:断言"删除旧 Session + 创建新 Session"都走同一事务客户端(FIX-01)
  const tx = { kind: "tx" };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
  const service = new AuthSessionService({
    prisma: prisma as unknown as PrismaClient,
    sessions: sessions as unknown as AuthSessionRepository,
    users: users as unknown as AuthUserRepository,
    logger: createLogger("silent"),
    options: {
      ttlAnonymousSeconds: TTL_ANON,
      ttlAdminSeconds: TTL_ADMIN,
      touchIntervalSeconds: TOUCH_INTERVAL,
    },
    clock: () => overrides?.now ?? NOW,
  });
  return { service, sessions, users, prisma, tx };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    userId: "user-1",
    tokenHash: "hash",
    expiresAt: new Date(NOW.getTime() + TTL_ANON * 1000),
    lastSeenAt: NOW,
    createdAt: NOW,
    user: { id: "user-1", type: "ANONYMOUS", status: "ACTIVE" },
    ...overrides,
  };
}

describe("SESS-01/02/05 session token 工具(§5)", () => {
  it("SESS-01 generate:43 字符 base64url、无 '.'、解码恰 32 字节、每次不同", () => {
    const token = generateSessionToken();

    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(".");
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
  });

  it("SESS-02 hash:sha256 hex 确定性;不同 token 摘要不同", () => {
    const token = generateSessionToken();
    const expected = createHash("sha256").update(token, "utf8").digest("hex");

    expect(hashSessionToken(token)).toBe(expected);
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(hashSessionToken(generateSessionToken())).not.toBe(expected);
  });

  it("SESS-05 parse:HMAC 旧 token / 非法形态 / 长度异常一律 null(不抛错)", () => {
    expect(parseSessionToken(undefined)).toBeNull();
    expect(parseSessionToken("")).toBeNull();
    expect(parseSessionToken("nodot")).toBeNull();
    expect(parseSessionToken("aaa.bbb")).toBeNull();
    expect(parseSessionToken(`${"a".repeat(42)}+`)).toBeNull();
    expect(parseSessionToken(`${"a".repeat(42)}=`)).toBeNull();
    expect(parseSessionToken("a".repeat(44))).toBeNull();
    expect(parseSessionToken("a".repeat(1025))).toBeNull();

    const ok = generateSessionToken();
    expect(parseSessionToken(ok)).toBe(ok);
  });
});

describe("SESS-03/04 resolve:有效性判定与 DB 交互", () => {
  it("SESS-03 有效 Session → active(userId/type/sessionId/expiresAt)+ 只查摘要", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(sessionRow());
    const token = generateSessionToken();

    const result = await service.resolve(token, { touch: false });

    expect(result).toMatchObject({
      kind: "active",
      rawToken: token,
      ttlSeconds: TTL_ANON,
      renewed: false,
      auth: {
        userId: "user-1",
        userType: "ANONYMOUS",
        sessionId: "session-1",
      },
    });
    // 传给仓储的必须是摘要,绝不是 raw token
    expect(sessions.findByTokenHash).toHaveBeenCalledWith(expect.anything(), hashSessionToken(token));
  });

  it("SESS-04 非法 Cookie 形态 → none,且不发 DB 查询", async () => {
    const { service, sessions } = createHarness();

    for (const bad of [undefined, "", "nodot", "aaa.bbb", "a".repeat(1025)]) {
      expect((await service.resolve(bad, { touch: true })).kind).toBe("none");
    }
    expect(sessions.findByTokenHash).not.toHaveBeenCalled();
  });

  it("无此行 / 已过期 → none;DISABLED User → disabled", async () => {
    const { service, sessions } = createHarness();
    const token = generateSessionToken();

    sessions.findByTokenHash.mockResolvedValueOnce(null);
    expect((await service.resolve(token, { touch: false })).kind).toBe("none");

    sessions.findByTokenHash.mockResolvedValueOnce(
      sessionRow({ expiresAt: new Date(NOW.getTime() - 1000) }),
    );
    expect((await service.resolve(token, { touch: false })).kind).toBe("none");

    sessions.findByTokenHash.mockResolvedValueOnce(
      sessionRow({ user: { id: "user-1", type: "ANONYMOUS", status: "DISABLED" } }),
    );
    expect((await service.resolve(token, { touch: false })).kind).toBe("disabled");
  });

  it("Session 查询本身失败 → 向上抛(数据库异常不得伪装成未登录)", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockRejectedValue(new Error("db down"));

    await expect(service.resolve(generateSessionToken(), { touch: false })).rejects.toThrow(
      "db down",
    );
  });
});

describe("TOUCH-01..04 滑动续期 CAS(§13/§14)", () => {
  it("TOUCH-01 未达阈值 → 0 UPDATE 0 Set-Cookie(renewed=false)", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(sessionRow());

    const result = await service.resolve(generateSessionToken(), { touch: true });

    expect(result).toMatchObject({ kind: "active", renewed: false });
    expect(sessions.touchIfDue).not.toHaveBeenCalled();
    expect(result.kind === "active" && result.expiresAt.getTime()).toBe(
      NOW.getTime() + TTL_ANON * 1000,
    );
  });

  it("TOUCH-02 达阈值且 CAS=1 → renewed=true、expiresAt 按类型 TTL 延长", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(
      sessionRow({ lastSeenAt: new Date(NOW.getTime() - (TOUCH_INTERVAL + 60) * 1000) }),
    );
    sessions.touchIfDue.mockResolvedValue(1);

    const result = await service.resolve(generateSessionToken(), { touch: true });

    expect(sessions.touchIfDue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "session-1",
        cutoff: new Date(NOW.getTime() - TOUCH_INTERVAL * 1000),
        now: NOW,
        expiresAt: new Date(NOW.getTime() + TTL_ANON * 1000),
      }),
    );
    expect(result).toMatchObject({
      kind: "active",
      renewed: true,
      ttlSeconds: TTL_ANON,
      expiresAt: new Date(NOW.getTime() + TTL_ANON * 1000),
    });
  });

  it("TOUCH-02b ADMIN Session 用 ADMIN TTL 续期", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(
      sessionRow({
        lastSeenAt: new Date(NOW.getTime() - (TOUCH_INTERVAL + 60) * 1000),
        user: { id: ADMIN_USER_ID, type: "ADMIN", status: "ACTIVE" },
      }),
    );
    sessions.touchIfDue.mockResolvedValue(1);

    const result = await service.resolve(generateSessionToken(), { touch: true });

    expect(result).toMatchObject({
      kind: "active",
      renewed: true,
      ttlSeconds: TTL_ADMIN,
      expiresAt: new Date(NOW.getTime() + TTL_ADMIN * 1000),
    });
  });

  it("TOUCH-03 并发 CAS 输家(count=0)→ renewed=false,不延长", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(
      sessionRow({ lastSeenAt: new Date(NOW.getTime() - (TOUCH_INTERVAL + 60) * 1000) }),
    );
    sessions.touchIfDue.mockResolvedValue(0);

    const result = await service.resolve(generateSessionToken(), { touch: true });

    expect(result).toMatchObject({
      kind: "active",
      renewed: false,
      expiresAt: new Date(NOW.getTime() + TTL_ANON * 1000),
    });
  });

  it("TOUCH-04 续期写入失败 → fail-open:本次请求照常,renewed=false", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(
      sessionRow({ lastSeenAt: new Date(NOW.getTime() - (TOUCH_INTERVAL + 60) * 1000) }),
    );
    sessions.touchIfDue.mockRejectedValue(new Error("transient write failure"));

    const result = await service.resolve(generateSessionToken(), { touch: true });

    expect(result).toMatchObject({ kind: "active", renewed: false });
  });
});

describe("ANON-01..04 bootstrapAnonymous(§8)", () => {
  it("ANON-01 无 Cookie:User + Session 同事务创建,返回 created + 新 raw token", async () => {
    const { service, sessions, users, prisma } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(null);
    users.createAnonymous.mockResolvedValue({ id: "user-new" });
    sessions.create.mockImplementation(async (_db: unknown, data: { tokenHash: string }) => ({
      id: "session-new",
      ...data,
      user: { id: "user-new", type: "ANONYMOUS", status: "ACTIVE" },
    }));

    const result = await service.bootstrapAnonymous(undefined);

    expect(result.kind).toBe("created");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(users.createAnonymous).toHaveBeenCalledTimes(1);
    expect(sessions.create).toHaveBeenCalledTimes(1);
    if (result.kind !== "created") throw new Error("expected created");
    expect(parseSessionToken(result.rawToken)).toBe(result.rawToken);
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + TTL_ANON * 1000);
    // DB 只收到摘要,绝无 raw token
    const createArg = sessions.create.mock.calls[0]![1] as { tokenHash: string };
    expect(createArg.tokenHash).toBe(hashSessionToken(result.rawToken));
    expect(createArg.tokenHash).not.toBe(result.rawToken);
    expect(result.auth).toMatchObject({
      userId: "user-new",
      userType: "ANONYMOUS",
      sessionId: "session-new",
    });
  });

  it("ANON-02 已有有效 ANONYMOUS Session:幂等,不建行", async () => {
    const { service, sessions, users, prisma } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(sessionRow());
    const token = generateSessionToken();

    const result = await service.bootstrapAnonymous(token);

    expect(result).toMatchObject({ kind: "existing", expiresAt: expect.any(Date) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(users.createAnonymous).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("ANON-03 已有有效 ADMIN Session:幂等返回 ADMIN,不降级不覆盖", async () => {
    const { service, sessions } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(
      sessionRow({ user: { id: ADMIN_USER_ID, type: "ADMIN", status: "ACTIVE" } }),
    );

    const result = await service.bootstrapAnonymous(generateSessionToken());

    expect(result.kind).toBe("existing");
    if (result.kind !== "existing") throw new Error("expected existing");
    expect(result.auth.userType).toBe("ADMIN");
    expect(result.auth.userId).toBe(ADMIN_USER_ID);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("ANON-04 Cookie 指向 DISABLED User → disabled,不新建不覆盖", async () => {
    const { service, sessions, users } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(
      sessionRow({ user: { id: "user-1", type: "ANONYMOUS", status: "DISABLED" } }),
    );

    const result = await service.bootstrapAnonymous(generateSessionToken());

    expect(result.kind).toBe("disabled");
    expect(users.createAnonymous).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe("LOGIN-01..03 loginAdmin(§10)", () => {
  it("LOGIN-01/03 事务内:读旧 Session → 按 id 删除 → 签 ADMIN 新 Session(轮换)", async () => {
    const { service, sessions, users, tx } = createHarness();
    sessions.findByTokenHash.mockResolvedValue({ id: "old-session" });
    sessions.deleteById.mockResolvedValue(1);
    users.findById.mockResolvedValue({ id: ADMIN_USER_ID, type: "ADMIN", status: "ACTIVE" });
    sessions.create.mockImplementation(async (_db: unknown, data: Record<string, unknown>) => ({
      id: "session-admin",
      ...data,
    }));
    const oldToken = generateSessionToken();

    const issued = await service.loginAdmin(oldToken);

    // FIX-01:删除与创建都必须走同一事务客户端
    expect(sessions.findByTokenHash).toHaveBeenCalledWith(tx, hashSessionToken(oldToken));
    expect(sessions.deleteById).toHaveBeenCalledWith(tx, "old-session");
    expect(sessions.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ userId: ADMIN_USER_ID }),
    );
    expect(users.findById).toHaveBeenCalledWith(expect.anything(), ADMIN_USER_ID);
    expect(issued.auth).toMatchObject({
      userId: ADMIN_USER_ID,
      userType: "ADMIN",
      sessionId: "session-admin",
    });
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + TTL_ADMIN * 1000);
    expect(parseSessionToken(issued.rawToken)).toBe(issued.rawToken);
  });

  it("无 Cookie 时不删任何 Session,仍然在事务内签 ADMIN 新 Session", async () => {
    const { service, sessions, users, tx } = createHarness();
    users.findById.mockResolvedValue({ id: ADMIN_USER_ID, type: "ADMIN", status: "ACTIVE" });
    sessions.create.mockResolvedValue({ id: "session-admin" });

    await service.loginAdmin(undefined);

    expect(sessions.findByTokenHash).not.toHaveBeenCalled();
    expect(sessions.deleteById).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledWith(tx, expect.objectContaining({}));
  });

  it("Cookie 形态合法但查不到旧行 → 不删,直接签新 Session", async () => {
    const { service, sessions, users } = createHarness();
    sessions.findByTokenHash.mockResolvedValue(null);
    users.findById.mockResolvedValue({ id: ADMIN_USER_ID, type: "ADMIN", status: "ACTIVE" });
    sessions.create.mockResolvedValue({ id: "session-admin" });

    await service.loginAdmin(generateSessionToken());

    expect(sessions.deleteById).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("固定 ADMIN User 缺失/被禁用 → INTERNAL_ERROR,且零写入(不开事务、不碰旧 Session)", async () => {
    const { service, sessions, users, prisma } = createHarness();
    users.findById.mockResolvedValue(null);

    await expect(service.loginAdmin(generateSessionToken())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    users.findById.mockResolvedValue({ id: ADMIN_USER_ID, type: "ADMIN", status: "DISABLED" });
    await expect(service.loginAdmin(generateSessionToken())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sessions.deleteById).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("FIX-01 事务内创建失败 → 向上抛(由事务整体回滚,调用方不 Set-Cookie)", async () => {
    const { service, sessions, users } = createHarness();
    users.findById.mockResolvedValue({ id: ADMIN_USER_ID, type: "ADMIN", status: "ACTIVE" });
    sessions.findByTokenHash.mockResolvedValue({ id: "old-session" });
    sessions.deleteById.mockResolvedValue(1);
    sessions.create.mockRejectedValue(new Error("session insert failed"));

    await expect(service.loginAdmin(generateSessionToken())).rejects.toThrow(
      "session insert failed",
    );
  });
});

describe("§12 logout / §19 sweep", () => {
  it("logout:非法 token 不查库;有效 token 删除并按命中返回 true", async () => {
    const { service, sessions } = createHarness();

    expect(await service.logout("aaa.bbb")).toBe(false);
    expect(sessions.deleteByTokenHash).not.toHaveBeenCalled();

    const token = generateSessionToken();
    sessions.deleteByTokenHash.mockResolvedValue(1);
    expect(await service.logout(token)).toBe(true);
    expect(sessions.deleteByTokenHash).toHaveBeenCalledWith(
      expect.anything(),
      hashSessionToken(token),
    );

    sessions.deleteByTokenHash.mockResolvedValue(0);
    expect(await service.logout(token)).toBe(false);
  });

  it("SWEEP-01 sweepExpired:只删过期行;失败只记日志返回 0,不上抛", async () => {
    const { service, sessions } = createHarness();

    sessions.deleteExpired.mockResolvedValue(3);
    expect(await service.sweepExpired()).toBe(3);
    expect(sessions.deleteExpired).toHaveBeenCalledWith(expect.anything(), NOW);

    sessions.deleteExpired.mockRejectedValue(new Error("db down"));
    await expect(service.sweepExpired()).resolves.toBe(0);
  });
});
