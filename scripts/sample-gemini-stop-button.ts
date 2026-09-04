/**
 * 第 8 阶段 Step 1:真实 Gemini 页面「停止生成」按钮采样。
 *
 * 为什么需要这个脚本:
 * prd 第 643 行把「停止按钮」列为必需选择器,§8.9 要求 Cancel 走
 * PROCESSING → CANCELLING →「调用 Gemini stop」→「确认真正停止」→ CANCELLED。
 * 但 docs/GEMINI_AUTOMATION.md 第 4 阶段结论明确写着「不用停止按钮」(aria-label 本地化为 pt-BR,
 * 且该按钮只在生成中出现)。本脚本用**结构差分**重新实测,而不是猜 aria-label。
 *
 * 不进 tsconfig include(只有 src),不进 build。运行:
 *   npx tsx scripts/sample-gemini-stop-button.ts                     # A 相:快照差分,列候选
 *   npx tsx scripts/sample-gemini-stop-button.ts --click "<selector>" # B 相:点击并测确认时延
 *
 * 前置:后端与所有 Chromium 必须已停(profile 被独占锁住,见 PROVIDER_PROFILE_IN_USE)。
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

const PROFILE_DIR = "data/browser-profile";
const BASE_URL = "https://gemini.google.com/app";
const OUT_FILE = "data/stop-button-sample.json";

/** 必须长到能在生成中途被截停,否则测不出「确认停止」 */
const PROMPT =
  "请用中文写一篇约 2000 字的长文，逐段详细讲解浏览器渲染管线：HTML 解析、DOM 树构建、样式计算、布局、分层、绘制、合成，每一步都要展开说明并举例。";

const COMPOSER = "rich-textarea .ql-editor";
const TURN_SHELL = "response-container";
const ANSWER = "model-response";
const ANSWER_TEXT = "model-response .model-response-text";

const POLL_MS = 200;
const GENERATING_SNAPSHOTS = 12;
const SNAPSHOT_INTERVAL_MS = 300;
const CONFIRM_DEADLINE_MS = 25_000;
const STABLE_WINDOW_MS = 1_500;
/** 点击停止前正文至少要有的字数,保证测的是「回答中途取消」 */
const MIN_TEXT_LEN = 400;
/** Reasoning 模式思考阶段可能很久,给足等待正文出现的上限 */
const TEXT_DEADLINE_MS = 180_000;

type ElInfo = {
  sig: string;
  tag: string;
  attrs: Record<string, string>;
  shadowHosts: string[];
  visible: boolean;
  text: string;
};

/**
 * 页内深走快照。
 *
 * 必须自己递归 shadowRoot:GEMINI_AUTOMATION.md §1 实测页内 querySelectorAll **不穿透** shadow DOM,
 * 而 Playwright locator 穿透。所以这里显式递归,并在 A 相末尾用 locator 复验每个候选的可达性。
 */
const SNAPSHOT_FN = () => {
  const INTERESTING =
    'button, [role="button"], mat-icon, [data-mat-icon-name], [data-test-id], [class*="stop"], [class*="Stop"]';
  const out: unknown[] = [];
  // 显式栈而非递归:tsx/esbuild 的 keepNames 会给内层具名函数注入 __name(...),
  // 而 Playwright 只把函数体送进浏览器执行,浏览器里没有 __name 这个符号。
  const stack: { root: Document | ShadowRoot; hosts: string[] }[] = [
    { root: document, hosts: [] },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const el of Array.from(frame.root.querySelectorAll("*"))) {
      const tag = el.tagName.toLowerCase();
      let interesting = tag.includes("stop") || el.hasAttribute("data-mat-icon-name");
      if (!interesting) {
        try {
          interesting = el.matches(INTERESTING);
        } catch {
          interesting = false;
        }
      }
      if (interesting) {
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) {
          if (a.name === "style") continue;
          attrs[a.name] = a.value.length > 90 ? `${a.value.slice(0, 90)}…` : a.value;
        }
        const sig =
          tag +
          Object.keys(attrs)
            .sort()
            .map((k) => `[${k}="${attrs[k]}"]`)
            .join("");
        out.push({
          sig,
          tag,
          attrs,
          shadowHosts: frame.hosts.slice(),
          visible: el.getClientRects().length > 0,
          text: ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 40),
        });
      }
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) stack.push({ root: sr, hosts: frame.hosts.concat(tag) });
    }
  }
  return out as ElInfo[];
};

