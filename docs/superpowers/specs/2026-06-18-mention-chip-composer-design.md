# Mention Chip Composer — Design

Date: 2026-06-18
Status: Approved (pending spec review)

## Problem

Both composers — the Home landing composer (`src/components/home/HomePage.tsx`)
and the in-workspace composer (`src/components/workspace/ChatPanel.tsx`) — are
plain `<textarea>` elements whose value is a plain string. `@file` mentions live
in that string as ordinary, editable text and are resolved to context refs only
at send time by `resolveInlineMentions` (`src/utils/mentions.ts`). The mention
logic is duplicated across both files.

The user wants four changes:

1. **Trigger anywhere.** Today the `@` autocomplete only opens when `@` is
   preceded by whitespace or the start of the input (`detectAtTrigger`). It
   should open after any character (e.g. `据@`).
2. **Auto-spaces on insert.** After picking a file, insert a space before *and*
   after the mention. Today only a trailing space is added.
3. **`@` button.** Add a button to each composer's bottom bar that opens the
   file dropdown and inserts the chosen mention at the current cursor position.
4. **Atomic mention chips.** Render `@filename` as a specially-styled chip that
   the user cannot click into and edit, with a truncated label (the user's
   example: `@文名`).

Ask #4 is impossible in a `<textarea>`: a textarea holds only plain text, cannot
render a styled inline element, cannot make a sub-range non-editable, and cannot
display text different from its value. Delivering #4 requires a `contenteditable`
rich input.

## Decisions

- **Approach:** Full `contenteditable` editor with real atomic chips (chosen
  over a textarea-mirror highlight overlay, which cannot make a mention
  non-editable nor truncate its label).
- **Scope:** One shared `MentionComposer` component used by *both* composers,
  removing the duplicated mention logic.
- **Truncation:** CSS `max-width` + `text-overflow: ellipsis`, full name shown
  on hover via `title`. No information loss; the real `@alias` is preserved in
  the chip's data and serialization.

## Architecture

### New: `src/components/MentionComposer.tsx`

A SolidJS component wrapping a single `contenteditable` `<div>`. **The inner
content is managed imperatively via DOM APIs, never via Solid reactivity.** Solid
renders the empty editor shell once; keystrokes and chip insertions mutate the
DOM directly. This is the standard way to integrate `contenteditable` with a
reactive framework and is what prevents caret loss on every render.

Responsibilities:

- Render the editor shell, an optional bottom-toolbar slot, and the mention menu.
- Detect the `@` trigger relative to the caret and open/close the menu.
- Insert mention chips with surrounding spaces.
- Handle IME composition, paste, placeholder, auto-grow, and key handling.
- Serialize editor content to the plain-text `@alias` string on every edit and
  emit it via `onInput`.

#### Props

```ts
interface MentionComposerProps {
  candidates: ContextRefPayload[];      // pendingContextRefs() — menu source
  placeholder: string;
  disabled?: boolean;
  onInput: (serializedText: string) => void;
  onInsertMention: (ref: ContextRefPayload) => void;  // addContextRef + addInlineMention
  onRemoveMention?: (path: string) => void;           // chip deleted → removeInlineMention
  onSend: () => void;                                 // Ctrl/Cmd+Enter
  onReady?: (api: MentionComposerApi) => void;        // imperative handle
  toolbar?: JSX.Element;                              // bottom-bar content (attach + @ + send)
}
```

#### Imperative controller (`MentionComposerApi`)

Exposed via `onReady` so the parent never re-sets `innerHTML` (which would lose
the caret):

```ts
interface MentionComposerApi {
  focus(): void;
  clear(): void;
  getText(): string;          // current serialized text
  isEmpty(): boolean;
  insertText(s: string): void;   // example-prompt fill (HomePage)
  insertMention(ref: ContextRefPayload): void;  // @ button
}
```

### New: `src/components/MentionComposer.css`

- `.mc-editor` — editor box, `min-height`/`max-height`, `overflow-y: auto`,
  `white-space: pre-wrap`, `word-break`. Reuses existing composer typography.
- `.mc-editor.is-empty::before` — placeholder via `content: attr(data-placeholder)`,
  toggled by an `is-empty` class (not `:empty`, which breaks when the editor
  holds a stray `<br>`).
- `.mc-chip` — inline-flex chip: accent-soft background, rounded, `@`-prefixed,
  `max-width` + `overflow: hidden` + `text-overflow: ellipsis`, `user-select`
  styling so it reads as one unit. `contenteditable="false"` makes it atomic.
- `.mc-at-btn` — the new `@` button in the bottom bar.

### Changed: `src/utils/mentions.ts`

