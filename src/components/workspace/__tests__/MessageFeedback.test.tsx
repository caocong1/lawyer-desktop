import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Message } from "../../../stores/conversation";
import { MessageFeedback } from "../MessageFeedback";

function assistantMessage(feedback: NonNullable<Message["metadata"]>["feedback"]): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    role: "assistant",
    content: "answer",
    metadata: { feedback },
    created_at: "2026-06-18T10:00:00Z",
  };
}

describe("MessageFeedback editable marked state", () => {
  it("keeps controls visible and opens a prefilled edit form", () => {
    render(() => (
      <MessageFeedback
        message={assistantMessage({
          rating: "up",
          comment: "旧备注",
          dimensions: ["法条"],
          at: "2026-06-18T10:00:00Z",
        })}
      />
    ));

    expect(screen.getByTitle("有帮助").className).toContain("active");
    expect(screen.getByTitle("需改进")).toBeTruthy();
    expect(screen.getByText("✓ 已标记：有帮助 · 法条")).toBeTruthy();

    fireEvent.click(screen.getByText("修改补充说明"));

    const textarea = screen.getByPlaceholderText(
      "可选：一句话说明哪里好/哪里需改",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("旧备注");
    expect(screen.getByText("法条").className).toContain("on");
  });

  it("opens the edit form when switching from up to down", () => {
    render(() => (
      <MessageFeedback
        message={assistantMessage({
          rating: "up",
          at: "2026-06-18T10:00:00Z",
        })}
      />
    ));

    fireEvent.click(screen.getByTitle("需改进"));

    expect(screen.getByPlaceholderText("可选：一句话说明哪里好/哪里需改")).toBeTruthy();
  });
});
