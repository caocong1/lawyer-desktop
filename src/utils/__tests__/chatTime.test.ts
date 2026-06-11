import { describe, expect, it } from "vitest";
import {
  parseTimeMs,
  shouldShowTimeDivider,
} from "../chatTime";

describe("chat time helpers", () => {
  it("shows the first timestamp and hides dense nearby timestamps", () => {
    const first = Date.parse("2026-06-11T10:00:00+08:00");
    const nearby = Date.parse("2026-06-11T10:04:59+08:00");

    expect(shouldShowTimeDivider(undefined, first)).toBe(true);
    expect(shouldShowTimeDivider(first, nearby)).toBe(false);
  });

  it("shows timestamps after five minutes or across dates", () => {
    const first = Date.parse("2026-06-11T10:00:00+08:00");
    const afterGap = Date.parse("2026-06-11T10:05:00+08:00");
    const nextDay = Date.parse("2026-06-12T00:01:00+08:00");

    expect(shouldShowTimeDivider(first, afterGap)).toBe(true);
    expect(shouldShowTimeDivider(first, nextDay)).toBe(true);
  });

  it("parses ISO strings and preserves numeric timestamps", () => {
    const ms = Date.parse("2026-06-11T10:00:00+08:00");

    expect(parseTimeMs("2026-06-11T10:00:00+08:00")).toBe(ms);
    expect(parseTimeMs(ms)).toBe(ms);
    expect(parseTimeMs("not a date")).toBeUndefined();
  });
});
