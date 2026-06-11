import { describe, expect, it } from "vitest";
import { isVisibleChatMessage } from "../chatVisibility";

describe("chat visibility", () => {
  it("hides technical user messages marked as content_hidden", () => {
    expect(
      isVisibleChatMessage({
        role: "user",
        metadata: { content_hidden: true },
      }),
    ).toBe(false);
  });

  it("keeps assistant summaries visible even when content is hidden", () => {
    expect(
      isVisibleChatMessage({
        role: "assistant",
        metadata_json: JSON.stringify({ content_hidden: true }),
      }),
    ).toBe(true);
  });

  it("filters non-chat roles", () => {
    expect(isVisibleChatMessage({ role: "tool" })).toBe(false);
  });
});
