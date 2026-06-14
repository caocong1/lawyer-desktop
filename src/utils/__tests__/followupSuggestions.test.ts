import { describe, expect, it } from "vitest";
import { fallbackFollowupSuggestions } from "../followupSuggestions";

describe("fallbackFollowupSuggestions", () => {
  it("returns evidence-specific actions for evidence mode", () => {
    const items = fallbackFollowupSuggestions("evidence");
    expect(items).toHaveLength(3);
    expect(items.join("")).toContain("证据");
  });

  it("returns drafting actions for draft mode", () => {
    const items = fallbackFollowupSuggestions("draft");
    expect(items).toHaveLength(3);
    expect(items.join("")).toContain("条款");
  });

  it("returns generic actions for chat or unknown modes", () => {
    expect(fallbackFollowupSuggestions("chat")).toHaveLength(3);
    expect(fallbackFollowupSuggestions(undefined)).toHaveLength(3);
  });

  it("keeps every suggestion a clickable short prompt (4-18 chars)", () => {
    for (const mode of ["evidence", "draft", "chat", undefined]) {
      for (const item of fallbackFollowupSuggestions(mode)) {
        expect(item.length).toBeGreaterThanOrEqual(4);
        expect(item.length).toBeLessThanOrEqual(18);
      }
    }
  });
});
