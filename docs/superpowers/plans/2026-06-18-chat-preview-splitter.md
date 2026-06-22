# Draggable Chat/Preview Splitter + Auto-Hidden Preview — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Implement task-by-task; run the verification at the end of each task before moving on.

**Goal:** Make the divider between the chat panel and the document preview draggable to resize, and hide the right-side preview entirely whenever the conversation has no document artifact (pure 法律问答), letting chat fill the window in a centered reading column.

**Architecture:** `Workspace.tsx` renders `.chat` (ChatPanel) and `.doc` (DocPreview) as siblings inside `.ws`. We lift the chat width into a Workspace-owned signal applied as `--chat-w` on `.ws` (CSS inheritance feeds the existing `var(--chat-w, 500px)` on `.chat`), add a hand-rolled pointer-drag splitter element between the two panels, and conditionally render the splitter + DocPreview based on a `showPreview` memo. All resize math and persistence live in a pure, unit-tested util module; the DOM wiring and CSS get manual verification.

**Tech Stack:** SolidJS, TypeScript, Vitest + `@solidjs/testing-library`, plain CSS (`src/themes/molv-base.css`), Tauri (web preview via `npm run dev`).

---

## Background facts (verified in the codebase)

- `.chat { flex: 0 0 var(--chat-w, 500px); border-right: 1px solid var(--line); position: relative; }` and `.doc { flex: 1; }` — `src/themes/molv-base.css:128` and `:213`. The "divider" today is just `.chat`'s `border-right`; there is no drag handle.
- `--chat-w` is currently hardcoded inline: `<div class="chat" style={{ "--chat-w": "500px" }}>` — `src/components/workspace/ChatPanel.tsx:456`.
- `.ws { flex: 1; display: flex; min-height: 0; }` — `src/themes/molv-base.css:125`. `.chat` children are `.chat-ctx` (header), `.thread.scroll` (messages), `.composer` (input).
- Overlay panels `.cite-panel` (and the trace panel) are `position: absolute` over `.screen`, independent of the chat/doc flex split — they survive solo mode untouched.
- Modes (`src/types/agentMode.ts`): `chat` = 法律问答 (no artifact), `draft` = 文书起草 (structured doc), `evidence` = 案情分析 (markdown report). **Both** draft and evidence produce a right-side artifact; only `chat` produces nothing.
- The conversation store (`src/stores/conversation.ts`) already exports: `committedMode`, `workspaceMode`, `legalDocument`, `documentMarkdown`, `draftWorkflowActive`, `activeEvidenceResponse`. `committedMode` is set to `draft`/`evidence` when such a task commits and only changes on a confirmed *switch* (not an *aside*) — this is what keeps the preview visible across Q&A asides.

## Decisions (locked)

- **Hide trigger:** artifact-based. Show preview when a draft/evidence task is committed/active or a document exists; otherwise hide. Stable, no per-turn flicker.
- **Persistence:** chosen width saved to `localStorage["molv.chatWidth"]`, global across conversations, survives restart.
- **Solo layout:** when preview hidden, `.chat` becomes `flex: 1`; messages + composer are constrained to a centered `~760px` reading column; the header/composer separators stay full-width.
- **Clamp:** chat width ∈ `[360px, wsWidth − 480px]` (preview keeps ≥ 480px). Double-click resets to 500px.
- **Out of scope (YAGNI):** manual collapse toggle in draft mode, per-conversation widths, keyboard-arrow resizing.

## File Structure

- **Create** `src/utils/chatLayout.ts` — width constants, `clampChatWidth`, `loadChatWidth`, `saveChatWidth`, `shouldShowPreview`. One responsibility: layout math + persistence, no DOM.
- **Create** `src/utils/__tests__/chatLayout.test.ts` — unit tests for the above.
- **Modify** `src/components/workspace/Workspace.tsx` — width signal, splitter element + pointer handlers, `showPreview` memo, conditional render of splitter + DocPreview, `--chat-w` + `solo` class on `.ws`, ResizeObserver re-clamp.
- **Modify** `src/components/workspace/ChatPanel.tsx:456` — drop the hardcoded inline `--chat-w`.
- **Modify** `src/themes/molv-base.css` — `.ws-splitter`, `.ws.ws-resizing`, and `.ws.solo` rules.

---

## Task 1: Pure layout util + tests

