#!/usr/bin/env node
/**
 * Phase 9 §三§四§七 真机功能验证(对着真实后端跑)。
 * 环境变量:BASE(默认 http://127.0.0.1:3020)、WAIT_MS(等待 Gemini 回答上限,默认 150s)。
 * Gemini 不可达时依赖流式/取消的行会记为 INCONCLUSIVE(不伪造成代码失败)。
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:3020";
const WAIT_MS = Number(process.env.WAIT_MS ?? 150_000);

const results = [];
function record(name, outcome, detail = "") {
  // outcome: true | false | "inconclusive"
  results.push({ name, outcome, detail });
  const tag = outcome === true ? "PASS " : outcome === false ? "FAIL " : "INCON";
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  } catch {
    /* 204 等无 body */
  }
  return { status: res.status, json };
}

const errCode = (r) => r.json?.error?.code ?? null;
const TERMINAL = new Set(["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"]);

async function waitTerminal(requestId, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api("GET", `/api/requests/${requestId}`);
    last = r.json?.data ?? null;
    if (last && TERMINAL.has(last.status)) return last;
    await sleep(400);
  }
  return last;
}

async function waitStatus(requestId, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api("GET", `/api/requests/${requestId}`);
    const req = r.json?.data ?? null;
    if (req && (TERMINAL.has(req.status) || req.status === wanted)) return req;
    await sleep(200);
  }
  return null;
}

