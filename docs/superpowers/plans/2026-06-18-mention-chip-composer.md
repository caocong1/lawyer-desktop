# Mention Chip Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain-`<textarea>` composers in HomePage and ChatPanel with a shared `contenteditable` `MentionComposer` that renders `@file` mentions as atomic, styled, non-editable, truncated chips.

**Architecture:** A new shared SolidJS component wraps a single `contenteditable` `<div>` whose inner content is managed **imperatively via DOM APIs, never via Solid reactivity** (this prevents caret loss). Mentions are `<span contenteditable="false">` chip nodes. On every edit the component serializes its DOM back to the existing plain-text `@alias` string, so the send pipeline (`resolveInlineMentions`) and the Rust backend are untouched.

**Tech Stack:** SolidJS 1.9, TypeScript, Vite, Vitest + jsdom + `@solidjs/testing-library`, Tauri webview.

## Global Constraints

- **No backend/store/services changes.** Only `src/utils/mentions.ts`, the two composers, and the new `MentionComposer.{tsx,css}` change. The store API (`addContextRef`, `addInlineMention`, `removeInlineMention`, `pendingContextRefs`, `sendChatMessage`, `resolveInlineMentions`) stays as-is.
- **Existing `mentions.ts` exports keep their current signatures and behavior** — `resolveInlineMentions`, `findMentionIndex`, `buildMentionInsert`, `validateMentionPaths`, `isRefMentioned` are not modified. Only `detectAtTrigger` gains an optional 3rd argument (default preserves current behavior) and one new export `serializeEditor` is added.
- **Chips always serialize as `@<alias>` with a space (or line start) immediately before and a space immediately after.** This is required for `resolveInlineMentions` boundary matching, not just cosmetic.
- **Chinese IME must work**: suppress trigger detection while `compositionstart`/`compositionend` is active (mirrors the existing `e.isComposing` guard).
- **Test commands:** single file `npx vitest run src/utils/__tests__/mentions.test.ts`; full suite `npm test`; typecheck/build `npm run build` (runs `tsc -b && vite build`). Do NOT run `npm run tauri:dev` (needs Rust + the desktop shell).
- **Truncation is CSS-only** (`max-width` + `text-overflow: ellipsis`); the full alias is preserved in `data-alias`/`title`.
- Follow the repo's existing style: Chinese comments/strings where the surrounding code uses them, double-quoted imports, 2-space indent.

---

### Task 1: Extend `mentions.ts` — relaxed trigger + DOM serializer

**Files:**
- Modify: `src/utils/mentions.ts`
- Test: `src/utils/__tests__/mentions.test.ts`

**Interfaces:**
- Consumes: `ContextRefPayload` from `../types/contextRefs`.
- Produces:
  - `detectAtTrigger(text: string, cursorPos: number, opts?: { requireBoundary?: boolean }): { active: boolean; query: string; atPos: number }` — when `opts.requireBoundary === false`, `@` triggers regardless of the preceding character. Default (omitted/`true`) is the current behavior.
  - `serializeEditor(root: Node): string` — walks `root.childNodes` in document order: text nodes → their `textContent`; `.mc-chip` elements → `@` + `data-alias`; `<br>` → `"\n"`; any other element → recurse into its children. Returns the plain-text string the send pipeline expects.

- [ ] **Step 1: Write the failing tests** — append to `src/utils/__tests__/mentions.test.ts`:

