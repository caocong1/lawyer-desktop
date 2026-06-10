import { createSignal } from "solid-js";
import type {
  AgentTraceEvent,
  TraceEntry,
  TraceTurn,
  TraceUsage,
} from "../types/trace";

/** Turns kept in memory (oldest dropped first). */
const MAX_TURNS = 8;

const [turns, setTurns] = createSignal<TraceTurn[]>([]);
const [panelOpen, setPanelOpen] = createSignal(false);
/** Auto-scroll the timeline to the newest entry. */
const [follow, setFollow] = createSignal(true);

let entryCounter = 0;

function newEntry(e: AgentTraceEvent, overrides?: Partial<TraceEntry>): TraceEntry {
  return {
    id: `te-${++entryCounter}`,
    kind: e.kind,
    seq: e.seq,
    elapsedMs: e.elapsed_ms,
    payload: e.payload,
    ...overrides,
  };
}

function emptyTurn(e: AgentTraceEvent): TraceTurn {
  return {
    conversationId: e.conversation_id,
    messageId: e.message_id,
    startedTsMs: e.ts_ms,
    entries: [],
    live: true,
    model: "",
    promptTokens: 0,
    completionTokens: 0,
    rounds: 0,
    toolCalls: 0,
    errors: 0,
  };
}

function addUsage(turn: TraceTurn, usage: TraceUsage | null | undefined) {
  if (!usage) return;
  turn.promptTokens += usage.prompt_tokens ?? 0;
  turn.completionTokens += usage.completion_tokens ?? 0;
}

/** Close any still-growing live entries (thinking/stream). */
function closeLiveEntries(entries: TraceEntry[]): TraceEntry[] {
  if (!entries.some((en) => en.open)) return entries;
  return entries.map((en) => (en.open ? { ...en, open: false } : en));
}

/** Fold a delta into the last open live entry of `kind`, or start one. */
function foldDelta(
  entries: TraceEntry[],
  e: AgentTraceEvent,
  kind: "thinking_live" | "stream_live",
): TraceEntry[] {
  const text: string = e.payload?.text ?? "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const en = entries[i];
    if (en.kind === kind && en.open) {
      const next = entries.slice();
      next[i] = { ...en, text: (en.text ?? "") + text };
      return next;
    }
    // A newer non-live entry means the previous live block already ended.
    if (en.kind === kind) break;
  }
  return [...entries, newEntry(e, { kind, text, open: true })];
}

function applyEvent(turn: TraceTurn, e: AgentTraceEvent): TraceTurn {
  const t: TraceTurn = { ...turn };

  switch (e.kind) {
    case "turn_start":
      t.model = e.payload?.model ?? "";
      break;
    case "classify_result":
      t.mode = e.payload?.mode;
      t.modeLabel = e.payload?.label;
      break;
    case "round_start":
      t.rounds = e.payload?.round ?? t.rounds + 1;
      break;
    case "llm_response":
      addUsage(t, e.payload?.usage);
      break;
    case "continuation_result":
      addUsage(t, e.payload?.usage);
      break;
    case "stream_usage":
      addUsage(t, e.payload?.usage);
      break;
    case "tool_call":
      t.toolCalls += 1;
      break;
    case "error":
      t.errors += 1;
      break;
    case "turn_end":
      t.live = false;
      t.durationMs = e.payload?.duration_ms;
      break;
  }

  switch (e.kind) {
    case "thinking_delta":
      t.entries = foldDelta(t.entries, e, "thinking_live");
      break;
    case "stream_delta": {
      // The first content delta is what actually ends an open reasoning
      // block (stream_start fires before reasoning deltas arrive).
      const hasOpenStream = t.entries.some(
        (en) => en.kind === "stream_live" && en.open,
      );
      if (!hasOpenStream) t.entries = closeLiveEntries(t.entries);
      t.entries = foldDelta(t.entries, e, "stream_live");
      break;
    }
    case "stream_start":
      // Marker only — the first stream_delta opens the live entry lazily,
      // keeping thinking → content chronology intact.
      break;
    case "error":
    case "stream_done":
    case "round_start":
    case "llm_response":
    case "turn_end":
      t.entries = [...closeLiveEntries(t.entries), newEntry(e)];
      break;
    default:
      t.entries = [...t.entries, newEntry(e)];
      break;
  }

  return t;
}

export function useTrace() {
  function ingest(e: AgentTraceEvent) {
    setTurns((prev) => {
      const idx = prev.findIndex((t) => t.messageId === e.message_id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = applyEvent(next[idx], e);
        return next;
      }
      const turn = applyEvent(emptyTurn(e), e);
      const next = [...prev, turn];
      return next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
    });
  }

  function clear() {
    setTurns([]);
  }

  function toggle(force?: boolean) {
    setPanelOpen((v) => (force === undefined ? !v : force));
  }

  /** Last turn for the active conversation (or overall last). */
  function activeTurn(conversationId?: string | null): TraceTurn | undefined {
    const all = turns();
    if (conversationId) {
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].conversationId === conversationId) return all[i];
      }
      return undefined;
    }
    return all[all.length - 1];
  }

  return {
    turns,
    panelOpen,
    follow,
    setFollow,
    ingest,
    clear,
    toggle,
    activeTurn,
  };
}
