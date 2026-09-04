import { describe, expect, it } from "vitest";

import { computeContentUpdate } from "../../src/modules/sse/content-delta.js";
import { formatSseFrame } from "../../src/modules/sse/sse.service.js";

describe("computeContentUpdate:delta / snapshot 判据(prd 第 6 阶段 §5)", () => {
  it("前缀成立:只补后缀", () => {
    expect(computeContentUpdate("abc", "abcd")).toEqual({ type: "delta", content: "d" });
  });

  it("从空开始:整段作为首个 delta", () => {
    expect(computeContentUpdate("", "你好")).toEqual({ type: "delta", content: "你好" });
  });

  it("前文被改写:整段 snapshot 覆盖,绝不拼出错误文本", () => {
    expect(computeContentUpdate("abc", "axbc")).toEqual({ type: "snapshot", content: "axbc" });
  });

  it("文本变短:不是前缀增长,只能 snapshot", () => {
    expect(computeContentUpdate("abcd", "abc")).toEqual({ type: "snapshot", content: "abc" });
  });

  it("内容未变:空 delta,由调用方丢弃", () => {
    expect(computeContentUpdate("abc", "abc")).toEqual({ type: "delta", content: "" });
  });
});

describe("formatSseFrame:SSE 线格式(§8)", () => {
  it("event 行 + 单行 JSON data + 空行结束", () => {
    expect(formatSseFrame({ event: "delta", data: { type: "delta", content: "你好" } })).toBe(
      'event: delta\ndata: {"type":"delta","content":"你好"}\n\n',
    );
  });

  it("内容含换行时靠 JSON 转义保持 data 单行", () => {
    const frame = formatSseFrame({ event: "snapshot", data: { content: "a\nb" } });
    expect(frame.split("\n")).toEqual(["event: snapshot", 'data: {"content":"a\\nb"}', "", ""]);
  });
});