function log(...args: unknown[]): void {
  console.log(...args);
}

function diffSignatures(idle: ElInfo[], generating: ElInfo[]): Map<string, ElInfo> {
  const idleSigs = new Set(idle.map((e) => e.sig));
  const candidates = new Map<string, ElInfo>();
  for (const el of generating) {
    if (idleSigs.has(el.sig)) continue;
    if (!candidates.has(el.sig)) candidates.set(el.sig, el);
  }
  return candidates;
}

/** 从签名生成若干 CSS 变体,按「稳定 → 本地化」排序,供 locator 复验 */
function cssVariants(el: ElInfo): string[] {
  const stableKeys = ["data-mat-icon-name", "data-test-id", "role", "class", "id", "name", "type"];
  const variants: string[] = [el.tag];
  for (const key of stableKeys) {
    const value = el.attrs[key];
    if (!value) continue;
    if (key === "id") variants.push(`${el.tag}#${value}`);
    else if (key === "class") {
      const first = value.split(/\s+/)[0];
      if (first) variants.push(`${el.tag}.${first}`);
    } else variants.push(`${el.tag}[${key}="${value}"]`);
  }
  const aria = el.attrs["aria-label"];
  if (aria) variants.push(`${el.tag}[aria-label="${aria}"]`);
  return [...new Set(variants)];
}

async function countAll(page: Page, selector: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const key of [TURN_SHELL, ANSWER, selector]) {
    try {
      result[key] = await page.locator(key).count();
    } catch {
      result[key] = -1;
    }
  }
  return result;
}

async function lastText(page: Page): Promise<string> {
  try {
    const last = page.locator(ANSWER_TEXT).last();
    if ((await last.count()) === 0) return "";
    return (await last.innerText()).trim();
  } catch {
    return "";
  }
}

/**
 * 等正文真的开始流。
 *
 * 实测该账号处于 Reasoning(思考)模式:发送后 model-response 已建好、停止按钮已出现,
 * 但 .model-response-text 长时间为空。此时点停止只会得到空回答,测不出真实确认时延,
 * 所以必须等正文长度过阈值再点。
 */
async function waitForText(page: Page, minLen: number, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await lastText(page);
    if (last.length >= minLen) return last;
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`等待正文达到 ${minLen} 字超时(${deadlineMs}ms),当前 ${last.length} 字`);
}

async function waitForComposer(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await page.locator(COMPOSER).count()) > 0) return;
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`composer 未出现(30s):${COMPOSER}。可能未登录或 DOM 改版`);
}

async function sendPrompt(page: Page): Promise<void> {
  await page.locator(COMPOSER).first().fill(PROMPT);
  await page.waitForTimeout(300);
  await page.locator(COMPOSER).first().focus();
  await page.keyboard.press("Enter");
}

/** 等生成真正开始:外壳数超过基线,或出现「只在生成中才有」的元素 */
async function waitForGenerating(page: Page, baselineShells: number): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const shells = await page.locator(TURN_SHELL).count();
    if (shells > baselineShells) return;
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error("发送后 40s 内未观察到新轮次外壳,生成未开始");
}

