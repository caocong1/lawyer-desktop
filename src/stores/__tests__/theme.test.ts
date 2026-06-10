import { describe, it, expect, beforeEach } from "vitest";
import { useTheme } from "../theme";

describe("theme store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to theme a", () => {
    const { theme } = useTheme();
    expect(theme()).toBe("a");
  });

  it("persists theme to localStorage", () => {
    const { setTheme } = useTheme();
    setTheme("b");
    expect(localStorage.getItem("ml-theme")).toBe("b");
  });
});
