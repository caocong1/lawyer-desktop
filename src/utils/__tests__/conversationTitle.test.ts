import { describe, expect, it } from "vitest";
import { validateConversationTitle } from "../conversationTitle";

describe("validateConversationTitle", () => {
  it("trims surrounding whitespace before checking length", () => {
    const result = validateConversationTitle("   股权转让协议   ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("股权转让协议");
  });

  it("rejects an empty value after trim", () => {
    const result = validateConversationTitle("   \n  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/不能为空|为空/);
  });

  it("rejects a value longer than 30 characters", () => {
    const tooLong = "测".repeat(31);
    const result = validateConversationTitle(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/30|过长|长度/);
  });

  it("accepts a value at the 30-character boundary", () => {
    const exact = "测".repeat(30);
    const result = validateConversationTitle(exact);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(30);
  });

  it("truncates a value that is over 30 chars after trim", () => {
    const tooLong = "测".repeat(40);
    const result = validateConversationTitle(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/30|过长|长度/);
  });
});