async function phaseA(page: Page): Promise<Record<string, unknown>> {
  log("A 相:抓 idle 快照");
  const idle = await page.evaluate(SNAPSHOT_FN);
  const baselineShells = await page.locator(TURN_SHELL).count();
  log(`  idle 元素 ${idle.length} 个,baseline response-container=${baselineShells}`);

  await sendPrompt(page);
  await waitForGenerating(page, baselineShells);
  log("  生成已开始,抓 generating 快照");

  const generating: ElInfo[] = [];
  for (let i = 0; i < GENERATING_SNAPSHOTS; i++) {
    generating.push(...(await page.evaluate(SNAPSHOT_FN)));
    await page.waitForTimeout(SNAPSHOT_INTERVAL_MS);
  }
  log(`  generating 元素 ${generating.length} 个(含重复)`);

  const candidates = diffSignatures(idle, generating);
  const rows: Record<string, unknown>[] = [];
  for (const [sig, el] of candidates) {
    const variants = cssVariants(el);
    const reachable: Record<string, number> = {};
    for (const v of variants) {
      try {
        reachable[v] = await page.locator(v).count();
      } catch {
        reachable[v] = -1;
      }
    }
    rows.push({
      sig,
      tag: el.tag,
      attrs: el.attrs,
      shadowHosts: el.shadowHosts,
      visible: el.visible,
      text: el.text,
      locatorCounts: reachable,
    });
    log(
      `  候选 ${el.tag} visible=${el.visible} shadow=${el.shadowHosts.join(">") || "-"} ` +
        `locator=${JSON.stringify(reachable)}`,
    );
    log(`        attrs=${JSON.stringify(el.attrs)}`);
  }

  return {
    phase: "A",
    prompt: PROMPT,
    url: page.url(),
    idleCount: idle.length,
    generatingCount: generating.length,
    baselineShells,
    candidateCount: candidates.size,
    candidates: rows,
  };
}

