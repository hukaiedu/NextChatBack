/**
 * V1.3 富文本:gemini-response-markdown 转换器单元测试(FMT-01..26)。
 *
 * 主要测试依据是 F0 真机采样 fixture(tests/fixtures/gemini-rich-answer.html,
 * 从真实 Gemini 回答 DOM 的 outerHTML 原样留存):FMT-17 混合富文本、FMT-20
 * 确定性各用一次;其余用例用手工构造的最小 HTML 精确断言单条映射规则。
 *
 * 断言风格:除 FMT-17 外全部整串相等 —— 映射规则的行为契约,不做事后子串宽松匹配。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { convertGeminiHtmlToMarkdown } from "../../src/providers/gemini/gemini-response-markdown.js";

const FIXTURE_HTML = readFileSync(
  new URL("../fixtures/gemini-rich-answer.html", import.meta.url),
  "utf8",
);

/** F0 实测代码块组件形态:语言在 decoration 首个直接 span,代码体在 pre>code(hljs span 高亮) */
function codeBlockHtml(language: string | null, codeSource: string): string {
  const decoration =
    language === null ? "" : `<div class="code-block-decoration header-formatted"><span>${language}</span></div>`;
  return `<code-block><div class="code-block"><div class="formatted-code-block-internal-container">${decoration}<div class="animated-opacity"><pre><code class="code-container formatted">${codeSource}</code></pre></div></div></div></code-block>`;
}

