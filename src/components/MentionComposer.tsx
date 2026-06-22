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
    if (!prev) return false;
    if (prev.nodeType === Node.TEXT_NODE) {
      const t = prev.textContent ?? "";
      return t.length > 0 && !/\s/.test(t[t.length - 1]!);
    }
    return true;
  }

  function makeChip(ref: ContextRefPayload): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    chip.contentEditable = "false";
    chip.setAttribute("contenteditable", "false");
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