**Files:**
- Create: `src/utils/chatLayout.ts`
- Test: `src/utils/__tests__/chatLayout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/chatLayout.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_MIN,
  PREVIEW_WIDTH_MIN,
  clampChatWidth,
  loadChatWidth,
  saveChatWidth,
  shouldShowPreview,
} from "../chatLayout";

afterEach(() => {
  localStorage.clear();
});

describe("clampChatWidth", () => {
  it("keeps a comfortable width unchanged", () => {
    expect(clampChatWidth(500, 1400)).toBe(500);
  });
  it("clamps below the chat minimum up to CHAT_WIDTH_MIN", () => {
    expect(clampChatWidth(100, 1400)).toBe(CHAT_WIDTH_MIN);
  });
  it("reserves PREVIEW_WIDTH_MIN for the preview pane", () => {
    // 1000 - 480 = 520 is the max chat width
    expect(clampChatWidth(900, 1000)).toBe(1000 - PREVIEW_WIDTH_MIN);
  });
  it("never returns below CHAT_WIDTH_MIN even in a tiny window", () => {
    expect(clampChatWidth(500, 500)).toBe(CHAT_WIDTH_MIN);
  });
});

describe("loadChatWidth / saveChatWidth", () => {
  it("returns the default when nothing is stored", () => {
    expect(loadChatWidth()).toBe(CHAT_WIDTH_DEFAULT);
  });
  it("round-trips a saved width", () => {
    saveChatWidth(640);
    expect(loadChatWidth()).toBe(640);
  });
  it("falls back to default on a garbage value", () => {
    localStorage.setItem("molv.chatWidth", "not-a-number");
    expect(loadChatWidth()).toBe(CHAT_WIDTH_DEFAULT);
  });
});

describe("shouldShowPreview", () => {
  const base = {
    committedMode: null as "chat" | "draft" | "evidence" | null,
    workspaceMode: "idle" as "chat" | "draft" | "evidence" | "idle",
    hasLegalDocument: false,
    hasMarkdownDoc: false,
    draftWorkflowActive: false,
    activeEvidenceResponse: false,
  };
  it("hides for a pure chat conversation", () => {
    expect(shouldShowPreview(base)).toBe(false);
    expect(shouldShowPreview({ ...base, committedMode: "chat", workspaceMode: "chat" })).toBe(false);
  });
  it("shows once a draft task is committed", () => {
    expect(shouldShowPreview({ ...base, committedMode: "draft" })).toBe(true);
  });
  it("shows once an evidence task is committed", () => {
    expect(shouldShowPreview({ ...base, committedMode: "evidence" })).toBe(true);
  });
  it("shows while a draft/evidence turn is live before commit", () => {
    expect(shouldShowPreview({ ...base, workspaceMode: "draft" })).toBe(true);
    expect(shouldShowPreview({ ...base, draftWorkflowActive: true })).toBe(true);
    expect(shouldShowPreview({ ...base, activeEvidenceResponse: true })).toBe(true);
  });
  it("shows whenever a document already exists", () => {
    expect(shouldShowPreview({ ...base, hasLegalDocument: true })).toBe(true);
    expect(shouldShowPreview({ ...base, hasMarkdownDoc: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- chatLayout`
Expected: FAIL — `Cannot find module '../chatLayout'`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/chatLayout.ts`:

```ts
import type { AgentMode } from "../types/agentMode";

export const CHAT_WIDTH_DEFAULT = 500;
export const CHAT_WIDTH_MIN = 360;
export const PREVIEW_WIDTH_MIN = 480;

const STORAGE_KEY = "molv.chatWidth";

/** Clamp a desired chat width so chat ≥ CHAT_WIDTH_MIN and preview ≥ PREVIEW_WIDTH_MIN. */
export function clampChatWidth(desired: number, containerWidth: number): number {
  const max = Math.max(CHAT_WIDTH_MIN, containerWidth - PREVIEW_WIDTH_MIN);
  return Math.min(Math.max(desired, CHAT_WIDTH_MIN), max);
}

/** Read the persisted chat width, or the default. Not clamped — caller clamps to the live container. */
export function loadChatWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return CHAT_WIDTH_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : CHAT_WIDTH_DEFAULT;
  } catch {
    return CHAT_WIDTH_DEFAULT;
  }
}

export function saveChatWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* localStorage unavailable — ignore */
  }
}

export interface PreviewVisibilityInputs {
  committedMode: AgentMode | null;
  workspaceMode: AgentMode | "idle";
  hasLegalDocument: boolean;
  hasMarkdownDoc: boolean;
  draftWorkflowActive: boolean;
  activeEvidenceResponse: boolean;
}