describe("gemini-response-markdown(V1.3 FMT)", () => {
  it("FMT-01 普通段落 + 文本节点 Markdown escaping", () => {
    expect(convertGeminiHtmlToMarkdown("<p>Hello world</p>")).toBe("Hello world");
    // §十三:文本节点必须转义,禁止透传 Markdown 结构字符
    expect(
      convertGeminiHtmlToMarkdown("<p>a*b [c] &lt;d&gt; _e_ \\f</p>"),
    ).toBe("a\\*b \\[c\\] \\<d\\> \\_e\\_ \\\\f");
    // 行首字面块标记(构成列表/标题/引用语法)仍必须转义
    expect(convertGeminiHtmlToMarkdown("<p>* literal list</p>")).toBe("\\* literal list");
    expect(convertGeminiHtmlToMarkdown("<p>&gt; literal quote</p>")).toBe("\\> literal quote");
    expect(convertGeminiHtmlToMarkdown("<p># literal heading</p>")).toBe("\\# literal heading");
    expect(convertGeminiHtmlToMarkdown("<p>1. literal ordered</p>")).toBe("1\\. literal ordered");
  });

  it("FMT-02 标题层级 h1..h6", () => {
    expect(
      convertGeminiHtmlToMarkdown("<h1>One</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>"),
    ).toBe("# One\n\n## Two\n\n### Three\n\n###### Six");
  });

  it("FMT-03 粗体:b 与 strong 同映射 **,行首粗体不被块标记转义破坏", () => {
    expect(convertGeminiHtmlToMarkdown("<p>a <b>b</b> and <strong>s</strong></p>")).toBe(
      "a **b** and **s**",
    );
    expect(convertGeminiHtmlToMarkdown("<p><b>bold start</b> rest</p>")).toBe(
      "**bold start** rest",
    );
  });

  it("FMT-04 斜体:i 与 em 同映射 *", () => {
    expect(convertGeminiHtmlToMarkdown("<p>a <i>i</i> and <em>e</em></p>")).toBe(
      "a *i* and *e*",
    );
  });

  it("FMT-05 无序列表;li 内 p 解包不额外空段", () => {
    expect(convertGeminiHtmlToMarkdown("<ul><li>one</li><li>two</li></ul>")).toBe(
      "- one\n- two",
    );
    expect(convertGeminiHtmlToMarkdown("<ul><li><p>in p</p></li><li>plain</li></ul>")).toBe(
      "- in p\n- plain",
    );
  });

  it("FMT-06 有序列表编号连续,ol[start] 保留起点", () => {
    expect(convertGeminiHtmlToMarkdown("<ol><li>one</li><li>two</li></ol>")).toBe(
      "1. one\n2. two",
    );
    expect(convertGeminiHtmlToMarkdown('<ol start="3"><li>a</li><li>b</li></ol>')).toBe(
      "3. a\n4. b",
    );
  });

  it("FMT-07 嵌套列表保持层级不变平(缩进 = 父标记宽度)", () => {
    expect(
      convertGeminiHtmlToMarkdown(
        "<ul><li>outer<ul><li>inner-a</li><li>inner-b</li></ul></li><li>sibling</li></ul>",
      ),
    ).toBe("- outer\n  - inner-a\n  - inner-b\n- sibling");
    expect(
      convertGeminiHtmlToMarkdown(
        "<ol><li>first<ol><li>deep</li></ol></li></ol>",
      ),
    ).toBe("1. first\n   1. deep");
  });

  it("FMT-08 行内 code:单反引号包裹", () => {
    expect(convertGeminiHtmlToMarkdown("<p>run <code>npm i</code> now</p>")).toBe(
      "run `npm i` now",
    );
  });

  it("FMT-09 代码块:内容不 trim,只剥整体首尾各一个换行", () => {
    expect(convertGeminiHtmlToMarkdown("<pre><code>const x = 1;</code></pre>")).toBe(
      "```\nconst x = 1;\n```",
    );
    // 内容内部(含行首缩进与中间空行)必须原样保留
    expect(
      convertGeminiHtmlToMarkdown("<pre><code>\n\n  spaced  \n\n</code></pre>"),
    ).toBe("```\n\n  spaced  \n\n```");
  });

  it("FMT-10 代码块语言取 decoration span,未知语言不猜", () => {
    expect(
      convertGeminiHtmlToMarkdown(codeBlockHtml("JavaScript", "const x = <span>1</span>;")),
    ).toBe("```javascript\nconst x = 1;\n```");
    // decoration 缺失 → 无语言 fence,绝不为凑语言猜一个
    expect(convertGeminiHtmlToMarkdown(codeBlockHtml(null, "SELECT 1;"))).toBe(
      "```\nSELECT 1;\n```",
    );
  });

  it("FMT-11 fence 长度大于代码内最长连续反引号串且至少 3", () => {
    expect(convertGeminiHtmlToMarkdown("<pre><code>a ``` b</code></pre>")).toBe(
      "````\na ``` b\n````",
    );
    expect(convertGeminiHtmlToMarkdown("<pre><code>a ```` b</code></pre>")).toBe(
      "`````\na ```` b\n`````",
    );
    // 无反引号时仍是最小 3
    expect(convertGeminiHtmlToMarkdown("<pre><code>plain</code></pre>")).toBe(
      "```\nplain\n```",
    );
  });

  it("FMT-12 blockquote 每行 > 前缀,段间以 > 空行延续(CommonMark 合法形态)", () => {
    expect(
      convertGeminiHtmlToMarkdown("<blockquote><p>first</p><p>second</p></blockquote>"),
    ).toBe("> first\n>\n> second");
  });

  it("FMT-13 安全链接输出 [文字](href)", () => {
    expect(
      convertGeminiHtmlToMarkdown('<p>see <a href="https://example.com/x?a=1">docs</a></p>'),
    ).toBe("see [docs](https://example.com/x?a=1)");
    // 目的地含空格/括号 → <> 包裹的合法形式
    expect(
      convertGeminiHtmlToMarkdown('<p><a href="https://example.com/a b(1)">weird</a></p>'),
    ).toBe("[weird](<https://example.com/a b(1)>)");
  });

  it("FMT-14 不安全 href 只保留链接文字,绝不输出 href", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html;base64,AAAA",
      "vbscript:x",
      "/relative/path",
      "mailto:a@b.c",
    ]) {
      const out = convertGeminiHtmlToMarkdown(`<p><a href="${href}">label</a></p>`);
      expect(out).toBe("label");
      expect(out).not.toContain("href");
    }
    // 目的地含 <> 无法安全表达 → 宁可只留文字
    expect(
      convertGeminiHtmlToMarkdown('<p><a href="https://example.com/<x>">t</a></p>'),
    ).toBe("t");
  });

  it("FMT-15 表格输出 GFM:竖线转义、短行补空、无 thead 时首行作表头", () => {
    expect(
      convertGeminiHtmlToMarkdown(
        "<table><thead><tr><th>H1</th><th>H2</th></tr></thead>" +
          '<tbody><tr><td>a</td><td>b|c</td></tr><tr><td>one</td></tr></tbody></table>',
      ),
    ).toBe("| H1 | H2 |\n| --- | --- |\n| a | b\\|c |\n| one |  |");
    expect(
      convertGeminiHtmlToMarkdown(
        "<table><tr><td>H1</td><td>H2</td></tr><tr><td>a</td><td>b</td></tr></table>",
      ),
    ).toBe("| H1 | H2 |\n| --- | --- |\n| a | b |");
  });

  it("FMT-16 hr → ---", () => {
    expect(convertGeminiHtmlToMarkdown("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  it("FMT-17 真机 fixture 混合富文本:映射齐全且 UI chrome 零泄漏", () => {
    const md = convertGeminiHtmlToMarkdown(FIXTURE_HTML);
    // 每类映射的代表产物(来自 F0 采样内容的已知结构)
    expect(md).toContain("## 富文本采样");
    expect(md).toContain("### 段落与行内样式");
    expect(md).toContain("**粗体文字**");
    expect(md).toContain("*斜体文字*");
    expect(md).toContain("`const value = 42`");
    expect(md).toContain("[示例网站](https://example.com)");
    expect(md).toContain("- 第一项无序列表内容");
    expect(md).toContain("  - 嵌套子列表项目 A");
    expect(md).toContain("1. 第一步：获取待渲染的 HTML 或 Markdown 数据");
    expect(md).toContain("```javascript");
    expect(md).toContain("```java");
    expect(md).toContain("return fibonacci(n - 1) + fibonacci(n - 2);");
    expect(md).toContain("> 良好的 UI 渲染测试");
    expect(md).toContain("| 组件名称 | 节点类型 | 渲染状态 |");
    expect(md).toContain("| Header | Element | Success |");
    expect(md).toContain("$E=mc^2$");
    // 行内数学必须来自 data-math,不是 KaTeX 渲染后的文本(渲染文本无 ^ 符号)
    // UI chrome/属性噪声零泄漏(§十三/§十九):标签、属性、按钮 aria 文案都不得出现
    for (const banned of [
      "mat-icon",
      "gem-icon-button",
      "gem-popover",
      "response-element",
      "jslog",
      "_ngcontent",
      "_nghost",
      "Baixar",
      "Mais opções",
    ]) {
      expect(md).not.toContain(banned);
    }
  });

  it("FMT-20 确定性:同一输入重复转换 100 次逐字节一致", () => {
    const first = convertGeminiHtmlToMarkdown(FIXTURE_HTML);
    for (let i = 0; i < 100; i += 1) {
      expect(convertGeminiHtmlToMarkdown(FIXTURE_HTML)).toBe(first);
    }
  });

  it("FMT-21 inline math 主路径是 data-math 原始 LaTeX", () => {
    expect(
      convertGeminiHtmlToMarkdown(
        '<p>mass <span class="math-inline" data-math="E=mc^2">E=mc2rendered</span> done</p>',
      ),
    ).toBe("mass $E=mc^2$ done");
  });

  it("FMT-22 math 无 data-math 或含 $ 时降级为可读文本,不猜公式", () => {
    expect(convertGeminiHtmlToMarkdown('<p><span class="math-inline">E=mc^2 visible</span></p>')).toBe(
      "E=mc^2 visible",
    );
    expect(
      convertGeminiHtmlToMarkdown('<p><span class="math-inline" data-math="$x$">visible v</span></p>'),
    ).toBe("visible v");
  });

  it("FMT-23 行内 code 含反引号:分隔符加长", () => {
    expect(convertGeminiHtmlToMarkdown("<p>a <code>x`y</code> b</p>")).toBe("a ``x`y`` b");
  });

  it("FMT-24 未知包装节点默认下钻,不丢正文", () => {
    expect(
      convertGeminiHtmlToMarkdown('<div class="some-unknown-wrapper"><p>kept text</p></div>'),
    ).toBe("kept text");
    expect(convertGeminiHtmlToMarkdown("<message-content><p>in msg</p></message-content>")).toBe(
      "in msg",
    );
    expect(
      convertGeminiHtmlToMarkdown(
        '<response-element><link-block><a href="https://example.com">ln</a></link-block></response-element>',
      ),
    ).toBe("[ln](https://example.com)");
  });

  it("FMT-25 正文混入多个 UI 组件:正文保留,chrome 整棵丢弃", () => {
    const md = convertGeminiHtmlToMarkdown(
      "<p>real answer</p>" +
        '<gem-icon-button><mat-icon>content_copy</mat-icon></gem-icon-button>' +
        '<div class="buttons"><button>Copy</button></div>' +
        '<gem-popover><span>popover tip</span></gem-popover>' +
        '<div class="table-footer"><span>footer text</span></div>' +
        "<p>tail text</p>",
    );
    expect(md).toBe("real answer\n\ntail text");
  });

  it("FMT-26 空节点 / whitespace-only / 全 chrome 输入输出空串", () => {
    expect(convertGeminiHtmlToMarkdown("<p>   </p>")).toBe("");
    expect(convertGeminiHtmlToMarkdown('<div class="buttons"><button>x</button></div>')).toBe("");
    expect(convertGeminiHtmlToMarkdown("")).toBe("");
  });
});