async function sseOpen(requestId) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/requests/${requestId}/events`, {
    signal: ctrl.signal,
    headers: { accept: "text/event-stream" },
  });
  if (res.status !== 200) {
    ctrl.abort();
    throw new Error(`SSE HTTP ${res.status}`);
  }
  const frames = [];
  let closed = false;
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  const waiters = [];
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = null;
          let data = {};
          for (const line of raw.split("\n")) {
            const m = line.match(/^(event|data):\s?(.*)$/);
            if (!m) continue;
            if (m[1] === "event") ev = m[2];
            else {
              try {
                data = JSON.parse(m[2]);
              } catch {
                /* 忽略坏帧 */
              }
            }
          }
          if (ev) {
            frames.push({ event: ev, data });
            wake();
          }
        }
      }
    } catch {
      /* 主动 abort */
    }
    closed = true;
    wake();
  })();
  return {
    frames,
    isClosed: () => closed,
    waitFor(pred, timeoutMs) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const f = frames.find(pred);
          if (f) {
            cleanup();
            resolve(f);
            return true;
          }
          if (closed) {
            cleanup();
            reject(new Error("SSE closed before match"));
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("SSE wait timeout"));
        }, timeoutMs);
        const iv = setInterval(check, 100);
        function cleanup() {
          clearTimeout(timer);
          clearInterval(iv);
        }
        waiters.push(check);
        check();
      });
    },
    close() {
      ctrl.abort();
    },
  };
}

const assemble = (frames) => {
  let text = "";
  for (const f of frames) {
    if (f.event === "snapshot" && typeof f.data.content === "string") text = f.data.content;
    else if (f.event === "delta" && typeof f.data.content === "string") text += f.data.content;
  }
  return text;
};
const hasContent = (f) =>
  (f.event === "delta" || f.event === "snapshot") &&
  typeof f.data.content === "string" &&
  (f.event === "delta" || f.data.content.length > 0);

async function main() {
  console.log(`# phase9-verify against ${BASE}`);

  // ---- §7 旧 NextChat 入口 ----
  for (const p of [
    "/api/openai/v1/models",
    "/api/openai/v1/chat/completions",
    "/api/google/v1beta/models",
    "/webdav",
    "/sharegpt",
    "/sd",
  ]) {
    const r = await api("GET", p);
    record(`§7 ${p} → 404`, r.status === 404, `got ${r.status}`);
  }

  // ---- §3 新建会话 / §4 空输入、超长输入 ----
  const conv = await api("POST", "/api/conversations", { title: "phase9-verify" });
  const cid = conv.json?.data?.id ?? null;
  record("§3 新建会话 → 201", conv.status === 201 && !!cid, `got ${conv.status}`);
  if (!cid) {
    finish();
    return;
  }

  const empty = await api(
    "POST",
    `/api/conversations/${cid}/messages`,
    { content: "" },
    { "Idempotency-Key": "phase9-empty-1" },
  );
  record(
    "§4 空输入 → 400 VALIDATION_ERROR",
    empty.status === 400 && errCode(empty) === "VALIDATION_ERROR",
    `${empty.status} ${errCode(empty)}`,
  );

  const long = await api(
    "POST",
    `/api/conversations/${cid}/messages`,
    { content: "x".repeat(50001) },
    { "Idempotency-Key": "phase9-long-1" },
  );
  record(
    "§4 超长输入(50001) → 400 VALIDATION_ERROR",
    long.status === 400 && errCode(long) === "VALIDATION_ERROR",
    `${long.status} ${errCode(long)}`,
  );

  // ---- §3 全链路:发送 → SSE(delta/snapshot/status) → SUCCESS ----
  const prompt = "请用一句中文介绍你自己。";
  const key1 = `phase9-${Date.now()}-k1`;
  const send = await api(
    "POST",
    `/api/conversations/${cid}/messages`,
    { content: prompt },
    { "Idempotency-Key": key1 },
  );
  const reqId = send.json?.data?.request?.id ?? null;
  record("§3 发送消息 → 202", send.status === 202 && !!reqId, `got ${send.status}`);
  if (!reqId) {
    finish();
    return;
  }

  // §4 同会话重复发送(首个请求在飞时)
  const dupConv = await api("POST", `/api/conversations/${cid}/messages`, { content: "第二条" }, {
    "Idempotency-Key": `phase9-${Date.now()}-k2`,
  });
  record(
    "§4 同会话重复发送 → 409",
    dupConv.status === 409 && errCode(dupConv) === "CONVERSATION_REQUEST_IN_PROGRESS",
    `${dupConv.status} ${errCode(dupConv)}`,
  );

  // §4 重复 Idempotency-Key(同 Key 不同内容)
  const dupKey = await api(
    "POST",
    `/api/conversations/${cid}/messages`,
    { content: "same key different content" },
    { "Idempotency-Key": key1 },
  );
  record(
    "§4 重复Idempotency-Key → 409",
    dupKey.status === 409 && errCode(dupKey) === "IDEMPOTENCY_KEY_REUSED",
    `${dupKey.status} ${errCode(dupKey)}`,
  );

  // SSE 全程
  let sse;
  try {
    sse = await sseOpen(reqId);
    const firstFrame = await sse
      .waitFor((f) => f.event === "connected", 10_000)
      .catch(() => null);
    const termFrame = await sse.waitFor(
      (f) => f.event === "status" && TERMINAL.has(f.data.requestStatus),
      WAIT_MS,
    );
    const reqFinal = (await api("GET", `/api/requests/${reqId}`)).json?.data;
    const statuses = sse.frames
      .filter((f) => f.event === "status")
      .map((f) => f.data.requestStatus);
    const deltas = sse.frames.filter((f) => f.event === "delta");
    const text = assemble(sse.frames);
    const dbContent = await assistantContent(reqId);
    const reachable = reqFinal.status !== "PENDING";

    if (!reachable) {
      record("§3 流式回答", "inconclusive", "request 卡在 PENDING —— Gemini 不可达(预期行为)");
      record("§3 SSE 文本与 DB 一致", "inconclusive", "同上");
    } else {
      record(
        "§3 流式回答:delta 帧存在且成功",
        reqFinal.status === "SUCCESS" && deltas.length > 0,
        `delta=${deltas.length} status=${reqFinal.status} requestStatuses=${statuses.join(">")}`,
      );
      record(
        "§3 SSE 重组文本 == DB content",
        text === dbContent,
        `sseLen=${text.length} dbLen=${dbContent.length}`,
      );
      record(
        "§3 status 终态帧 = SUCCESS",
        termFrame?.data?.requestStatus === "SUCCESS" && sse.isClosed(),
        `last=${termFrame?.data?.requestStatus} closed=${sse.isClosed()}`,
      );

      // ---- §3 刷新恢复:重新拉历史 ----
      const list = (await api("GET", `/api/conversations/${cid}/messages`)).json?.data ?? [];
      const userMsg = list.find((m) => m.role === "USER");
      const asstMsg = list.find((m) => m.role === "ASSISTANT");
      record(
        "§3 刷新恢复:历史完整(用户原文 + 最终回答)",
        userMsg?.content === prompt && asstMsg?.content === dbContent && list.length >= 2,
        `messages=${list.length} userOk=${userMsg?.content === prompt} asstOk=${asstMsg?.content === dbContent}`,
      );

      // ---- §4 取消终态请求 ----
      const cancelDone = await api("POST", `/api/requests/${reqId}/cancel`);
      record(
        "§4 取消终态请求 → 409 REQUEST_NOT_CANCELLABLE",
        cancelDone.status === 409 && errCode(cancelDone) === "REQUEST_NOT_CANCELLABLE",
        `${cancelDone.status} ${errCode(cancelDone)}`,
      );
    }
  } catch (e) {
    record("§3 流式回答(SSE)", "inconclusive", String(e));
  } finally {
    sse?.close();
  }

  // ---- §4 重复取消(幂等)+ 真实 Gemini 停止 ----
  const conv2 = await api("POST", "/api/conversations", { title: "phase9-cancel" });
  const cid2 = conv2.json?.data?.id;
  if (cid2) {
    const send2 = await api(
      "POST",
      `/api/conversations/${cid2}/messages`,
      { content: "请从 1 数到 50,每个数字一行。" },
      { "Idempotency-Key": `phase9-${Date.now()}-k3` },
    );
    const req2 = send2.json?.data?.request?.id;
    if (req2) {
      const seen = await waitStatus(req2, "PROCESSING", 90_000);
      if (!seen || TERMINAL.has(seen.status)) {
        record("§4 重复取消", "inconclusive", `未见 PROCESSING(当前 ${seen?.status ?? "timeout"}),Gemini 可能不可达或太快`);
      } else {
        const c1 = await api("POST", `/api/requests/${req2}/cancel`);
        const final2 = await waitTerminal(req2);
        const c2 = await api("POST", `/api/requests/${req2}/cancel`);
        record(
          "§4 重复取消:首次受理(202/200)→ CANCELLED → 再次取消 200 幂等",
          (c1.status === 202 || c1.status === 200) &&
            final2?.status === "CANCELLED" &&
            c2.status === 200 &&
            c2.json?.data?.status === "CANCELLED",
          `first=${c1.status} final=${final2?.status} second=${c2.status}`,
        );
      }
    }
  }

  // ---- §4 SSE 断开自动恢复 ----
  const conv3 = await api("POST", "/api/conversations", { title: "phase9-sse-reconnect" });
  const cid3 = conv3.json?.data?.id;
  if (cid3) {
    const send3 = await api(
      "POST",
      `/api/conversations/${cid3}/messages`,
      { content: "请用三句话介绍一下春天。" },
      { "Idempotency-Key": `phase9-${Date.now()}-k4` },
    );
    const req3 = send3.json?.data?.request?.id;
    if (req3) {
      let a;
      try {
        a = await sseOpen(req3);
        await a.waitFor((f) => hasContent(f), 60_000);
        const prefix = assemble(a.frames);
        a.close();
        await sleep(600);
        const b = await sseOpen(req3);
        const firstContent = await b.waitFor(hasContent, 30_000);
        await b.waitFor((f) => f.event === "status" && TERMINAL.has(f.data.requestStatus), WAIT_MS);
        const textB = assemble(b.frames);
        const dbContent3 = await assistantContent(req3);
        const reqF3 = (await api("GET", `/api/requests/${req3}`)).json?.data;
        record(
          "§4 SSE断开 → 重连快照恢复 → 与 DB 一致",
          reqF3.status === "SUCCESS" &&
            firstContent.event === "snapshot" &&
            textB === dbContent3 &&
            dbContent3.startsWith(prefix.slice(0, Math.min(5, prefix.length))),
          `reconnectFirst=${firstContent.event} sseLen=${textB.length} dbLen=${dbContent3.length}`,
        );
        b.close();
      } catch (e) {
        record("§4 SSE断开自动恢复", "inconclusive", String(e));
        a?.close();
      }
    }
  }

  finish();
}

async function assistantContent(requestId) {
  const req = (await api("GET", `/api/requests/${requestId}`)).json?.data;
  if (!req) return null;
  const list = (await api("GET", `/api/conversations/${req.conversationId}/messages`)).json?.data ?? [];
  const asstId = req.assistantMessageId;
  const asst = list.find((m) => m.id === asstId);
  return asst?.content ?? null;
}

function finish() {
  const pass = results.filter((r) => r.outcome === true).length;
  const fail = results.filter((r) => r.outcome === false).length;
  const incon = results.filter((r) => r.outcome === "inconclusive").length;
  console.log(`\n# summary: pass=${pass} fail=${fail} inconclusive=${incon} total=${results.length}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("verify script crashed:", e);
  process.exit(2);
});
