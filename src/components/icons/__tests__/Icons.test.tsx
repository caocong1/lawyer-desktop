import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { Icon, Icons, type IconName } from "../Icons";

describe("Icon", () => {
  it("renders independent DOM nodes when the same icon is used multiple times", () => {
    const { container } = render(() => (
      <div>
        <Icon name="trash" />
        <Icon name="trash" />
        <Icon name="trash" />
      </div>
    ));

    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) {
      expect(svg.childElementCount).toBeGreaterThan(0);
    }
  });

  it("renders visible content for every registered icon", () => {
    const names = Object.keys(Icons) as IconName[];
    const { container } = render(() => (
      <div>
        {names.map((name) => (
          <Icon name={name} />
        ))}
      </div>
    ));

    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(names.length);
    for (const svg of svgs) {
      expect(svg.childElementCount).toBeGreaterThan(0);
    }
  });

  it("keeps earlier mounts intact when another component renders the same icon", () => {
    const first = render(() => <Icon name="doc" />);
    const second = render(() => <Icon name="doc" />);

    expect(first.container.querySelector("svg")?.childElementCount).toBeGreaterThan(0);
    expect(second.container.querySelector("svg")?.childElementCount).toBeGreaterThan(0);
  });

  it("updates rendered paths when the icon name changes", () => {
    let setName!: (next: IconName) => void;
    const { container } = render(() => {
      const [name, set] = createSignal<IconName>("check");
      setName = set;
      return <Icon name={name()} />;
    });

    const pathData = () =>
      Array.from(container.querySelectorAll("path")).map((p) => p.getAttribute("d"));

    expect(pathData()).toEqual(["M4 12l5 5L20 6"]);

    setName("trash");

    expect(pathData()).not.toContain("M4 12l5 5L20 6");
    expect(pathData()).toEqual([
      "M3 6h18",
      "M8 6V4h8v2",
      "M6 6l1 15h10l1-15",
      "M10 11v6M14 11v6",
    ]);
  });
});