/** Artifact-based: show the preview whenever the conversation has (or is producing) a doc. */
export function shouldShowPreview(s: PreviewVisibilityInputs): boolean {
  return (
    s.committedMode === "draft" ||
    s.committedMode === "evidence" ||
    s.workspaceMode === "draft" ||
    s.workspaceMode === "evidence" ||
    s.hasLegalDocument ||
    s.hasMarkdownDoc ||
    s.draftWorkflowActive ||
    s.activeEvidenceResponse
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- chatLayout`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/utils/chatLayout.ts src/utils/__tests__/chatLayout.test.ts
git commit -m "feat(workspace): add chat-layout util for resize clamp + preview visibility"
```

---

## Task 2: Wire splitter + resizable width + auto-hide into Workspace

**Files:**
- Modify: `src/components/workspace/Workspace.tsx`

- [ ] **Step 1: Import the util and the extra store signals**

At the top of `Workspace.tsx`, add the util import:

```tsx
import {
  CHAT_WIDTH_DEFAULT,
  clampChatWidth,
  loadChatWidth,
  saveChatWidth,
  shouldShowPreview,
} from "../../utils/chatLayout";
```

Add `createMemo` to the existing `solid-js` import (it currently imports `createEffect, createSignal, onCleanup, onMount, Show`):

```tsx
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
```

Extend the `useConversation()` destructure (currently `initWorkspace, sendChatMessage, activeConversationId, messages, pendingContextRefs, citationGroups, setCiteState, citeState`) with the visibility inputs:

```tsx
  const {
    initWorkspace,
    sendChatMessage,
    activeConversationId,
    messages,
    pendingContextRefs,
    citationGroups,
    setCiteState,
    citeState,
    committedMode,
    workspaceMode,
    legalDocument,
    documentMarkdown,
    draftWorkflowActive,
    activeEvidenceResponse,
  } = useConversation();
```

- [ ] **Step 2: Add width state, the splitter handlers, and the visibility memo**

Below the existing signals (`const [sending, ...]`, `const [refinementOpen, ...]`, `let docScrollRef`), add:

```tsx
  const [chatWidth, setChatWidth] = createSignal(loadChatWidth());
  let wsRef: HTMLDivElement | undefined;

  const showPreview = createMemo(() =>
    shouldShowPreview({
      committedMode: committedMode(),
      workspaceMode: workspaceMode(),
      hasLegalDocument: legalDocument() !== null,
      hasMarkdownDoc: documentMarkdown().trim().length > 0,
      draftWorkflowActive: draftWorkflowActive(),
      activeEvidenceResponse: activeEvidenceResponse(),
    }),
  );

  function beginResize(e: PointerEvent) {
    if (!wsRef) return;
    e.preventDefault();
    const rect = wsRef.getBoundingClientRect();
    wsRef.classList.add("ws-resizing");
    const onMove = (ev: PointerEvent) => {
      setChatWidth(clampChatWidth(ev.clientX - rect.left, rect.width));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      wsRef?.classList.remove("ws-resizing");
      saveChatWidth(chatWidth());
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resetWidth() {
    const width = wsRef
      ? clampChatWidth(CHAT_WIDTH_DEFAULT, wsRef.getBoundingClientRect().width)
      : CHAT_WIDTH_DEFAULT;
    setChatWidth(width);
    saveChatWidth(width);
  }
```

- [ ] **Step 3: Re-clamp on container resize (handles a shrunk window between sessions)**

Inside the existing `onMount(() => { ... })`, add after the keyboard handler block (still inside `onMount`):

```tsx
    if (wsRef && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (wsRef) setChatWidth((w) => clampChatWidth(w, wsRef!.clientWidth));
      });
      ro.observe(wsRef);
      onCleanup(() => ro.disconnect());
    }
```

- [ ] **Step 4: Update the JSX — `--chat-w` + `solo` on `.ws`, conditional splitter + DocPreview**

Replace the `return (...)` block's opening `<div class="ws">` and the `<DocPreview .../>` element. The new structure:

```tsx
  return (
    <div
      class="ws"
      classList={{ solo: !showPreview() }}
      ref={(el) => (wsRef = el)}
      style={{ "--chat-w": `${chatWidth()}px` }}
    >
      <ChatPanel onSend={onSend} sending={sending} />
      <Show when={showPreview()}>
        <div
          class="ws-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整聊天与文书预览宽度"
          onPointerDown={beginResize}
          onDblClick={resetWidth}
        />
        <DocPreview
          onCite={openCite}
          onRisk={() => {
            const law = citationGroups().law[0];
            if (law) openCite(law.key);
          }}
          onFix={() => onSend("请根据风险提示补充或修改相关条款。")}
          onToggleCite={(force) =>
            setCiteState((c) => ({ ...c, open: force === true ? true : !c.open }))
          }
          onToast={props.onToast}
          docScrollRef={(el) => {
            docScrollRef = el;
          }}
          sheetRef={() => {}}
        />
      </Show>
      <CitationPanel
        open={cite().open}
        tab={cite().tab}
        activeKey={cite().key}
        onClose={() => setCiteState((c) => ({ ...c, open: false }))}
        onTab={(t) => setCiteState((c) => ({ ...c, tab: t }))}
        onInsert={(c) => props.onToast(`已插入引用：${c.title}`)}
        onLocate={onLocate}
      />
      <AgentTracePanel />
      <Show when={isDevAdmin}>
        <SkillRefinementPanel open={refinementOpen()} onClose={() => setRefinementOpen(false)} />
      </Show>
      <div class={`toast${props.toast ? " show" : ""}`}>
        <Icon name="check" />
        {props.toast}
      </div>
    </div>
  );
```

(Only the `.ws` open tag, the splitter, and wrapping `DocPreview` in `<Show when={showPreview()}>` change; `CitationPanel`/`AgentTracePanel`/`SkillRefinementPanel`/toast are unchanged and stay always-mounted as overlays.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors. (If `wsRef!` triggers a lint complaint, the non-null assertion inside the ResizeObserver callback is guarded by the enclosing `if (wsRef)`.)

- [ ] **Step 6: Commit**

```bash
git add src/components/workspace/Workspace.tsx
git commit -m "feat(workspace): draggable chat/preview splitter + auto-hide preview when no doc"
```

---

## Task 3: Remove the hardcoded chat width from ChatPanel

**Files:**
- Modify: `src/components/workspace/ChatPanel.tsx:456`

- [ ] **Step 1: Drop the inline `--chat-w`**

Change line 456 from:

```tsx
    <div class="chat" style={{ "--chat-w": "500px" }}>
```

to:

```tsx
    <div class="chat">
```

`.chat` keeps reading `var(--chat-w, 500px)`, now inherited from `.ws`; the `500px` fallback still applies if `.ws` ever omits it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/workspace/ChatPanel.tsx
git commit -m "refactor(workspace): let chat width inherit --chat-w from .ws"
```

---

## Task 4: Splitter + solo-mode styles

**Files:**
- Modify: `src/themes/molv-base.css` (add near the `.ws`/`.chat`/`.doc` block, around line 213)

- [ ] **Step 1: Add the CSS**

Append after the `.doc { ... }` rule (line 213):

```css
/* Draggable divider between chat and doc preview. Straddles .chat's border-right. */
.ws-splitter {
  flex: 0 0 6px;
  margin: 0 -3px;
  position: relative;
  z-index: 5;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
}
.ws-splitter::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: transparent;
  transition: background 0.15s;
}
.ws-splitter:hover::after,
.ws.ws-resizing .ws-splitter::after {
  background: var(--accent);
}
.ws.ws-resizing {
  cursor: col-resize;
}
.ws.ws-resizing * {
  user-select: none;
}

/* Solo mode (no preview): chat fills the window with a centered reading column. */
.ws.solo .chat {
  flex: 1 1 auto;
  border-right: none;
}
.ws.solo .thread > *,
.ws.solo .composer > * {
  max-width: var(--solo-col, 760px);
  margin-inline: auto;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/themes/molv-base.css
git commit -m "style(workspace): splitter handle and solo-mode centered chat column"
```

---

## Task 5: Verification

- [ ] **Step 1: Unit tests + typecheck**

Run: `npm test` then `npx tsc -b`
Expected: all tests pass; no type errors.

- [ ] **Step 2: Launch the app**

Run: `npm run dev` (web preview at `http://localhost:1420`) or `npm run tauri:dev` for the native window.

- [ ] **Step 3: Manual checklist**

- [ ] New 法律问答 conversation → **no** preview pane, **no** splitter; chat fills the window, messages + composer centered (~760px) rather than stretched edge-to-edge.
- [ ] Start a 文书起草 task → preview pane + splitter appear. Drag the divider left/right: chat resizes live, chat never narrower than ~360px, preview never narrower than ~480px.
- [ ] Reload the app → the dragged width is restored (persisted).
- [ ] Double-click the divider → width resets to 500px.
- [ ] In a committed draft conversation, send a pure Q&A follow-up (an "aside") → preview **stays** visible.
- [ ] Start a 案情分析 task → preview pane appears and renders the markdown report (evidence is treated as document-producing).
- [ ] Open the citation panel / trace panel in any mode → overlays still slide in correctly (unaffected by solo mode).

- [ ] **Step 4: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "fix(workspace): splitter/solo polish from manual QA"
```

---

## Self-Review

- **Spec coverage:** draggable divider → Tasks 2+4; persistence → Task 1 (`load/saveChatWidth`) + Task 2 wiring; auto-hide in non-doc mode → Task 1 (`shouldShowPreview`) + Task 2 `<Show>`; centered solo column → Task 4; clamp/min widths → Task 1 (`clampChatWidth`). All covered.
- **Type consistency:** `clampChatWidth`, `loadChatWidth`, `saveChatWidth`, `shouldShowPreview`, `PreviewVisibilityInputs`, `CHAT_WIDTH_DEFAULT/MIN`, `PREVIEW_WIDTH_MIN` are defined in Task 1 and used with identical names/signatures in Tasks 1–2. `AgentMode` imported from `../types/agentMode` (existing union `"chat" | "draft" | "evidence"`).
- **No placeholders:** every code step shows full code; commands include expected output.
```