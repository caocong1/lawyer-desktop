import { render, cleanup } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "../MentionComposer";
import type { MentionComposerApi, MentionComposerProps } from "../MentionComposer";
import type { ContextRefPayload } from "../../types/contextRefs";

afterEach(cleanup);

const ref: ContextRefPayload = {
  alias: "合同 附件.pdf",
  path: "C:\\cases\\a\\合同 附件.pdf",
  kind: "file",
};

function setup(extra?: Partial<MentionComposerProps>) {
  let api!: MentionComposerApi;
  const onInput = vi.fn();
  const onInsertMention = vi.fn();
  const { container } = render(() => (
    <MentionComposer
      candidates={[ref]}
      placeholder="描述你的需求"
      onInput={onInput}
      onInsertMention={onInsertMention}
      onSend={() => {}}
      onReady={(a) => (api = a)}
      {...extra}
    />
  ));
  return { api, onInput, onInsertMention, container };
}

describe("MentionComposer", () => {
  it("renders an empty contenteditable with the placeholder", () => {
    const { container } = setup();
    const editor = container.querySelector(".mc-editor") as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.getAttribute("data-placeholder")).toBe("描述你的需求");
    expect(editor.classList.contains("is-empty")).toBe(true);
  });

  it("insertText appends text and emits the serialized value", () => {
    const { api, onInput, container } = setup();
    api.insertText("根据");
    const editor = container.querySelector(".mc-editor") as HTMLElement;
    expect(api.getText()).toBe("根据");
    expect(api.isEmpty()).toBe(false);
    expect(editor.classList.contains("is-empty")).toBe(false);
    expect(onInput).toHaveBeenCalledWith("根据");
  });

  it("insertMention inserts an atomic chip with surrounding spaces", () => {
    const { api, onInsertMention, container } = setup();
    api.insertText("根据");
    api.insertMention(ref);
    const chip = container.querySelector(".mc-chip") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.getAttribute("data-path")).toBe(ref.path);
    expect(chip.getAttribute("data-alias")).toBe(ref.alias);
    expect(chip.getAttribute("title")).toBe(ref.alias);
    expect(api.getText()).toBe("根据 @合同 附件.pdf ");
    expect(onInsertMention).toHaveBeenCalledWith(ref);
  });

  it("clear empties the editor and reports empty", () => {
    const { api, container } = setup();
    api.insertText("根据");
    api.clear();
    expect(api.getText()).toBe("");
    expect(api.isEmpty()).toBe(true);
    expect((container.querySelector(".mc-editor") as HTMLElement).classList.contains("is-empty")).toBe(true);
  });

  it("calls onRemoveMention for a chip removed from the DOM", () => {
    let api!: MentionComposerApi;
    const onRemoveMention = vi.fn();
    const { container } = render(() => (
      <MentionComposer
        candidates={[ref]}
        placeholder="x"
        onInput={() => {}}
        onInsertMention={() => {}}
        onRemoveMention={onRemoveMention}
        onSend={() => {}}
        onReady={(a) => (api = a)}
      />
    ));
    api.insertMention(ref);
    (container.querySelector(".mc-chip") as HTMLElement).remove();
    api.insertText("");
    expect(onRemoveMention).toHaveBeenCalledWith(ref.path);
  });
});
