import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { createPrismaClient } from "../src/database/prisma.js";
import { AUTH_COOKIE_NAME } from "../src/config/constants.js";
import { hashSessionToken } from "../src/modules/auth/auth.session-token.js";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://127.0.0.1:3000";
const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const HELLO = "V16_E2E_HELLO";
const REPLY = "V16_E2E_REPLY";

type ApiResult = { status: number; body: unknown };

async function call(page: Page, path: string, init: RequestInit = {}): Promise<ApiResult> {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw.length === 0 ? null : JSON.parse(raw);
    } catch {
      body = raw;
    }
    return { status: response.status, body };
  }, { path, init });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function data(result: ApiResult): Record<string, any> {
  return (result.body as { data?: Record<string, any> })?.data ?? {};
}

async function sessionToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(FRONTEND_ORIGIN)).find(
    (item) => item.name === AUTH_COOKIE_NAME,
  );
  assert(cookie?.value, "browser session cookie missing");
  return cookie.value;
}

async function dbUserId(prisma: Awaited<ReturnType<typeof createPrismaClient>>, token: string) {
  const row = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { userId: true },
  });
  assert(row?.userId, "session is not present in the isolated database");
  return row.userId;
}

async function submitRegister(page: Page, username: string): Promise<void> {
  await page.locator("#register-username").fill(username);
  await page.locator("#register-password").fill(PASSWORD);
  await page.locator("#register-confirm").fill(PASSWORD);
  await page.locator("button[type=submit]").click();
  await page.waitForURL(`${FRONTEND_ORIGIN}/`, { timeout: 15_000 });
}

async function submitLogin(page: Page, username: string): Promise<void> {
  await page.locator("#login-username").fill(username);
  await page.locator("#login-password").fill(PASSWORD);
  await page.locator("button[type=submit]").click();
  await page.waitForURL(`${FRONTEND_ORIGIN}/`, { timeout: 15_000 });
}