```ts
import { detectAtTrigger, serializeEditor } from "../mentions";

describe("detectAtTrigger boundary option", () => {
  it("requires a boundary before @ by default", () => {
    expect(detectAtTrigger("据@", 2).active).toBe(false);
  });

  it("triggers after any char when requireBoundary is false", () => {
    const t = detectAtTrigger("据@证", 3, { requireBoundary: false });
    expect(t.active).toBe(true);
    expect(t.query).toBe("证");
    expect(t.atPos).toBe(1);
  });

  it("still stops at whitespace between @ and caret", () => {
    expect(detectAtTrigger("@ 证", 3, { requireBoundary: false }).active).toBe(false);
  });

  it("triggers at start of text", () => {
    expect(detectAtTrigger("@证", 2, { requireBoundary: false }).active).toBe(true);
  });
});

describe("serializeEditor", () => {
  function chip(alias: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = "mc-chip";
    el.setAttribute("data-alias", alias);
    el.textContent = `@${alias}`;
    return el;
  }

  it("serializes plain text verbatim", () => {
    const root = document.createElement("div");
    root.append(document.createTextNode("根据合同"));
    expect(serializeEditor(root)).toBe("根据合同");
  });

  it("serializes a chip as @alias and preserves surrounding spaces", () => {
    const root = document.createElement("div");
    root.append(
      document.createTextNode("根据 "),
      chip("合同 附件.pdf"),
      document.createTextNode(" 起草"),
    );
    expect(serializeEditor(root)).toBe("根据 @合同 附件.pdf 起草");
  });

  it("uses data-alias, not the truncated visible label", () => {
    const root = document.createElement("div");
    const c = chip("非常长的文件名.pdf");
    c.textContent = "@非常长的…"; // CSS would also truncate; data-alias is the source of truth
    root.append(document.createTextNode(" "), c, document.createTextNode(" "));
    expect(serializeEditor(root)).toBe(" @非常长的文件名.pdf ");
  });

  it("maps <br> to newline and recurses into wrapper elements", () => {
    const root = document.createElement("div");
    const wrap = document.createElement("span");
    wrap.append(document.createTextNode("第二行"));
    root.append(document.createTextNode("第一行"), document.createElement("br"), wrap);
    expect(serializeEditor(root)).toBe("第一行\n第二行");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/mentions.test.ts`
Expected: FAIL — `serializeEditor is not a function` and the `requireBoundary` cases fail.

- [ ] **Step 3: Implement the changes in `src/utils/mentions.ts`**

Replace the existing `detectAtTrigger` with this version (only the `@` branch and the new param change):

```ts
export function detectAtTrigger(
  text: string,
  cursorPos: number,
  opts: { requireBoundary?: boolean } = {},
) {
  const requireBoundary = opts.requireBoundary !== false;
  const pos = Math.min(cursorPos, text.length);
  let i = pos - 1;

  while (i >= 0) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      return { active: false, query: "", atPos: -1 };
    }
    if (ch === "@") {
      const atPos = i;
      if (!requireBoundary || atPos === 0 || /\s/.test(text[atPos - 1]!)) {
        const query = text.slice(atPos + 1, pos);
        return { active: true, query, atPos };
      }
      return { active: false, query: "", atPos: -1 };
    }
    i--;
  }

  return { active: false, query: "", atPos: -1 };
}
```

Append the serializer at the end of the file:

```ts
/** Walk a contenteditable root into the plain-text @alias string the send
 *  pipeline (resolveInlineMentions) consumes. Chips contribute their full
 *  data-alias, not their (CSS-truncated) visible label. */
export function serializeEditor(root: Node): string {
  let out = "";
  for (const node of Array.from(root.childNodes)) {
    out += serializeNode(node);
  }
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const el = node as HTMLElement;
  if (el.tagName === "BR") {
    return "\n";
  }
  if (el.classList.contains("mc-chip")) {
    return `@${el.getAttribute("data-alias") ?? ""}`;
  }
  let inner = "";
  for (const child of Array.from(el.childNodes)) {
    inner += serializeNode(child);
  }
  return inner;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/mentions.test.ts`
