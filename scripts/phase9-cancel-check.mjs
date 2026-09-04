#!/usr/bin/env node
/** Phase 9 §二/§四 真机取消复验:PROCESSING → cancel → CANCELLED → 重复取消 200 幂等。 */
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
async function waitStatus(requestId, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const req = (await api("GET", `/api/requests/${requestId}`)).json?.data;
    if (req && (TERMINAL.has(req.status) || pred(req))) return req;
    await sleep(300);
  }
  return null;
}

const conv = await api("POST", "/api/conversations", { title: "phase9-cancel-recheck" });
const cid = conv.json.data.id;
const send = await api(
  "POST",
  `/api/conversations/${cid}/messages`,
  { content: "请从 1 数到 50,每个数字一行。" },
  { "Idempotency-Key": `phase9-cancel-${Date.now()}` },
);
const reqId = send.json.data.request.id;
console.log("request:", reqId);

const inFlight = await waitStatus(reqId, (r) => r.status === "PROCESSING", 120_000);
if (!inFlight || TERMINAL.has(inFlight.status)) {
  console.log(`RESULT INCONCLUSIVE: 未见 PROCESSING(当前 ${inFlight?.status ?? "timeout"})`);
  process.exit(2);
}
console.log("observed PROCESSING, cancelling…");
const c1 = await api("POST", `/api/requests/${reqId}/cancel`);
const deadline = Date.now() + 60_000;
let final = null;
while (Date.now() < deadline) {
  final = (await api("GET", `/api/requests/${reqId}`)).json?.data;
  if (final && TERMINAL.has(final.status)) break;
  await sleep(400);
}
const c2 = await api("POST", `/api/requests/${reqId}/cancel`);

const ok =
  (c1.status === 202 || c1.status === 200) &&
  final?.status === "CANCELLED" &&
  c2.status === 200 &&
  c2.json?.data?.status === "CANCELLED";
console.log(
  `RESULT ${ok ? "PASS" : "FAIL"}: first=${c1.status} final=${final?.status}/${final?.errorCode ?? "-"} second=${c2.status}`,
);
process.exit(ok ? 0 : 1);
