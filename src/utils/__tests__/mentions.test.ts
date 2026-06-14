import { describe, expect, it } from "vitest";
import type { ContextRefPayload } from "../../types/contextRefs";
import {
  isRefMentioned,
  resolveInlineMentions,
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