Expected: PASS (all new tests + the 5 existing resolution tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/mentions.ts src/utils/__tests__/mentions.test.ts
git commit -m "feat(mentions): add relaxed @ trigger option and contenteditable serializer"
```

---

### Task 2: Build the shared `MentionComposer` component

**Files:**
- Create: `src/components/MentionComposer.tsx`
- Create: `src/components/MentionComposer.css`
- Test: `src/components/__tests__/MentionComposer.test.tsx`

**Interfaces:**
- Consumes: `detectAtTrigger`, `filterMentionCandidates`, `serializeEditor` from `../utils/mentions`; `MentionMenu` from `./MentionMenu`; `ContextRefPayload` from `../types/contextRefs`.
- Produces:

```ts
export interface MentionComposerApi {
  focus(): void;
  clear(): void;
  getText(): string;
  isEmpty(): boolean;
  insertText(s: string): void;        // append text at the end (example prompts)
  insertMention(ref: ContextRefPayload): void;  // insert chip at saved caret / end
  promptMention(): void;              // open the file menu for the @ button
}

export interface MentionComposerProps {
  candidates: ContextRefPayload[];
  placeholder: string;
  disabled?: boolean;
  class?: string;                     // appended to the wrapper for parent sizing
  onInput: (serializedText: string) => void;
  onInsertMention: (ref: ContextRefPayload) => void;
  onRemoveMention?: (path: string) => void;
  onSend: () => void;
  onReady?: (api: MentionComposerApi) => void;
}
```

- [ ] **Step 1: Write the failing component test** — create `src/components/__tests__/MentionComposer.test.tsx`:

```tsx
import { render, cleanup } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "../MentionComposer";
import type { MentionComposerApi } from "../MentionComposer";
import type { ContextRefPayload } from "../../types/contextRefs";

afterEach(cleanup);

const ref: ContextRefPayload = {
  alias: "合同 附件.pdf",
  path: "C:\\cases\\a\\合同 附件.pdf",
  kind: "file",
};

function setup(extra?: Partial<Record<string, unknown>>) {
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
    // leading space added (prev char 据 is not whitespace) + trailing space
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
    api.insertText(""); // triggers emitChange → diff detects the removed chip
    expect(onRemoveMention).toHaveBeenCalledWith(ref.path);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/__tests__/MentionComposer.test.tsx`
Expected: FAIL — cannot resolve `../MentionComposer`.

- [ ] **Step 3: Create `src/components/MentionComposer.css`**

```css
.mc-composer {
  position: relative;
  width: 100%;
}

.mc-editor {
  width: 100%;
  min-height: 64px;
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  outline: none;
  border: none;
  background: transparent;
  font: inherit;
  color: var(--ink);
  line-height: 1.6;
}

.mc-editor.is-empty::before {
  content: attr(data-placeholder);
  color: var(--muted);
  pointer-events: none;
}

.mc-editor[contenteditable="false"] {
  opacity: 0.6;
  cursor: not-allowed;
}

.mc-chip {
  display: inline-flex;
  align-items: baseline;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: baseline;
  margin: 0 1px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 0.9em;
  line-height: 1.4;
  cursor: default;
  user-select: all;
}

.mc-at-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}

.mc-menu-wrap {
  position: absolute;
  left: 0;
  top: 100%;
  z-index: 30;
}
```

- [ ] **Step 4: Create `src/components/MentionComposer.tsx`** with the full implementation:

```tsx
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ContextRefPayload } from "../types/contextRefs";
import { detectAtTrigger, filterMentionCandidates, serializeEditor } from "../utils/mentions";
import { MentionMenu } from "./MentionMenu";
import "./MentionComposer.css";

export interface MentionComposerApi {
  focus(): void;
  clear(): void;
  getText(): string;
  isEmpty(): boolean;
  insertText(s: string): void;
  insertMention(ref: ContextRefPayload): void;
  promptMention(): void;
}

export interface MentionComposerProps {
  candidates: ContextRefPayload[];
  placeholder: string;
  disabled?: boolean;
  class?: string;
  onInput: (serializedText: string) => void;
  onInsertMention: (ref: ContextRefPayload) => void;
  onRemoveMention?: (path: string) => void;
  onSend: () => void;
  onReady?: (api: MentionComposerApi) => void;
}

interface AtContext {
  node: Text;
  atOffset: number;
  caretOffset: number;
  query: string;
}

