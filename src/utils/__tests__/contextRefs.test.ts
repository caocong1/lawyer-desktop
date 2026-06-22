import { describe, expect, it } from "vitest";
import type { ContextRefPayload } from "../../types/contextRefs";
import {
  canSendWithContext,
  formatUserMessageContentForStorage,
  formatUserVisibleContent,
  userMessageParts,
  selectContextRefsForSend,
} from "../contextRefs";

const refs: ContextRefPayload[] = [
  { alias: "施工合同", path: "C:\\cases\\a\\施工合同.pdf", kind: "file" },
  { alias: "补充协议", path: "C:\\cases\\a\\补充协议.pdf", kind: "file" },
  { alias: "往来函件", path: "C:\\cases\\a\\往来函件", kind: "directory" },
];

describe("context refs for sending", () => {
  it("sends every attached ref when the text has no @ mention", () => {
    expect(selectContextRefsForSend("请分析这些材料", refs, [])).toEqual(refs);
  });

  it("limits the turn to explicit @ mentions when present", () => {
    expect(selectContextRefsForSend("只看 @补充协议", refs, [])).toEqual([refs[1]]);
  });

  it("allows sending an attachment-only turn", () => {
    expect(canSendWithContext("", refs, false)).toBe(true);
    expect(canSendWithContext("   ", [], false)).toBe(false);
    expect(canSendWithContext("问题", [], true)).toBe(false);
  });
});

describe("user-visible context ref summary", () => {
  it("shows uploaded refs in the sent user message even without @ mentions", () => {
    const text = formatUserVisibleContent("请分析这些材料", refs);

    expect(text).toContain("请分析这些材料");
    expect(text).toContain("已附加 3 项本地资料");
    expect(text).toContain("@施工合同（文件）");
    expect(text).toContain("@补充协议（文件）");
    expect(text).toContain("@往来函件（目录）");
  });

  it("formats saved backend context blocks for display", () => {
    const saved = [
      "请分析这些材料",
      "",
      "--- 上下文引用 ---",
      "@施工合同 (文件: C:\\cases\\a\\施工合同.pdf)",
      "",
      "@往来函件 (目录: C:\\cases\\a\\往来函件)",
      "workspace 已索引：8 个文件，13 个 chunk。root_id=abc",
    ].join("\n");

    expect(formatUserVisibleContent(saved)).toBe(
      "请分析这些材料\n\n已附加 2 项本地资料：@施工合同（文件）、@往来函件（目录）",
    );
  });

  it("extracts ChatGPT-style attachment card data from refs", () => {
    const parts = userMessageParts("请分析这些材料", refs);

    expect(parts.text).toBe("请分析这些材料");
    expect(parts.attachments).toEqual([
      expect.objectContaining({ alias: "施工合同", typeLabel: "PDF", tone: "pdf" }),
      expect.objectContaining({ alias: "补充协议", typeLabel: "PDF", tone: "pdf" }),
      expect.objectContaining({ alias: "往来函件", typeLabel: "文件夹", tone: "folder" }),
    ]);
  });

  it("stores sent refs as a parseable context block for attachment cards", () => {
    const stored = formatUserMessageContentForStorage("请分析这些材料", refs);
    const parts = userMessageParts(stored);

    expect(stored).toContain("--- 上下文引用 ---");
    expect(stored).toContain("@施工合同 (文件: C:\\cases\\a\\施工合同.pdf)");
    expect(parts.text).toBe("请分析这些材料");
    expect(parts.attachments.map((a) => [a.alias, a.typeLabel, a.tone])).toEqual([
      ["施工合同", "PDF", "pdf"],
      ["补充协议", "PDF", "pdf"],
      ["往来函件", "文件夹", "folder"],
    ]);
  });

  it("extracts attachment cards from persisted backend context blocks", () => {
    const saved = [
      "请分析这些材料",
      "",
      "--- 上下文引用 ---",
      "@八局一公司正式来函06.10 (文件: C:\\cases\\八局一公司正式来函06.10.pdf)",
      "",
      "@违约退场事项说明 (文件: C:\\cases\\违约退场事项说明.docx)",
    ].join("\n");

    const parts = userMessageParts(saved);

    expect(parts.text).toBe("请分析这些材料");
    expect(parts.attachments.map((a) => [a.alias, a.typeLabel, a.tone])).toEqual([
      ["八局一公司正式来函06.10", "PDF", "pdf"],
      ["违约退场事项说明", "Word", "doc"],
    ]);
  });
});
