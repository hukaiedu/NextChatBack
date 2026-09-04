#!/usr/bin/env node
/**
 * Phase 9 §五 长时间运行测试(默认 1 小时)。
 * 每轮:新建会话 → 发送 → SSE 订阅至终态 → 采样指标(后端 RSS、Chromium 进程数、DB 大小、ESTABLISHED 连接数)。
 * 环境变量:
 *   BASE=http://127.0.0.1:3020
 *   SERVER_PID=后端 node 进程 PID(RSS 采样用)
 *   DB_PATH=SQLite 文件路径
 *   PROFILE_MARKER=Chromium 命令行里的 profile 目录片段(默认 browser-profile)
 *   DURATION_MIN=运行分钟数(默认 60)
 *   GAP_MS=轮间隔毫秒(默认 20000)
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BASE = process.env.BASE ?? "http://127.0.0.1:3020";
const SERVER_PID = process.env.SERVER_PID ?? "";
const DB_PATH = process.env.DB_PATH ?? "";
const PROFILE_MARKER = process.env.PROFILE_MARKER ?? "browser-profile";
const DURATION_MS = Number(process.env.DURATION_MIN ?? 60) * 60_000;
const GAP_MS = Number(process.env.GAP_MS ?? 20_000);

const samples = [];
let cycles = { ok: 0, fail: 0 };
const errors = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ps(cmd) {
  try {
    const { stdout } = await exec("powershell", ["-NoProfile", "-Command", cmd], {
      timeout: 15_000,
    });
    return stdout.trim();
  } catch (e) {
    return "";
  }
}

async function rssOf(pid) {
  if (!pid) return null;
  const out = await ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`);
  return Number(out) || null;
}

async function chromiumCount() {
  const out = await ps(
    `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE_MARKER}*' }).Count`,
  );
  return Number(out) || 0;
}

function dbSize() {
  try {
    return statSync(DB_PATH).size;
  } catch {
    return null;
  }
}

async function establishedCount() {
  const port = new URL(BASE).port;
  const out = await ps(
    `@(Get-NetTCPConnection -LocalPort ${port} -State Established -ErrorAction SilentlyContinue).Count`,
  );
  return Number(out) || 0;
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
    /* no body */
  }
  return { status: res.status, json };
}

const TERMINAL = new Set(["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"]);

async function oneCycle(i) {
  const t0 = Date.now();
  const conv = await api("POST", "/api/conversations", { title: `perf-${i}` });
  if (conv.status !== 201) throw new Error(`create conversation ${conv.status}`);
  const cid = conv.json.data.id;

  const send = await api(
    "POST",
    `/api/conversations/${cid}/messages`,
    { content: "请直接回答:1+1等于几?只回答数字。" },
    { "Idempotency-Key": `perf-${Date.now()}-${i}` },
  );
  if (send.status !== 202) throw new Error(`send ${send.status}`);
  const reqId = send.json.data.request.id;

  // SSE 订阅到终态(服务端终态会关闭连接,验证连接释放)
  const ctrl = new AbortController();
  let frames = 0;
  let sawContent = false;
  const res = await fetch(`${BASE}/api/requests/${reqId}/events`, {
    signal: ctrl.signal,
    headers: { accept: "text/event-stream" },
  });
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 120_000;
  let terminal = null;
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = raw.match(/^event:\s?(.*)$/m)?.[1];
        if (!ev) continue;
        frames += 1;
        if (ev === "delta" || ev === "snapshot") sawContent = sawContent || ev === "delta";
        if (ev === "status") {
          const data = JSON.parse(raw.match(/^data:\s?(.*)$/m)?.[1] ?? "{}");
          if (TERMINAL.has(data.requestStatus)) {
            terminal = data.requestStatus;
          }
        }
      }
      if (terminal || Date.now() > deadline) break;
    }
  } finally {
    ctrl.abort();
  }
  const ms = Date.now() - t0;
  if (!terminal) throw new Error(`no terminal status in ${ms}ms`);
  if (terminal !== "SUCCESS") throw new Error(`cycle ended ${terminal}`);
  return { ms, frames, sawContent };
}

async function sample(i) {
  const s = {
    i,
    t: new Date().toISOString(),
    rss: await rssOf(SERVER_PID),
    chromium: await chromiumCount(),
    db: dbSize(),
    established: await establishedCount(),
  };
  samples.push(s);
  console.log(
    `SAMPLE ${JSON.stringify({
      i: s.i,
      rssMB: s.rss != null ? Math.round(s.rss / 1048576) : null,
      chromium: s.chromium,
      dbKB: s.db != null ? Math.round(s.db / 1024) : null,
      established: s.established,
      cycles: { ...cycles },
    })}`,
  );
}

async function main() {
  console.log(
    `# perf run: duration=${DURATION_MS / 60000}min gap=${GAP_MS}ms base=${BASE} pid=${SERVER_PID} db=${DB_PATH}`,
  );
  const start = Date.now();
  let i = 0;
  await sample(0);
  while (Date.now() - start < DURATION_MS) {
    i += 1;
    try {
      const r = await oneCycle(i);
      cycles.ok += 1;
      console.log(`CYCLE ${i} ok ${r.ms}ms frames=${r.frames} delta=${r.sawContent}`);
    } catch (e) {
      cycles.fail += 1;
      errors.push(`cycle ${i}: ${e.message}`);
      console.log(`CYCLE ${i} FAIL ${e.message}`);
    }
    const until = start + GAP_MS * (i + 1);
    const wait = Math.max(0, until - Date.now());
    await sleep(Math.min(wait, GAP_MS) || GAP_MS);
    await sample(i);
  }
  const rssFirst = samples[0]?.rss ?? null;
  const rssLast = samples.at(-1)?.rss ?? null;
  const rssMax = Math.max(...samples.map((s) => s.rss ?? 0));
  const dbFirst = samples[0]?.db ?? null;
  const dbLast = samples.at(-1)?.db ?? null;
  const estMax = Math.max(...samples.map((s) => s.established ?? 0));
  const summary = {
    durationMin: Math.round((Date.now() - start) / 60000),
    cycles,
    rssFirstMB: rssFirst != null ? Math.round(rssFirst / 1048576) : null,
    rssLastMB: rssLast != null ? Math.round(rssLast / 1048576) : null,
    rssMaxMB: Math.round(rssMax / 1048576),
    dbFirstKB: dbFirst != null ? Math.round(dbFirst / 1024) : null,
    dbLastKB: dbLast != null ? Math.round(dbLast / 1024) : null,
    establishedMax: estMax,
    errors: errors.slice(0, 20),
  };
  console.log(`PERF_SUMMARY ${JSON.stringify(summary)}`);
}

main().catch((e) => {
  console.error("perf script crashed:", e);
  process.exit(2);
});
