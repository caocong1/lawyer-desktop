export type Rating = "up" | "down";

export interface FeedbackState {
  rating: Rating;
  comment?: string;
  dimensions?: string[];
  at: string;
}

export function feedbackStatusText(fb: FeedbackState | undefined): string {
  if (!fb) return "";
  const base = fb.rating === "up" ? "已标记：有帮助" : "已标记：需改进";
  const dims = fb.dimensions?.length ? ` · ${fb.dimensions.join("、")}` : "";
  return `✓ ${base}${dims}`;
}

/**
 * Decide what a click on a rating button does when feedback may already exist.
 * - Clicking 👎 always opens the form (encourage a reason).
 * - Clicking the already-active 👍 opens the form to edit the note (no dead re-upload).
 * - Otherwise switch to 👍 and submit immediately.
 */
export function ratingClickAction(
  current: Rating | undefined,
  clicked: Rating,
): "submit-up" | "open-form" {
  if (clicked === "down") return "open-form";
  if (current === "up") return "open-form";
  return "submit-up";
}
