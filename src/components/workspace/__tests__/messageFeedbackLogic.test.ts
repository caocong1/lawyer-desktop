import { describe, expect, it } from "vitest";
import {
  feedbackStatusText,
  ratingClickAction,
} from "../messageFeedbackLogic";

describe("feedbackStatusText", () => {
  it("renders up with dimensions", () => {
    expect(
      feedbackStatusText({ rating: "up", dimensions: ["法条", "结构"], at: "x" }),
    ).toBe("✓ 已标记：有帮助 · 法条、结构");
  });
  it("renders down without dimensions", () => {
    expect(feedbackStatusText({ rating: "down", at: "x" })).toBe("✓ 已标记：需改进");
  });
  it("is empty when no feedback", () => {
    expect(feedbackStatusText(undefined)).toBe("");
  });
});

describe("ratingClickAction", () => {
  it("submits up when not yet up", () => {
    expect(ratingClickAction(undefined, "up")).toBe("submit-up");
    expect(ratingClickAction("down", "up")).toBe("submit-up");
  });
  it("opens the form when re-clicking the active up", () => {
    expect(ratingClickAction("up", "up")).toBe("open-form");
  });
  it("opens the form for down (to capture a reason)", () => {
    expect(ratingClickAction(undefined, "down")).toBe("open-form");
    expect(ratingClickAction("up", "down")).toBe("open-form");
  });
});