async function main(): Promise<void> {
  assert(process.env.NODE_ENV === "test", "fake-provider E2E requires NODE_ENV=test");
  assert(process.env.E2E_FAKE_PROVIDER === "true", "fake-provider E2E requires E2E_FAKE_PROVIDER=true");
  assert(DATABASE_URL, "DATABASE_URL is required for database assertions");
  assert(PASSWORD && PASSWORD.length >= 12, "E2E_TEST_PASSWORD must be at least 12 characters");

  const browser = await chromium.launch({ headless: true });
  const prisma = await createPrismaClient(DATABASE_URL);
  const contextA = await browser.newContext({ locale: "zh-CN" });
  const pageA = await contextA.newPage();

  try {
    const username = `v16e2e${Date.now().toString(36)}`;
    await pageA.goto(`${FRONTEND_ORIGIN}/`, { waitUntil: "networkidle" });
    await pageA.waitForSelector("#chat-input");
    const anonymousSession = await call(pageA, "/backend-api/auth/session");
    assert(data(anonymousSession).authenticated === true, "home did not obtain an anonymous session");
    assert(data(anonymousSession).userType === "ANONYMOUS", "home identity is not ANONYMOUS");

    const anonymousToken = await sessionToken(contextA);
    const anonymousUserId = await dbUserId(prisma, anonymousToken);

    await pageA.locator("#chat-input").fill(HELLO);
    const sendButton = pageA.getByRole("button", { name: /发送|Send/ });
    assert((await sendButton.count()) > 0, "chat send button missing");
    await sendButton.last().click();
    await pageA.getByText(REPLY, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });

    const conversations = await prisma.conversation.findMany({
      where: { userId: anonymousUserId },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const conversation = conversations[0];
    assert(conversation, "chat did not create a conversation");
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { position: "asc" },
    });
    assert(messages.some((message) => message.content === HELLO), "user message was not stored");
    assert(messages.some((message) => message.content === REPLY), "fake provider reply was not stored");
    assert(conversation.providerConversationUrl?.startsWith("https://fake-provider.invalid/app/"), "fake provider URL missing");

    await pageA.goto(`${FRONTEND_ORIGIN}/register`, { waitUntil: "networkidle" });
    await pageA.waitForSelector("#register-username");
    assert(!(await pageA.locator("body").innerText()).includes("当前站点未开放账号功能"), "legacy disabled text remains");
    await submitRegister(pageA, username);

    const registeredSession = await call(pageA, "/backend-api/auth/session");
    assert(data(registeredSession).userType === "REGISTERED", "registration did not produce REGISTERED session");
    assert(!Object.prototype.hasOwnProperty.call(data(registeredSession), "userId"), "public session leaked userId");
    const rotatedToken = await sessionToken(contextA);
    assert(rotatedToken !== anonymousToken, "session token did not rotate");
    assert(await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(anonymousToken) } }) === null, "old anonymous token remains valid");
    const registeredUser = await prisma.user.findUnique({ where: { id: anonymousUserId } });
    assert(registeredUser?.type === "REGISTERED", "database user type did not upgrade");

    const secondRegister = await call(pageA, "/backend-api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: username + "2", password: PASSWORD }),
    });
    assert(secondRegister.status === 409, "REGISTERED user was allowed to register again");

    await pageA.goto(`${FRONTEND_ORIGIN}/`, { waitUntil: "networkidle" });
    assert((await pageA.locator("body").innerText()).includes(HELLO), "user message disappeared after registration");
    assert((await pageA.locator("body").innerText()).includes(REPLY), "assistant reply disappeared after registration");
    await pageA.reload({ waitUntil: "networkidle" });
    const refreshedSession = await call(pageA, "/backend-api/auth/session");
    assert(data(refreshedSession).userType === "REGISTERED", "refresh lost registered identity");
    assert((await pageA.locator("body").innerText()).includes(REPLY), "history disappeared after refresh");

    const contextB = await browser.newContext({ locale: "zh-CN" });
    const pageB = await contextB.newPage();
    try {
      await pageB.goto(`${FRONTEND_ORIGIN}/`, { waitUntil: "networkidle" });
      await pageB.waitForSelector("#chat-input");
      const bSession = await call(pageB, "/backend-api/auth/session");
      assert(data(bSession).userType === "ANONYMOUS", "second context is not independent anonymous identity");
      for (const result of [
        await call(pageB, `/backend-api/conversations/${conversation.id}`),
        await call(pageB, `/backend-api/conversations/${conversation.id}/messages?limit=50`),
        await call(pageB, `/backend-api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify({ title: "tamper" }) }),
        await call(pageB, `/backend-api/conversations/${conversation.id}/messages`, { method: "POST", headers: { "Idempotency-Key": `b-${Date.now()}` }, body: JSON.stringify({ content: "replay" }) }),
      ]) {
        assert(result.status === 404, `cross-context ownership was not rejected: ${result.status}`);
      }
    } finally {
      await contextB.close();
    }

    const contextC = await browser.newContext({ locale: "zh-CN" });
    const pageC1 = await contextC.newPage();
    const pageC2 = await contextC.newPage();
    try {
      const usernameC = `v16tab${Date.now().toString(36)}`;
      await pageC1.goto(`${FRONTEND_ORIGIN}/register`, { waitUntil: "networkidle" });
      await pageC1.waitForSelector("#register-username");
      await pageC2.goto(`${FRONTEND_ORIGIN}/`, { waitUntil: "networkidle" });
      const tabOldToken = await sessionToken(contextC);
      await submitRegister(pageC1, usernameC);
      const tabNewToken = await sessionToken(contextC);
      assert(tabNewToken !== tabOldToken, "multi-tab registration did not rotate cookie");
      assert(await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(tabOldToken) } }) === null, "multi-tab old token remains valid");
      await pageC2.reload({ waitUntil: "networkidle" });
      const tab2Session = await call(pageC2, "/backend-api/auth/session");
      assert(data(tab2Session).userType === "REGISTERED", "second tab retained stale anonymous identity");
    } finally {
      await contextC.close();
    }

    const invalidContext = await browser.newContext();
    const invalidPage = await invalidContext.newPage();
    try {
      await invalidContext.addCookies([{ name: AUTH_COOKIE_NAME, value: "invalid", url: FRONTEND_ORIGIN, httpOnly: true, sameSite: "Lax" }]);
      await invalidPage.goto(`${FRONTEND_ORIGIN}/login`, { waitUntil: "networkidle" });
      const invalidResult = await call(invalidPage, `/backend-api/conversations/${conversation.id}`);
      assert(invalidResult.status === 401, `invalid session was not rejected: ${invalidResult.status}`);
    } finally {
      await invalidContext.close();
    }

    await pageA.goto(`${FRONTEND_ORIGIN}/`, { waitUntil: "networkidle" });
    await pageA.getByLabel("设置").click();
    await pageA.getByRole("button", { name: "退出", exact: true }).click();
    await pageA.waitForURL(`${FRONTEND_ORIGIN}/`, { timeout: 15_000 });
    const afterLogout = await call(pageA, "/backend-api/auth/session");
    assert(data(afterLogout).authenticated === false, "logout did not revoke current session");

    const revokedContext = await browser.newContext();
    const revokedPage = await revokedContext.newPage();
    try {
      await revokedContext.addCookies([{ name: AUTH_COOKIE_NAME, value: rotatedToken, url: FRONTEND_ORIGIN, httpOnly: true, sameSite: "Lax" }]);
      await revokedPage.goto(`${FRONTEND_ORIGIN}/login`, { waitUntil: "networkidle" });
      const revokedResult = await call(revokedPage, `/backend-api/conversations/${conversation.id}`);
      assert(revokedResult.status === 401, `revoked registered session was not rejected: ${revokedResult.status}`);
    } finally {
      await revokedContext.close();
    }

    await pageA.goto(`${FRONTEND_ORIGIN}/login`, { waitUntil: "networkidle" });
    await pageA.waitForSelector("#login-username");
    await submitLogin(pageA, username);
    const afterLogin = await call(pageA, "/backend-api/auth/session");
    assert(data(afterLogin).userType === "REGISTERED", "re-login did not restore REGISTERED identity");
    const reloadedConversation = await call(pageA, `/backend-api/conversations/${conversation.id}`);
    assert(reloadedConversation.status === 200, `re-login could not read preserved conversation: ${reloadedConversation.status}`);
    if (!(await pageA.locator("body").innerText()).includes(REPLY)) {
      const historyEntry = pageA.getByText(HELLO, { exact: true });
      assert((await historyEntry.count()) > 0, "preserved conversation was not listed after re-login");
      await historyEntry.last().click();
      await pageA.getByText(REPLY, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    }
    assert((await pageA.locator("body").innerText()).includes(REPLY), "history disappeared after re-login");

    console.log(JSON.stringify({
      ok: true,
      anonymousToRegistered: true,
      messageRoundTrip: true,
      providerReply: REPLY,
      userIdContinuity: true,
      sessionRotation: true,
      refresh: true,
      logout: true,
      login: true,
      history: true,
      crossContextOwnership: true,
      multiTab: true,
      invalidSession: true,
      revokedSession: true,
      externalProvider: "NOT_CONTACTED",
    }));
  } finally {
    await contextA.close();
    await prisma.$disconnect();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
