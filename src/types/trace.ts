/** Structured backend agent-loop trace, mirrors `commands/trace.rs`. */

export type TraceKind =
  | "turn_start"
  | "skills_loaded"
  | "classify_start"
  | "classify_result"
  | "history_loaded"
  | "tools_built"
  | "context_built"
  | "round_start"
  | "llm_request"
  | "llm_response"
  | "thinking"
  | "thinking_delta"
  | "tool_call"
  | "tool_result"
  | "skill_activated"
  | "leak_retry"
  | "leak_fallback"
  | "continuation"
  | "continuation_result"
  | "final_answer"
  | "rounds_exhausted"
  | "stream_start"
  | "stream_delta"
  | "stream_usage"
  | "stream_done"
  | "error"
  | "turn_end";

export interface AgentTraceEvent {
  conversation_id: string;
  message_id: string;
  seq: number;
  /** Wall-clock epoch millis. */
  ts_ms: number;
  /** Millis since turn start. */
  elapsed_ms: number;
  kind: TraceKind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

export interface TraceUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Timeline entry shown in the panel. Delta events are folded into
 *  growing `live` entries instead of one entry per delta. */
export interface TraceEntry {
  id: string;
  kind: TraceKind | "thinking_live" | "stream_live";
  seq: number;
  elapsedMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
  /** Accumulated text for *_live entries. */
  text?: string;
  /** Live entries grow until their *_done / next phase arrives. */
  open?: boolean;
}

export interface TraceTurn {
  conversationId: string;
  messageId: string;
  startedTsMs: number;
  entries: TraceEntry[];
  live: boolean;
  model: string;
  mode?: string;
  modeLabel?: string;
  /** Summed across all llm_response/stream_usage events of the turn. */
  promptTokens: number;
  completionTokens: number;
  rounds: number;
  toolCalls: number;
  errors: number;
  durationMs?: number;
}