async function phaseB(page: Page, clickSelector: string): Promise<Record<string, unknown>> {
  // 严格证明「只在生成中出现」:发送前该 selector 必须为 0
  const idleStopCount = await page.locator(clickSelector).count();
  log(`B 相:idle 页面 selector="${clickSelector}" 计数=${idleStopCount}(应为 0)`);

  const baselineShells = await page.locator(TURN_SHELL).count();
  await sendPrompt(page);
  await waitForGenerating(page, baselineShells);

  // 等停止按钮出现,确认它真的只在生成中存在
  const appearDeadline = Date.now() + 20_000;
  let stopCountAtStart = 0;
  while (Date.now() < appearDeadline) {
    stopCountAtStart = await page.locator(clickSelector).count();
    if (stopCountAtStart > 0) break;
    await page.waitForTimeout(POLL_MS);
  }
  log(`B 相:selector="${clickSelector}" 生成中计数=${stopCountAtStart}`);
  if (stopCountAtStart === 0) {
    return {
      phase: "B",
      clickSelector,
      idleStopCount,
      error: "生成中该 selector 计数为 0,无法点击",
    };
  }

  // Reasoning 模式下停止按钮在思考阶段就已存在,但正文还是空的。等正文真的流起来再点,
  // 否则测到的是「思考阶段被取消」这个特例,而不是本阶段要覆盖的「回答中途被取消」。
  const textBeforeClick = await waitForText(page, MIN_TEXT_LEN, TEXT_DEADLINE_MS);
  log(`  正文已达 ${textBeforeClick.length} 字,开始点击`);
  const stopCountBeforeClick = await page.locator(clickSelector).count();
  log(`  点击前停止按钮计数=${stopCountBeforeClick}`);
  if (stopCountBeforeClick === 0) {
    return {
      phase: "B",
      clickSelector,
      idleStopCount,
      stopCountAtStart,
      textLenBeforeClick: textBeforeClick.length,
      error: "正文开始流之后停止按钮已消失(生成已结束),需要重跑",
    };
  }

  const textAtClick = await lastText(page);
  const lenAtClick = textAtClick.length;
  const clickStartedAt = Date.now();

  let clickMode = "locator";
  try {
    await page.locator(clickSelector).first().click({ timeout: 5_000 });
  } catch (err) {
    clickMode = "evaluate";
    log(`  locator.click 失败(${(err as Error).message.slice(0, 120)}),改用 el.click()`);
    await page.locator(clickSelector).first().evaluate((el) => (el as HTMLElement).click());
  }
  const clickDoneAt = Date.now();
  log(`  已点击(${clickMode}),耗时 ${clickDoneAt - clickStartedAt}ms`);

  const trace: Record<string, unknown>[] = [];
  let tStopGone: number | null = null;
  let tShellsEqual: number | null = null;
  let tTextStable: number | null = null;
  let lastTextValue = textAtClick;
  let lastTextChangeAt = clickDoneAt;
  const deadline = clickDoneAt + CONFIRM_DEADLINE_MS;

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    const now = Date.now();
    const counts = await countAll(page, clickSelector);
    const text = await lastText(page);
    if (text !== lastTextValue) {
      lastTextValue = text;
      lastTextChangeAt = now;
    }
    const stop = counts[clickSelector] ?? 0;
    const shells = counts[TURN_SHELL] ?? 0;
    const answers = counts[ANSWER] ?? 0;
    if (tStopGone === null && stop === 0) tStopGone = now - clickDoneAt;
    if (tShellsEqual === null && answers > baselineShells && shells === answers) {
      tShellsEqual = now - clickDoneAt;
    }
    if (
      tTextStable === null &&
      now - lastTextChangeAt >= STABLE_WINDOW_MS &&
      text.length > lenAtClick
    ) {
      tTextStable = now - clickDoneAt;
    }
    trace.push({
      at: now - clickDoneAt,
      stop,
      shells,
      answers,
      textLen: text.length,
    });
    if (tStopGone !== null && tShellsEqual !== null && tTextStable !== null) {
      // 三条判据都成立后再多观察 2s,确认不会反弹
      const settleUntil = Date.now() + 2_000;
      while (Date.now() < settleUntil) {
        await page.waitForTimeout(POLL_MS);
        const recount = await countAll(page, clickSelector);
        trace.push({
          at: Date.now() - clickDoneAt,
          stop: recount[clickSelector] ?? 0,
          shells: recount[TURN_SHELL] ?? 0,
          answers: recount[ANSWER] ?? 0,
          textLen: (await lastText(page)).length,
          settle: true,
        });
      }
      break;
    }
  }

  const finalText = await lastText(page);
  const allConfirmed = tStopGone !== null && tShellsEqual !== null && tTextStable !== null;
  log(
    `  确认时延: stopGone=${tStopGone}ms shellsEqual=${tShellsEqual}ms textStable=${tTextStable}ms ` +
      `allConfirmed=${allConfirmed}`,
  );
  log(`  文本长度: 点击时=${lenAtClick} 最终=${finalText.length}`);
  log(`  点击后新增文本(前 200 字):${JSON.stringify(finalText.slice(lenAtClick, lenAtClick + 200))}`);
  log(`  最终文本尾部(后 160 字):${JSON.stringify(finalText.slice(-160))}`);

  return {
    phase: "B",
    clickSelector,
    clickMode,
    idleStopCount,
    stopCountAtStart,
    lenAtClick,
    finalLen: finalText.length,
    appendedAfterClick: finalText.slice(lenAtClick),
    finalTail: finalText.slice(-160),
    tStopGone,
    tShellsEqual,
    tTextStable,
    allConfirmed,
    stableWindowMs: STABLE_WINDOW_MS,
    trace,
  };
}

async function main(): Promise<void> {
  const clickArgIndex = process.argv.indexOf("--click");
  const clickSelector = clickArgIndex >= 0 ? process.argv[clickArgIndex + 1] : undefined;

  let context: BrowserContext | null = null;
  const startedAt = new Date().toISOString();
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForComposer(page);
    log(`已登录并进入 ${page.url()}`);

    const report = clickSelector
      ? await phaseB(page, clickSelector)
      : await phaseA(page);
    const payload = { startedAt, baseUrl: BASE_URL, ...report };
    writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
    log(`\n结果已写入 ${OUT_FILE}`);
    if (!clickSelector) {
      log("\n下一步:挑一个 locatorCounts > 0 的候选,跑 --click \"<selector>\" 做 B 相");
    }
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
}

void main().catch((err) => {
  console.error("采样失败:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
