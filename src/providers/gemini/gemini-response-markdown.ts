import { parse } from "node-html-parser";
import type { HTMLElement, Node } from "node-html-parser";

/**
 * V1.3 富文本:Gemini 回答 innerHTML → 稳定标准 Markdown(纯函数)。
 *
 * 职责唯一:字符串进、字符串出。不操作 Browser Page / BrowserManager / DB / SSE /
 * Scheduler;不记录任何日志(耗时与 fallback 由 Adapter 负责)。
 *
 * 映射规则来自 F0 真机采样(docs/GEMINI_RICH_FORMAT_DOM_REPORT.md §5):
 * - 粗体/斜体真机主形态是 <b>/<i>(strong/em 作防御别名);
 * - 代码块 = code-block 组件,语言在 code-block-decoration 首个直接 span(不在 class),
 *   代码体 = pre > code 的文本(fence 长度 > 内部最长连续反引号串且 ≥3,内容不 trim);
 * - 表格 = thead/tbody 真实 <table>,输出 GFM(无 thead 时首行作表头);
 * - 公式 = span.math-inline[data-math] 原始 LaTeX;data-math 缺失或含 "$" 时降级为
 *   可读文本,禁止用 KaTeX 渲染结果猜公式;
 * - 链接只允许 http/https;unsafe href 只保留链接文字;
 * - UI chrome(gem-icon-button/mat-icon/buttons/table-footer 等)整棵丢弃;
 * - response-element / link-block / 普通包装节点默认下钻,DOM 多包一层不丢正文。
 *
 * 确定性:纯 DOM 顺序遍历,无随机/时间/哈希顺序依赖 —— 同一输入重复转换结果
 * 逐字节一致(FMT-20)。
 */

/** 解析选项:pre 按默认(raw text)处理 —— pre 内容经二次解析还原(v9 中 pre:false 会丢内容) */
const PARSE_OPTIONS = {
  blockTextElements: { script: true, noscript: true, style: true, pre: true },
} as const;

/** 这些标签整棵丢弃(UI chrome / 非 V1.3 范围资源) */
const DROP_TAGS: ReadonlySet<string> = new Set([
  "button",
  "mat-icon",
  "gem-icon-button",
  "gem-popover",
  "gem-icon",
  "script",
  "style",
  "link",
  "meta",
  "input",
  "textarea",
  "select",
  "option",
  "svg",
  "img",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
]);

/** 命中任一 class token 即整棵丢弃(UI chrome;来自 F0 采样清单) */
const DROP_CLASS_TOKENS: readonly string[] = [
  "mat-mdc-button-persistent-ripple",
  "mat-focus-indicator",
  "mat-mdc-button-touch-target",
  "buttons",
  "table-footer",
  "hide-from-message-actions",
  "hide-on-print",
];

/** 判定「未知包装节点是否按块级下钻」的探针选择器 */
const BLOCK_PROBE_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, code-block, hr";

const ELEMENT_NODE_TYPE = 1;
const TEXT_NODE_TYPE = 3;

export function convertGeminiHtmlToMarkdown(html: string): string {
  const root = parse(html, PARSE_OPTIONS);
  return renderBlocks(root.childNodes).join("\n\n");
}

// ---------------------------------------------------------------------------
// 块级渲染
// ---------------------------------------------------------------------------