export function MentionComposer(props: MentionComposerProps) {
  let editor!: HTMLDivElement;
  let menuWrap: HTMLDivElement | undefined;
  let composing = false;
  let savedRange: Range | null = null;
  let triggerCtx: AtContext | null = null;
  let lastChipPaths = new Set<string>();

  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuMode, setMenuMode] = createSignal<"trigger" | "button">("trigger");
  const [menuQuery, setMenuQuery] = createSignal("");
  const [menuIndex, setMenuIndex] = createSignal(0);

  const filtered = createMemo(() =>
    filterMentionCandidates(props.candidates, menuQuery()),
  );

  function getText(): string {
    return serializeEditor(editor);
  }

  function emitChange() {
    const text = getText();
    props.onInput(text);
    editor.classList.toggle("is-empty", text.length === 0);
    const current = new Set(
      Array.from(editor.querySelectorAll<HTMLElement>(".mc-chip")).map(
        (c) => c.getAttribute("data-path") ?? "",
      ),
    );
    for (const path of lastChipPaths) {
      if (path && !current.has(path)) props.onRemoveMention?.(path);
    }
    lastChipPaths = current;
  }

  function closeMenu() {
    setMenuOpen(false);
    triggerCtx = null;
  }

  function placeCaretAfter(node: Node) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
  }

  function endRange(): Range {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    return range;
  }

  function activeRange(): Range {
    if (savedRange && editor.contains(savedRange.startContainer)) {
      return savedRange.cloneRange();
    }
    return endRange();
  }

  function insertTextAtCaret(s: string) {
    const range = activeRange();
    range.deleteContents();
    const node = document.createTextNode(s);
    range.insertNode(node);
    placeCaretAfter(node);
    emitChange();
  }

  // True when a space must be inserted before the chip: there is a char
  // immediately before the insertion point and it is not whitespace.
  function needsLeadingSpace(range: Range): boolean {
    const { startContainer, startOffset } = range;
    if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
      return !/\s/.test((startContainer.textContent ?? "")[startOffset - 1] ?? "");
    }
    const prev =
      startContainer.nodeType === Node.TEXT_NODE
        ? startContainer.previousSibling
        : startContainer.childNodes[startOffset - 1] ?? null;
    if (!prev) return false; // line start
    if (prev.nodeType === Node.TEXT_NODE) {
      const t = prev.textContent ?? "";
      return t.length > 0 && !/\s/.test(t[t.length - 1]!);
    }
    return true; // previous node is a chip/element → separate them
  }

  function makeChip(ref: ContextRefPayload): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    chip.contentEditable = "false";
    chip.setAttribute("data-path", ref.path);
    chip.setAttribute("data-alias", ref.alias);
    chip.setAttribute("title", ref.alias);
    chip.textContent = `@${ref.alias}`;
    return chip;
  }

  function insertMentionAt(ref: ContextRefPayload, ctx: AtContext | null) {
    editor.focus();
    let range: Range;
    if (ctx) {
      range = document.createRange();
      range.setStart(ctx.node, ctx.atOffset);
      range.setEnd(ctx.node, ctx.caretOffset);
      range.deleteContents();
      range.collapse(true);
    } else {
      range = activeRange();
      range.deleteContents();
    }

    const frag = document.createDocumentFragment();
    if (needsLeadingSpace(range)) frag.appendChild(document.createTextNode(" "));
    frag.appendChild(makeChip(ref));
    const trailing = document.createTextNode(" ");
    frag.appendChild(trailing);
    range.insertNode(frag);
    placeCaretAfter(trailing);

    props.onInsertMention(ref);
    emitChange();
    closeMenu();
  }

  function getAtContext(): AtContext | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.endContainer;
    if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return null;
    const caretOffset = range.endOffset;
    const upToCaret = (node.textContent ?? "").slice(0, caretOffset);
    const trig = detectAtTrigger(upToCaret, caretOffset, { requireBoundary: false });
    if (!trig.active) return null;
    return { node: node as Text, atOffset: trig.atPos, caretOffset, query: trig.query };
  }

  function updateTrigger() {
    if (composing) return;
    const ctx = getAtContext();
    if (ctx && props.candidates.length > 0) {
      triggerCtx = ctx;
      setMenuMode("trigger");
      setMenuQuery(ctx.query);
      setMenuIndex(0);
      setMenuOpen(true);
    } else if (menuMode() === "trigger") {
      closeMenu();
    }
  }

  function handleSelect(ref: ContextRefPayload) {
    const ctx = menuMode() === "trigger" ? getAtContext() ?? triggerCtx : null;
    insertMentionAt(ref, ctx);
  }

  function handleInput() {
    if (composing) return;
    emitChange();
    updateTrigger();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (menuOpen()) {
      const cands = filtered();
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        return;
      }
      if (cands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMenuIndex((i) => (i + 1) % cands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMenuIndex((i) => (i - 1 + cands.length) % cands.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const ref = cands[menuIndex()];
          if (ref) handleSelect(ref);
          return;
        }
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      props.onSend();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      insertTextAtCaret("\n");
    }
  }

  function handlePaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) insertTextAtCaret(text);
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (editor.contains(range.startContainer)) {
      savedRange = range.cloneRange();
      updateTrigger();
    }
  }

  function onDocClick(e: MouseEvent) {
    if (
      menuOpen() &&
      menuWrap &&
      !menuWrap.contains(e.target as Node) &&
      !editor.contains(e.target as Node)
    ) {
      closeMenu();
    }
  }

  onMount(() => {
    editor.classList.add("is-empty");
    editor.addEventListener("compositionstart", () => (composing = true));
    editor.addEventListener("compositionend", () => {
      composing = false;
      emitChange();
      updateTrigger();
    });
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("click", onDocClick);

    const api: MentionComposerApi = {
      focus: () => editor.focus(),
      clear: () => {
        editor.replaceChildren();
        emitChange();
      },
      getText,
      isEmpty: () => getText().length === 0,
      insertText: (s: string) => {
        editor.focus();
        const node = document.createTextNode(s);
        editor.appendChild(node);
        placeCaretAfter(node);
        emitChange();
      },
      insertMention: (ref: ContextRefPayload) => insertMentionAt(ref, null),
      promptMention: () => {
        editor.focus();
        setMenuMode("button");
        setMenuQuery("");
        setMenuIndex(0);
        setMenuOpen(true);
      },
    };
    props.onReady?.(api);

    onCleanup(() => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("click", onDocClick);
    });
  });

  return (
    <div class={`mc-composer${props.class ? ` ${props.class}` : ""}`}>
      <div
        ref={editor}
        class="mc-editor"
        contentEditable={props.disabled ? false : true}
        data-placeholder={props.placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      <Show when={menuOpen() && props.candidates.length > 0}>
        <div class="mc-menu-wrap" ref={menuWrap}>
          <MentionMenu
            candidates={filtered()}
            selectedIndex={menuIndex()}
            onSelect={handleSelect}
            onDismiss={closeMenu}
          />
        </div>
      </Show>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/__tests__/MentionComposer.test.tsx`
Expected: PASS — all five cases.

> Note: jsdom's `Selection`/`Range` support is partial, so live-typing trigger flow is covered by manual UAT (Task 5), not these tests. The tests drive the deterministic imperative API (`insertText`/`insertMention`/`clear`) and the DOM-diff chip removal.

- [ ] **Step 6: Commit**

```bash
git add src/components/MentionComposer.tsx src/components/MentionComposer.css src/components/__tests__/MentionComposer.test.tsx
git commit -m "feat: add shared contenteditable MentionComposer with atomic chips"
```

---

### Task 3: Integrate `MentionComposer` into HomePage

**Files:**
- Modify: `src/components/home/HomePage.tsx`
- Modify: `src/components/home/HomePage.css` (chip/editor sizing only)

**Interfaces:**
- Consumes: `MentionComposer`, `MentionComposerApi` from `../MentionComposer`.
- Produces: no new exports.

- [ ] **Step 1: Rewrite the composer wiring in `HomePage.tsx`**

Remove these now-unused pieces:
- the import line `import { MentionMenu } from "../MentionMenu";`
- the import `import { detectAtTrigger, filterMentionCandidates, buildMentionInsert } from "../../utils/mentions";`
- the signals `mentionOpen`, `mentionQuery`, `mentionIndex` and the refs `inputRef`, `mentionMenuRef`
- the `mentionCandidates` memo and the `insertMention` function
- the document-click handler's `mentionOpen()` branch (lines that close the mention menu)

Add the import:

```tsx
import { MentionComposer } from "../MentionComposer";
import type { MentionComposerApi } from "../MentionComposer";
```

Add a controller holder near the other `let` refs:

```tsx
let composer: MentionComposerApi | undefined;
let attachRef: HTMLDivElement | undefined;
```

Replace `insertExamplePrompt` body so it routes through the controller:

```tsx
function insertExamplePrompt(prompt: string) {
  const next = input().trim() ? `${input().trimEnd()}\n\n${prompt}` : prompt;
  composer?.clear();
  composer?.insertText(next);
}
```

Replace the entire `<div class="starter-field"> … </div>` block (the `<textarea>` + `<Show>` mention wrap) with:

```tsx
<div class="starter-field">
  <MentionComposer
    class="starter-input"
    placeholder="描述你的法律需求，例如：起草一份股权转让协议，或附加本地资料后生成诉讼方案…"
    candidates={pendingContextRefs()}
    onReady={(api) => (composer = api)}
    onInput={(text) => setInput(text)}
    onInsertMention={(ref) => {
      addContextRef(ref);
      addInlineMention(ref.path);
    }}
    onRemoveMention={(path) => removeInlineMention(path)}
    onSend={() => {
      if (canSend()) props.onStart(input().trim());
    }}
  />
</div>
```

In the `starter-bar`, add the `@` button next to 附加资料 (right after the `attach-wrap` div closes):

```tsx
<button
  type="button"
  class="tool tool-btn mc-at-btn"
  title="插入文件引用"
  onClick={() => composer?.promptMention()}
>
  @
</button>
```

Pull `removeInlineMention` into the destructure from `useConversation()`:

```tsx
const {
  pendingContextRefs,
  addContextRef,
  removeContextRef,
  addInlineMention,
  removeInlineMention,
} = useConversation();
```

- [ ] **Step 2: Add HomePage sizing overrides to `HomePage.css`**

Append:

```css
.starter-field .mc-editor {
  min-height: 96px;
  font-size: 15px;
}
```

(Keep any existing `.starter-input` rules that set padding/typography; they still apply because the wrapper carries that class.)

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: `tsc -b` passes with no errors (vite build also succeeds). If `tsc` flags an unused import/signal, remove it.

- [ ] **Step 4: Commit**

```bash
git add src/components/home/HomePage.tsx src/components/home/HomePage.css
git commit -m "feat(home): use MentionComposer with atomic mention chips and @ button"
```

---

### Task 4: Integrate `MentionComposer` into ChatPanel

**Files:**
- Modify: `src/components/workspace/ChatPanel.tsx`
- Modify: `src/components/workspace/ChatPanel.css` (chip/editor sizing only)

**Interfaces:**
- Consumes: `MentionComposer`, `MentionComposerApi` from `../MentionComposer`.

- [ ] **Step 1: Rewrite the composer wiring in `ChatPanel.tsx`**

Remove now-unused pieces:
- the import `import { MentionMenu } from "../MentionMenu";`
- the import `import { detectAtTrigger, filterMentionCandidates, buildMentionInsert } from "../../utils/mentions";`
- the signals `mentionOpen`, `mentionQuery`, `mentionIndex`; refs `taRef`, `mentionMenuRef`
- the `mentionCandidates` memo, the `grow` function, the `insertMention` function, and the mention branch inside `onKey`
- the `mentionOpen()` branch in the document-click handler

Add:

```tsx
import { MentionComposer } from "../MentionComposer";
import type { MentionComposerApi } from "../MentionComposer";
```

Add a controller holder near the other refs:

```tsx
let composer: MentionComposerApi | undefined;
```

Ensure `removeInlineMention` is in the `useConversation()` destructure (add it if absent).

Update `send()` to clear via the controller:

```tsx
function send() {
  const t = text().trim();
  if (!t || props.sending()) return;
  setText("");
  composer?.clear();
  props.onSend(t);
}
```

Update the suggestion-fill handler at line ~440 (currently `setText(prompt)`) to also push into the editor:

```tsx
composer?.clear();
composer?.insertText(prompt);
setText(prompt);
```

Replace the `<div class="textarea-wrap"> … </div>` block (textarea + mention `<Show>`) with:

```tsx
<div class="textarea-wrap">
  <MentionComposer
    class="chat-input"
    placeholder="补充指示，或描述新的起草需求……"
    disabled={props.sending()}
    candidates={pendingContextRefs()}
    onReady={(api) => (composer = api)}
    onInput={(value) => setText(value)}
    onInsertMention={(ref) => {
      addContextRef(ref);
      addInlineMention(ref.path);
    }}
    onRemoveMention={(path) => removeInlineMention(path)}
    onSend={send}
  />
</div>
```

In the `input-row`, add the `@` button right after the `attach-wrap` div:

```tsx
<button
  type="button"
  class="tool mc-at-btn"
  title="插入文件引用"
  disabled={props.sending()}
  onClick={() => composer?.promptMention()}
>
  @
</button>
```

- [ ] **Step 2: Add ChatPanel sizing overrides to `ChatPanel.css`**

Append:

```css
.textarea-wrap .mc-editor {
  min-height: 24px;
  max-height: 120px;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: `tsc -b` passes. Remove any import/signal `tsc` reports as unused (e.g. `createMemo` if no longer used, `buildMentionInsert`).

- [ ] **Step 4: Commit**

```bash
git add src/components/workspace/ChatPanel.tsx src/components/workspace/ChatPanel.css
git commit -m "feat(chat): use MentionComposer with atomic mention chips and @ button"
```

---

### Task 5: Full verification + manual UAT

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all tests pass, including `mentions.test.ts` and `MentionComposer.test.tsx`.

- [ ] **Step 2: Typecheck + production build**

Run: `npm run build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 3: Manual UAT in the running app** (`npm run tauri:dev`, launched by the user)

Verify on both the Home composer and the in-workspace ChatPanel:
- Type `@` immediately after a Chinese character (e.g. `据@`) → the file menu opens (ask #1).
- Pick a file → a styled chip appears with exactly one space before and one space after (ask #2).
- Click the `@` button in the bottom bar → menu opens; pick a file → chip inserts at the cursor (or end if the editor was not focused) (ask #3).
- The chip is atomic: clicking it does not place a caret inside; Backspace deletes the whole chip; you cannot edit its text (ask #4).
- A long filename shows truncated with `…`; hovering shows the full name (ask #4).
- Type a Chinese query after `@` via the IME (composition) → candidates filter correctly, no premature menu close.
- Send a message that contains a chip → the referenced file is actually attached (the assistant receives it). Confirm by checking that the resolved refs match (the top attachment chip remains; the turn uses the mentioned file).
- Removing a chip (Backspace) leaves the top attachment chip intact (removal is inline-mention only).

- [ ] **Step 4: Final commit (if any UAT fixes were needed)**

```bash
git add -A
git commit -m "fix: address mention composer UAT findings"
```

---

## Self-Review

**Spec coverage:**
- Ask #1 (trigger anywhere) → Task 1 (`requireBoundary` option) + Task 2 (`updateTrigger` passes `requireBoundary:false`). ✓
- Ask #2 (auto-spaces) → Task 2 (`needsLeadingSpace` + trailing space in `insertMentionAt`); tested in Task 2 Step 1. ✓
- Ask #3 (@ button) → Task 2 (`promptMention`) + Tasks 3 & 4 (button in each bar). ✓
- Ask #4 (atomic styled truncated chips) → Task 2 (`makeChip` with `contenteditable="false"`, `data-alias`/`title`) + CSS (`max-width`/ellipsis). ✓
- Shared component / no duplication → Tasks 2–4. ✓
- No backend/store changes → enforced by Global Constraints; serialization keeps `resolveInlineMentions` working. ✓
- IME, paste, placeholder, auto-grow, keys → Task 2. ✓
- Tests → Tasks 1, 2; manual UAT → Task 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code. ✓

**Type consistency:** `MentionComposerApi`/`MentionComposerProps` defined once in Task 2 and consumed identically in Tasks 3–4; `detectAtTrigger(text, pos, { requireBoundary })`, `serializeEditor(root)` signatures match between Task 1 definition and Task 2 use. ✓
