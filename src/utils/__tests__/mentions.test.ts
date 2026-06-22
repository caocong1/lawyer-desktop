import { describe, expect, it } from "vitest";
import type { ContextRefPayload } from "../../types/contextRefs";
import {
  detectAtTrigger,
  isRefMentioned,
  resolveInlineMentions,
  serializeEditor,
  validateMentionPaths,
} from "../mentions";

const refs: ContextRefPayload[] = [
  {
    alias: "合同 附件.pdf",
    path: "C:\\cases\\a\\合同 附件.pdf",
    kind: "file",
  },
  {
    alias: "证据.pdf",
    path: "C:\\cases\\a\\证据.pdf",
    kind: "file",
  },
  {
    alias: "证据.pdf",
    path: "C:\\cases\\b\\证据.pdf",
    kind: "file",
  },
  {
    alias: "证据",
    path: "C:\\cases\\c\\证据",
    kind: "directory",
  },
];

describe("mention resolution", () => {
  it("matches aliases that contain spaces", () => {
    expect(resolveInlineMentions("请重点看 @合同 附件.pdf 后起草", refs)).toEqual([
      refs[0],
    ]);
  });

  it("uses selected mention paths to disambiguate duplicate aliases", () => {
    expect(
      resolveInlineMentions("请重点看 @证据.pdf", refs, ["C:\\cases\\b\\证据.pdf"]),
    ).toEqual([refs[2]]);
  });

  it("does not match shorter aliases inside longer mention labels", () => {
    expect(resolveInlineMentions("请重点看 @证据.pdf", refs)).toEqual([refs[1]]);
  });

  it("validates selected paths against remaining mention text", () => {
    expect(validateMentionPaths("已删除正文引用", refs, [refs[0].path])).toEqual([]);
    expect(isRefMentioned("请重点看 @合同 附件.pdf。", refs[0])).toBe(true);
  });

  it("does not validate a shorter stale mention path against a longer alias", () => {
    expect(validateMentionPaths("请重点看 @证据.pdf", refs, [refs[3].path])).toEqual([]);
  });
});

describe("detectAtTrigger boundary option", () => {
  it("requires a boundary before @ by default", () => {
    expect(detectAtTrigger("据@", 2).active).toBe(false);
  });

  it("triggers after any char when requireBoundary is false", () => {
    const t = detectAtTrigger("据@证", 3, { requireBoundary: false });
    expect(t.active).toBe(true);
    expect(t.query).toBe("证");
    expect(t.atPos).toBe(1);
  });

  it("still stops at whitespace between @ and caret", () => {
    expect(detectAtTrigger("@ 证", 3, { requireBoundary: false }).active).toBe(false);
  });

  it("triggers at start of text", () => {
    expect(detectAtTrigger("@证", 2, { requireBoundary: false }).active).toBe(true);
  });
});

describe("serializeEditor", () => {
  function chip(alias: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = "mc-chip";
    el.setAttribute("data-alias", alias);
    el.textContent = `@${alias}`;
    return el;
  }

  it("serializes plain text verbatim", () => {
    const root = document.createElement("div");
    root.append(document.createTextNode("根据合同"));
    expect(serializeEditor(root)).toBe("根据合同");
  });

  it("serializes a chip as @alias and preserves surrounding spaces", () => {
    const root = document.createElement("div");
    root.append(
      document.createTextNode("根据 "),
      chip("合同 附件.pdf"),
      document.createTextNode(" 起草"),
    );
    expect(serializeEditor(root)).toBe("根据 @合同 附件.pdf 起草");
  });

  it("uses data-alias, not the truncated visible label", () => {
    const root = document.createElement("div");
    const c = chip("非常长的文件名.pdf");
    c.textContent = "@非常长的…";
    root.append(document.createTextNode(" "), c, document.createTextNode(" "));
    expect(serializeEditor(root)).toBe(" @非常长的文件名.pdf ");
  });

  it("maps <br> to newline and recurses into wrapper elements", () => {
    const root = document.createElement("div");
    const wrap = document.createElement("span");
    wrap.append(document.createTextNode("第二行"));
    root.append(document.createTextNode("第一行"), document.createElement("br"), wrap);
    expect(serializeEditor(root)).toBe("第一行\n第二行");
  });
});