/** 渲染一组节点为块列表(段落/列表/代码块/表格…),块之间由调用方以空行拼接 */
function renderBlocks(nodes: Node[]): string[] {
  const blocks: string[] = [];
  let inlineRuns: string[] = [];
  const flushInline = () => {
    const text = escapeLeadingBlockMarker(inlineRuns.join("").trim());
    inlineRuns = [];
    if (text.length > 0) {
      blocks.push(text);
    }
  };
  for (const node of nodes) {
    if (node.nodeType === TEXT_NODE_TYPE) {
      inlineRuns.push(renderInlineText(node.text));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const el = node as HTMLElement;
    if (shouldDrop(el)) {
      continue;
    }
    const block = renderBlockElement(el);
    if (block !== null) {
      flushInline();
      if (block.trim().length > 0) {
        blocks.push(block);
      }
      continue;
    }
    if (hasBlockDescendant(el)) {
      // 未知块级包装(容器 div / response-element 等):下钻,DOM 多包一层不丢正文
      flushInline();
      blocks.push(...renderBlocks(el.childNodes));
      continue;
    }
    inlineRuns.push(renderInlineChildren(el));
  }
  flushInline();
  return blocks;
}

/** 命中块级规则返回 Markdown 块;非块级元素返回 null(调用方按行内处理) */
function renderBlockElement(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = renderInlineChildren(el).trim();
    return text.length > 0 ? `${"#".repeat(level)} ${text}` : null;
  }
  switch (tag) {
    case "p": {
      const text = escapeLeadingBlockMarker(renderInlineChildren(el).trim());
      return text.length > 0 ? text : null;
    }
    case "ul":
      return renderList(el, false, "").join("\n");
    case "ol":
      return renderList(el, true, "").join("\n");
    case "blockquote":
      return renderBlockquote(el);
    case "pre":
      return renderCodeFence(null, extractPreCodeText(el));
    case "code-block": {
      const pre = el.querySelector("pre");
      if (pre === null) {
        return null;
      }
      return renderCodeFence(extractCodeLanguage(el), extractPreCodeText(pre));
    }
    case "table":
      return renderTable(el);
    case "hr":
      return "---";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/** 嵌套缩进 = 父列表标记宽度(`- ` 2 空格、`1. ` 3 空格),保证嵌套关系不变平 */
function renderList(list: HTMLElement, ordered: boolean, indent: string): string[] {
  const startAttr = ordered ? Number.parseInt(list.getAttribute("start") ?? "1", 10) : 1;
  let index = Number.isNaN(startAttr) || startAttr < 1 ? 1 : startAttr;
  const lines: string[] = [];
  for (const node of list.childNodes) {
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const li = node as HTMLElement;
    if (li.tagName.toLowerCase() !== "li" || shouldDrop(li)) {
      continue;
    }
    const marker = ordered ? `${index}. ` : "- ";
    index += 1;
    const childIndent = indent + " ".repeat(marker.length);
    const itemLines = renderListItemContent(li, childIndent);
    if (itemLines.length === 0) {
      lines.push(`${indent}${marker.trimEnd()}`);
      continue;
    }
    lines.push(`${indent}${marker}${itemLines[0]}`);
    lines.push(...itemLines.slice(1));
  }
  return lines;
}

/**
 * 单个 li 的内容行:首行无缩进(调用方拼接 marker),续行带 childIndent。
 * li 内 p 解包为行内内容(不额外制造空段);嵌套列表/代码块等块保持列表归属。
 */
function renderListItemContent(li: HTMLElement, childIndent: string): string[] {
  const lines: string[] = [];
  let inlineRuns: string[] = [];
  const flushInline = () => {
    const text = inlineRuns.join("").trim();
    inlineRuns = [];
    if (text.length === 0) {
      return;
    }
    lines.push(lines.length === 0 ? text : `${childIndent}${text}`);
  };
  for (const node of li.childNodes) {
    if (node.nodeType === TEXT_NODE_TYPE) {
      inlineRuns.push(renderInlineText(node.text));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const el = node as HTMLElement;
    if (shouldDrop(el)) {
      continue;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      flushInline();
      lines.push(...renderList(el, tag === "ol", childIndent));
      continue;
    }
    if (tag === "p") {
      // li > p 解包(§八)
      inlineRuns.push(renderInlineChildren(el));
      continue;
    }
    const block = renderBlockElement(el);
    if (block !== null && block.trim().length > 0) {
      flushInline();
      lines.push(...prefixLines(block.split("\n"), childIndent));
      continue;
    }
    if (block !== null) {
      continue;
    }
    if (hasBlockDescendant(el)) {
      flushInline();
      for (const sub of renderBlocks(el.childNodes)) {
        lines.push(lines.length === 0 ? sub : `${childIndent}${sub}`);
      }
      continue;
    }
    inlineRuns.push(renderInlineChildren(el));
  }
  flushInline();
  return lines;
}

function prefixLines(lines: string[], indent: string): string[] {
  return lines.map((line) => (line.length > 0 ? `${indent}${line}` : line));
}

// ---------------------------------------------------------------------------
// 引用 / 表格
// ---------------------------------------------------------------------------

function renderBlockquote(el: HTMLElement): string {
  const inner = renderBlocks(el.childNodes).join("\n\n");
  if (inner.trim().length === 0) {
    return "";
  }
  return inner
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function renderTable(table: HTMLElement): string {
  const rows = table.querySelectorAll("tr");
  if (rows.length === 0) {
    return "";
  }
  const theadRows = table.querySelectorAll("thead > tr");
  // 无 thead 时首行作表头(§九);多行 thead 不在采样范围,取首行,余下归入表体
  const headerRow = theadRows[0] ?? rows[0];
  if (headerRow === undefined) {
    return "";
  }
  const headerIndex = rows.indexOf(headerRow);
  const headerCells = renderRowCells(headerRow);
  const columnCount = Math.max(
    headerCells.length,
    ...rows.map((row) => renderRowCells(row).length),
  );
  const header = padCells(headerCells, columnCount);
  const separator = Array.from({ length: columnCount }, () => "---");
  const bodyLines = rows
    .slice(headerIndex + 1)
    .map((row) => `| ${padCells(renderRowCells(row), columnCount).join(" | ")} |`);
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...bodyLines,
  ].join("\n");
}

/** 行内单元格:th/td 直接子级渲染为行内内容,换行折叠空格、竖线转义 */
function renderRowCells(row: HTMLElement): string[] {
  const cells: string[] = [];
  for (const node of row.childNodes) {
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag !== "th" && tag !== "td") {
      continue;
    }
    const text = renderInlineChildren(el)
      .replace(/\s*\n\s*/g, " ")
      .trim()
      .replace(/\|/g, "\\|");
    cells.push(text);
  }
  return cells;
}

function padCells(cells: string[], columnCount: number): string[] {
  const padded = cells.slice(0, columnCount);
  while (padded.length < columnCount) {
    padded.push("");
  }
  return padded;
}

// ---------------------------------------------------------------------------
// 代码块
// ---------------------------------------------------------------------------

/** 语言 = code-block-decoration 的首个直接 span 文本(F0:语言不在 class) */
function extractCodeLanguage(codeBlock: HTMLElement): string | null {
  const decoration = codeBlock.querySelector(".code-block-decoration");
  if (decoration === null) {
    return null;
  }
  for (const node of decoration.childNodes) {
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const el = node as HTMLElement;
    if (el.tagName.toLowerCase() !== "span" || shouldDrop(el)) {
      continue;
    }
    const label = normalizeLanguageLabel(el.text);
    if (label !== null) {
      return label;
    }
  }
  return null;
}

function normalizeLanguageLabel(raw: string): string | null {
  const label = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (label.length === 0) {
    return null;
  }
  // 取首个 token:info string 带空格不可被 highlight 识别;不做词典映射(禁止猜语言)
  return label.split(" ")[0] ?? null;
}

function renderCodeFence(language: string | null, rawContent: string): string {
  // 仅剥整体首/尾各一个换行(序列化产物);内容内部一律不 trim(§六)
  let body = rawContent.replace(/\r\n?/g, "\n");
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }
  if (body.endsWith("\n")) {
    body = body.slice(0, -1);
  }
  const longestRun = longestBacktickRun(body);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language ?? ""}\n${body}\n${fence}`;
}

/**
 * pre 内容还原:pre 在解析时是 raw text(含未解码实体),对 pre.innerHTML 二次
 * 解析后取 .text —— 高亮 span 展平、实体恰好单次解码、<br> 归一为换行。
 */
function extractPreCodeText(pre: HTMLElement): string {
  return parse(pre.innerHTML, PARSE_OPTIONS).text;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

// ---------------------------------------------------------------------------
// 行内渲染
// ---------------------------------------------------------------------------

function renderInlineChildren(el: HTMLElement): string {
  return renderInline(el.childNodes);
}

function renderInline(nodes: Node[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.nodeType === TEXT_NODE_TYPE) {
      out += renderInlineText(node.text);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const el = node as HTMLElement;
    if (shouldDrop(el)) {
      continue;
    }
    out += renderInlineElement(el);
  }
  return out;
}

function renderInlineElement(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") {
    const inner = renderInlineChildren(el).trim();
    return inner.length > 0 ? `**${inner}**` : "";
  }
  if (tag === "i" || tag === "em") {
    const inner = renderInlineChildren(el).trim();
    return inner.length > 0 ? `*${inner}*` : "";
  }
  if (tag === "code") {
    return renderInlineCode(el);
  }
  if (tag === "a") {
    return renderLink(el);
  }
  if (tag === "br") {
    return " ";
  }
  if (tag === "span") {
    const math = renderMathSpan(el);
    if (math !== null) {
      return math;
    }
  }
  // 未知行内元素(response-element / link-block / sup 等):解包保留正文
  return renderInlineChildren(el);
}

/**
 * 数学公式(§十一):主路径 = data-math 原始 LaTeX,禁止用 KaTeX 展开文本猜公式。
 * data-math 缺失或含 "$"(会破坏 Markdown 定界)→ 降级为可读文本(可见文字)。
 */
function renderMathSpan(el: HTMLElement): string | null {
  const classes = classTokens(el);
  const isBlock = classes.includes("math-block");
  if (!classes.includes("math-inline") && !isBlock) {
    return null;
  }
  const latex = el.getAttribute("data-math");
  if (latex != null) {
    const trimmed = latex.trim();
    if (trimmed.length > 0 && !trimmed.includes("$")) {
      return isBlock ? `$$${trimmed}$$` : `$${trimmed}$`;
    }
  }
  const readable = el.text.replace(/\s+/g, " ").trim();
  return readable.length > 0 ? readable : "";
}

function renderInlineCode(el: HTMLElement): string {
  const content = codeTextOf(el).replace(/\s*\n\s*/g, " ").trim();
  if (content.length === 0) {
    return "";
  }
  const delimiter = "`".repeat(Math.max(1, longestBacktickRun(content) + 1));
  // 内容以反引号开头/结尾时 CommonMark 要求内容与分隔符之间留一个空格
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${content}${pad}${delimiter}`;
}

/** 行内 code 的文本:br 归一为换行,文本节点取解码值 */
function codeTextOf(el: HTMLElement): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === TEXT_NODE_TYPE) {
      out += node.text;
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      continue;
    }
    const child = node as HTMLElement;
    out += child.tagName.toLowerCase() === "br" ? "\n" : codeTextOf(child);
  }
  return out;
}

function renderLink(el: HTMLElement): string {
  const text = renderInlineChildren(el).replace(/\s*\n\s*/g, " ").trim();
  const href = (el.getAttribute("href") ?? "").trim();
  if (!isSafeHref(href)) {
    // unsafe / 相对 href:只保留链接文字,绝不输出 href(§十)
    return text;
  }
  const label = text.length > 0 ? text : href;
  if (/[<>]/.test(href)) {
    // 无法安全放进 Markdown 目的地,宁可只留文字
    return label;
  }
  const destination = /[\s()]/.test(href) ? `<${href}>` : href;
  return `[${label}](${destination})`;
}

/** 只允许 http/https(§十;mailto 与相对路径一律降级为纯文字) */
function isSafeHref(href: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  const scheme = match?.[1];
  if (scheme === undefined) {
    return false;
  }
  const normalized = scheme.toLowerCase();
  return normalized === "http" || normalized === "https";
}

// ---------------------------------------------------------------------------
// 文本与通用工具
// ---------------------------------------------------------------------------

/** 段内换行折叠为空格 + Markdown 转义(§十三:文本节点必须转义) */
function renderInlineText(text: string): string {
  return escapeMarkdownText(text.replace(/\r\n?/g, " "));
}

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/** 段落首字符与块级 Markdown 标记冲突时转义;**bold** 等行首强调不是标记,不得破坏 */
function escapeLeadingBlockMarker(text: string): string {
  return text
    .replace(/^(>)/, "\\$1") // 引用标记不要求尾随空格,无条件转义
    .replace(/^([*+-])(\s|$)/, "\\$1$2") // 列表标记必须尾随空格;`**bold**` 开头不命中
    .replace(/^(#+)(\s|$)/, "\\$1$2")
    .replace(/^(\d+)([.)]) /, "$1\\$2 ");
}

function shouldDrop(el: HTMLElement): boolean {
  if (DROP_TAGS.has(el.tagName.toLowerCase())) {
    return true;
  }
  const classes = classTokens(el);
  return classes.some((token) => DROP_CLASS_TOKENS.includes(token));
}

function classTokens(el: HTMLElement): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function hasBlockDescendant(el: HTMLElement): boolean {
  return el.querySelector(BLOCK_PROBE_SELECTOR) !== null;
}