- `detectAtTrigger(text, cursorPos, opts?: { requireBoundary?: boolean })` — add
  an option. Default `requireBoundary: true` preserves current behavior for any
  other caller; the composer passes `false` so `@` triggers after any character
  (ask #1). Only menu-triggering is affected.
- Add a pure serializer used by the composer:
  `serializeNodes(tokens: EditorToken[]): string` where
  `EditorToken = { type: "text"; text } | { type: "break" } | { type: "chip"; alias }`.
  The component walks `editor.childNodes` into this token list, then this pure
  function maps it to text: `text` verbatim, `break` → `\n`, `chip` → `@${alias}`.
  Keeping the mapping pure makes it unit-testable without a DOM.
- `resolveInlineMentions`, `findMentionIndex`, `buildMentionInsert`,
  `validateMentionPaths`, `isRefMentioned` — **unchanged.**

### Changed: `src/components/home/HomePage.tsx`

- Replace the `<textarea>` + `onInput`/`onKeyDown` mention handlers + the
  `insertMention` function with `<MentionComposer>`.
- Keep the `input()` signal, fed by `onInput`.
- Pass the existing bottom bar (附加资料 menu + send) plus the new `@` button as
  the composer's `toolbar`.
- Route `insertExamplePrompt` through `api.insertText(...)`.
- `onInsertMention` → `addContextRef` + `addInlineMention` (as today).

### Changed: `src/components/workspace/ChatPanel.tsx`

- Same swap. Replace `<textarea>` + `grow`/`onKey`/`insertMention` with
  `<MentionComposer>`; the auto-grow `style.height` juggling is dropped (the
  editor grows natively).
- Add the `@` button to the existing `input-row`.
- Clear after send via `api.clear()`.

## Behaviors

### 1. Trigger anywhere
On input (when not composing), scan backward from the caret within the current
text node for `@`; open the menu regardless of the preceding character. Backed by
`detectAtTrigger(..., { requireBoundary: false })`.

### 2. Auto-spaces
On chip insertion, ensure exactly one space *before* the chip (unless the chip is
at line start or already preceded by whitespace) and exactly one space *after*.
This is also a correctness requirement, not just cosmetics: `resolveInlineMentions`
matches a mention only when it has a start boundary (whitespace/start) and an end
boundary, so the leading space keeps `据@证据.pdf` resolvable as `据 @证据.pdf`.

### 3. `@` button
A button in each composer's bottom bar opens the same `MentionMenu`. Selecting a
ref calls `api.insertMention(ref)`, which inserts a chip at the last-known caret
range inside the editor (saved on selection change / blur), or at the end if the
editor was never focused.

### 4. Atomic chips
Mentions render as:

```html
<span class="mc-chip" contenteditable="false"
      data-path="<abs path>" data-alias="<full alias>"
      title="<full alias>">@<alias></span>
```

`contenteditable="false"` inside the editable host makes the browser treat the
chip as a single atomic unit: clicking selects the whole chip, the caret steps
over it, and Backspace/Delete (or select-and-type) removes it entirely. The label
is truncated purely by CSS; the full alias lives in `data-alias` and `title`.
Deleting a chip fires `onRemoveMention(path)` → `removeInlineMention`. The
top-of-composer attachment chip is unaffected (removed via its own × as today).

## Data flow

On every edit the composer serializes its children to plain text and emits it via
`onInput`; the parent stores it in the same `input()`/`text()` signal as today.

The send path is **unchanged**:
`sendChatMessage(text)` → `resolveInlineMentions(text, refs, inlineMentionPaths())`.
Because chips always serialize as `<space>@alias<space>`, the existing boundary
matching resolves them exactly as before. Inserting a chip still calls
`addContextRef(ref)` + `addInlineMention(ref.path)`. **No changes to the store,
the services layer, or the Rust backend.**

## Robustness

- **Chinese IME.** Track `compositionstart`/`compositionend`; suppress trigger
  detection and serialization-driven menu updates while composing; re-scan on
  `compositionend`. Mirrors the existing `e.isComposing` guard.
- **Paste.** Intercept `paste`, insert `text/plain` at the caret only — never
  foreign HTML into the editor.
- **Placeholder.** Toggle an `is-empty` class based on serialized emptiness.
- **Auto-grow.** `min-height`/`max-height` + `overflow-y: auto` on the editor.
- **Keys.** Ctrl/Cmd+Enter → `onSend`; plain Enter → newline; Arrow/Enter/Tab/Esc
  drive the menu while open (same semantics as the current handlers).

## Testing

- Unit (`src/utils/__tests__/mentions.test.ts`):
  - `serializeNodes` token-list → text mapping (text / break / chip, ordering,
    spaces around chips).
  - `detectAtTrigger` with `requireBoundary: false` opens after a non-space char;
    with default it still requires a boundary; existing `resolveInlineMentions`
    cases continue to pass.
- Manual UAT:
  - `@` opens after a CJK char (`据@`).
  - Inserted chip has a space before and after.
  - `@` button inserts at the caret, and at the end when unfocused.
  - Chip is atomic: cannot click-edit inside; Backspace removes the whole chip.
  - Chinese IME query into the menu works.
  - Send still resolves the referenced files (chips → refs) in both composers.
  - Long names truncate with ellipsis; full name on hover.

## Out of scope (YAGNI)

- Caret-anchored menu positioning (keep the current container-anchored dropdown).
- A per-chip inline × button (atomic Backspace delete is enough).
- Any rich formatting beyond mentions + newlines.
