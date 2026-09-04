#!/usr/bin/env node
/** Phase 9 故障注入断言:
 *  send               → 新会话发长 Prompt,观察到 PROCESSING 后打印 requestId
 *  assert <id> <status> <errorCode> <watchSeconds>
 *                     → 等终态并断言;再额外观察 watchSeconds 确认无自动重发
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:3020";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

const TERMINAL = new Set(["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"]);

if (process.argv[2] === "send") {
  const conv = await api("POST", "/api/conversations", { title: `phase9-fault-${Date.now()}` });
  if (conv.status !== 201) {
    console.log(`RESULT FAIL: create conversation ${conv.status}`);
    process.exit(1);
  }
  const send = await api(
    "POST",
    `/api/conversations/${conv.json.data.id}/messages`,
    { content: "请写一篇 800 字的关于秋天的散文。" },
    { "Idempotency-Key": `phase9-fault-${Date.now()}` },
  );
  const reqId = send.json?.data?.request?.id;
  if (send.status !== 202 || !reqId) {
    console.log(`RESULT FAIL: send ${send.status}`);
    process.exit(1);
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const req = (await api("GET", `/api/requests/${reqId}`)).json?.data;
    if (req && (req.status === "PROCESSING" || TERMINAL.has(req.status))) {
      console.log(req.status === "PROCESSING" ? `REQID ${reqId}` : `RESULT INCONCLUSIVE: 直接进了 ${req.status}`);
      process.exit(req.status === "PROCESSING" ? 0 : 2);
    }
    await sleep(300);
  }
  console.log("RESULT INCONCLUSIVE: 等 PROCESSING 超时");
  process.exit(2);
}

if (process.argv[2] === "assert") {
  const reqId = process.argv[3];
  const wantStatus = process.argv[4];
  const wantCode = process.argv[5];
  const watchSec = process.argv[6];
  const deadline = Date.now() + 90_000;
  let req = null;
  while (Date.now() < deadline) {
    req = (await api("GET", `/api/requests/${reqId}`)).json?.data;
    if (req && TERMINAL.has(req.status)) break;
    await sleep(400);
  }
  const statusOk = req?.status === wantStatus;
  const codeOk = wantCode === "-" ? true : req?.errorCode === wantCode;
  console.log(`terminal: status=${req?.status} code=${req?.errorCode} attempts=${req?.attemptCount}`);

  let noResend = true;
  if (statusOk && codeOk && watchSec) {
    const until = Date.now() + Number(watchSec) * 1000;
    while (Date.now() < until) {
      const again = (await api("GET", `/api/requests/${reqId}`)).json?.data;
      if (again?.status !== wantStatus || (again?.attemptCount ?? 0) > (req?.attemptCount ?? 0)) {
        noResend = false;
        break;
      }
      await sleep(1000);
    }
    console.log(`watch ${watchSec}s: no-resend=${noResend}`);
  }
  const ok = statusOk && codeOk && noResend;
  console.log(`RESULT ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

console.log("usage: node phase9-fault-check.mjs send | assert <id> <status> <code> <watchSec>");
process.exit(64);
