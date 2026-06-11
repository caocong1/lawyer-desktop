import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX } from "solid-js";
import { useTrace } from "../../stores/trace";
import { useConversation } from "../../stores/conversation";
import { onAgentTrace } from "../../services/api";
import type { TraceEntry, TraceTurn } from "../../types/trace";
import { highlightJson, looksLikeJson, prettyJson } from "../../utils/jsonHighlight";
import { Icon } from "../icons/Icons";
import "./AgentTracePanel.css";

/* ---------- formatting helpers ---------- */

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(2)}s`;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function fmtClock(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const MODE_LABEL: Record<string, string> = {
  chat: "法律咨询",
  draft: "文书起草",
  evidence: "证据分析",
};

/** Tokenizing very long buffers on every delta is O(n²); cap highlighting. */
const HIGHLIGHT_MAX = 30000;
/** Live blocks only render the newest tail to stay snappy. */
const LIVE_TAIL = 8000;

/* ---------- shared blocks ---------- */

function CodeBlock(props: {
  text: string;
  json?: boolean;
  live?: boolean;
  maxCollapsed?: number;
}) {
  const max = () => props.maxCollapsed ?? 360;
  const [expanded, setExpanded] = createSignal(false);
  let preRef: HTMLPreElement | undefined;

  const long = () => !props.live && props.text.length > max();
  const shown = () => {
    if (props.live) {
      return props.text.length > LIVE_TAIL
        ? `…[前略 ${props.text.length - LIVE_TAIL} 字]\n${props.text.slice(-LIVE_TAIL)}`
        : props.text;
    }
    return expanded() || !long() ? props.text : props.text.slice(0, max());
  };
  const body = (): JSX.Element => {
    const t = shown();
    if (props.json && t.length < HIGHLIGHT_MAX) return highlightJson(t);
    return t;
  };

  // Keep the newest streamed content in view; coalesce per-delta scroll
  // syncs through rAF so we force at most one layout per frame.
  let scrollPending = false;
  createEffect(() => {
    props.text;
    if (!props.live || scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      if (preRef) preRef.scrollTop = preRef.scrollHeight;
    });
  });

  return (
    <div class={`tp-code${props.live ? " live" : ""}`}>
      <pre ref={preRef}>
        {body()}
        <Show when={props.live}>
          <span class="tp-caret" />
        </Show>
      </pre>
      <Show when={long()}>
        <button type="button" class="tp-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded() ? "收起 ▲" : `展开全部 (${props.text.length} 字符) ▼`}
        </button>
      </Show>
    </div>
  );
}

function Chip(props: { tone?: string; children: JSX.Element }) {
  return <span class={`tp-chip${props.tone ? ` ${props.tone}` : ""}`}>{props.children}</span>;
}

/* ---------- entry row ----------
   Rows are keyed by entry id, so `entry().kind` is fixed for a row's
   lifetime: the structural switch runs once, while payload/text reads
   inside the returned JSX stay fine-grained reactive. */

interface RowSpec {
  tone: string;
  icon: string;
  title: () => string;
  meta?: JSX.Element;
  body?: JSX.Element;
  running?: () => boolean;
}

function entrySpec(
  entry: () => TraceEntry,
  turn: () => TraceTurn,
  pendingCalls: () => Set<string>,
): RowSpec | null {
  const first = entry();
  const p = first.payload ?? {};
  switch (first.kind) {
    case "turn_start":
      return {
        tone: "accent",
        icon: "◈",
        title: () => "回合开始",
        meta: (
          <>
            <Chip tone="accent">{p.model}</Chip>
            <Chip>{p.content_chars} 字</Chip>
            <Show when={(p.context_refs ?? []).length > 0}>
              <Chip tone="gold">{(p.context_refs ?? []).length} 个引用</Chip>
            </Show>
          </>
        ),
        body: p.content_preview ? <CodeBlock text={p.content_preview} /> : undefined,
      };
    case "skills_loaded":
      return {
        tone: "dim",
        icon: "▤",
        title: () => "技能库加载",
        meta: <Chip>{p.count} 个技能</Chip>,
      };
    case "classify_start":
      return {
        tone: "dim",
        icon: "?",
        title: () => "意图分类中…",
        meta: (
          <>
            <Show when={p.has_directory_ref}>
              <Chip>目录引用</Chip>
            </Show>
            <Show when={p.has_file_ref}>
              <Chip>文件引用</Chip>
            </Show>
          </>
        ),
        running: () => turn().live && !turn().mode,
      };
    case "classify_result":
      return {
        tone: "accent",
        icon: "◎",
        title: () => "意图分类",
        meta: (
          <>
            <Chip tone="accent">{MODE_LABEL[p.mode] ?? p.mode}</Chip>
            <Show when={p.label}>
              <Chip>{p.label}</Chip>
            </Show>
            <Show when={p.source === "fallback"}>
              <Chip tone="gold">本地规则</Chip>
            </Show>
            <Chip tone="dim">{fmtDuration(p.duration_ms)}</Chip>
          </>
        ),
        body:
          p.reason || p.diagnostic ? (
            <div class="tp-note">
              <Show when={p.reason}>
                <div>{p.reason}</div>
              </Show>
              <Show when={p.diagnostic}>
                <div>{p.diagnostic}</div>
              </Show>
            </div>
          ) : undefined,
      };
    case "history_loaded":
      return {
        tone: "dim",
        icon: "≣",
        title: () => "载入会话历史",
        meta: <Chip>{p.messages} 条消息</Chip>,
      };
    case "tools_built": {
      const builtin: string[] = p.builtin ?? [];
      const mcp: string[] = p.mcp ?? [];
      return {
        tone: "gold",
        icon: "⚒",
        title: () => "工具注册",
        meta: (
          <>
            <Chip tone="gold">{builtin.length} builtin</Chip>
            <Chip tone="purple">{mcp.length} MCP</Chip>
          </>
        ),
        body: (
          <div class="tp-toollist">
            <For each={builtin}>{(n) => <code class="tp-tool builtin">{n}</code>}</For>
            <For each={mcp}>{(n) => <code class="tp-tool mcp">{n}</code>}</For>
          </div>
        ),
      };
    }
    case "context_built":
      return {
        tone: "dim",
        icon: "⧉",
        title: () => "上下文构建",
        meta: (
          <>
            <Chip>{p.message_count} 条消息</Chip>
            <Chip>system {fmtTokens(p.system_prompt_chars ?? 0)} 字</Chip>
            <Chip>user {fmtTokens(p.user_content_chars ?? 0)} 字</Chip>
          </>
        ),
      };
    case "round_start":
      return {
        tone: "round",
        icon: "",
        title: () => `ROUND ${p.round} / ${p.max_rounds}`,
        meta: <Chip tone="dim">{p.message_count} msgs</Chip>,
      };
    case "llm_request":
      return {
        tone: "accent",
        icon: "↗",
        title: () => (p.stream ? "请求模型 · 流式" : "请求模型"),
        meta: (
          <>
            <Chip tone="accent">{p.model}</Chip>
            <Chip>{p.message_count} msgs</Chip>
            <Chip>{p.tool_count} tools</Chip>
            <Chip tone="dim">T={p.temperature}</Chip>
          </>
        ),
        running: () => {
          const t = turn();
          return t.live && t.entries[t.entries.length - 1]?.id === entry().id;
        },
      };
    case "llm_response": {
      const u = p.usage;
      return {
        tone: "accent",
        icon: "↙",
        title: () => "模型响应",
        meta: (
          <>
            <Chip tone="green">{fmtDuration(p.duration_ms)}</Chip>
            <Show when={p.finish_reason}>
              <Chip tone={p.finish_reason === "length" ? "amber" : "dim"}>
                {p.finish_reason}
              </Chip>
            </Show>
            <Show when={p.tool_call_count > 0}>
              <Chip tone="gold">{p.tool_call_count} 工具调用</Chip>
            </Show>
            <Show when={u}>
              <Chip tone="dim">
                ↥{fmtTokens(u?.prompt_tokens ?? 0)} ↧{fmtTokens(u?.completion_tokens ?? 0)} tok
              </Chip>
            </Show>
          </>
        ),
        body:
          p.content_chars > 0 && p.content_preview ? (
            <CodeBlock text={p.content_preview} json={looksLikeJson(p.content_preview)} />
          ) : undefined,
      };
    }
    case "thinking":
    case "thinking_live": {
      const text = () =>
        entry().kind === "thinking" ? entry().payload?.text ?? "" : entry().text ?? "";
      const open = () => !!entry().open;
      return {
        tone: "think",
        icon: "✦",
        title: () => (open() ? "深度思考中…" : "深度思考"),
        meta: <Chip tone="dim">{text().length} 字</Chip>,
        body: (
          <div class={`tp-think${open() ? " live" : ""}`}>
            {text()}
            <Show when={open()}>
              <span class="tp-caret" />
            </Show>
          </div>
        ),
        running: open,
      };
    }
    case "tool_call": {
      const tone =
        p.tool_kind === "mcp" ? "purple" : p.tool_kind === "skill" ? "gold" : "cyan";
      return {
        tone,
        icon: p.tool_kind === "mcp" ? "⌬" : p.tool_kind === "skill" ? "❖" : "⚙",
        title: () => `调用 ${p.name}`,
        meta: (
          <>
            <Chip tone={tone}>{p.tool_kind}</Chip>
            <Chip tone="dim">{p.origin}</Chip>
            <Chip tone="dim">#{String(p.call_id ?? "").slice(0, 8)}</Chip>
          </>
        ),
        body: p.arguments ? <CodeBlock text={prettyJson(p.arguments)} json /> : undefined,
        running: () => turn().live && pendingCalls().has(p.call_id),
      };
    }
    case "tool_result":
      return {
        tone: p.ok ? "green" : "red",
        icon: p.ok ? "✓" : "✗",
        title: () => (p.ok ? `${p.name} 完成` : `${p.name} 失败`),
        meta: (
          <>
            <Chip tone={p.ok ? "green" : "red"}>{fmtDuration(p.duration_ms)}</Chip>
            <Show when={p.ok}>
              <Chip tone="dim">{fmtTokens(p.result_chars ?? 0)} 字</Chip>
            </Show>
          </>
        ),
        body: p.ok ? (
          p.result_preview && (
            <CodeBlock
              text={p.result_preview}
              json={looksLikeJson(p.result_preview ?? "")}
            />
          )
        ) : (
          <div class="tp-error-text">{p.error}</div>
        ),
      };
    case "skill_activated":
      return {
        tone: "skill",
        icon: "❖",
        title: () => `技能激活 「${p.name}」`,
        meta: <Chip tone="gold">{p.plugin}</Chip>,
        body: p.description ? <div class="tp-note">{p.description}</div> : undefined,
      };
    case "leak_retry":
      return {
        tone: "amber",
        icon: "⟳",
        title: () => `DSML 泄漏 · 重试 ${p.attempt}/${p.max}`,
        meta: <Chip tone="amber">{p.stage}</Chip>,
        body: p.sample ? <CodeBlock text={p.sample} /> : undefined,
      };
    case "leak_fallback":
      return {
        tone: "amber",
        icon: "⚠",
        title: () => "泄漏持续 · 降级为无工具回答",
        meta: (
          <Chip tone="amber">
            {p.retries}/{p.max} 次重试用尽
          </Chip>
        ),
      };
    case "continuation":
      return {
        tone: "amber",
        icon: "⤳",
        title: () => `长度截断 · 续写 ${p.n}/${p.max}`,
        meta: <Chip tone="dim">已收集 {fmtTokens(p.collected_chars ?? 0)} 字</Chip>,
      };
    case "continuation_result":
      return {
        tone: "green",
        icon: "⤳",
        title: () => `续写 ${p.n} 完成`,
        meta: (
          <>
            <Chip tone="green">+{fmtTokens(p.segment_chars ?? 0)} 字</Chip>
            <Show when={p.finish_reason}>
              <Chip tone="dim">{p.finish_reason}</Chip>
            </Show>
          </>
        ),
      };
    case "final_answer":
      return {
        tone: "green",
        icon: "✔",
        title: () => "最终回答生成",
        meta: <Chip tone="green">{fmtTokens(p.chars ?? 0)} 字</Chip>,
      };
    case "rounds_exhausted":
      return {
        tone: "amber",
        icon: "⚠",
        title: () => `工具轮次耗尽 (${p.max_rounds})，强制流式输出`,
      };
    case "stream_live": {
      const text = () => entry().text ?? "";
      const open = () => !!entry().open;
      return {
        tone: "stream",
        icon: "≋",
        title: () => (open() ? "流式输出中…" : "流式输出"),
        meta: <Chip tone="dim">{fmtTokens(text().length)} 字</Chip>,
        body: (
          <CodeBlock
            text={text()}
            json={looksLikeJson(text())}
            live={open()}
            maxCollapsed={1200}
          />
        ),
        running: open,
      };
    }
    case "stream_usage": {
      const u = p.usage ?? {};
      return {
        tone: "dim",
        icon: "Σ",
        title: () => "流式用量",
        meta: (
          <Chip tone="dim">
            ↥{fmtTokens(u.prompt_tokens ?? 0)} ↧{fmtTokens(u.completion_tokens ?? 0)} tok
          </Chip>
        ),
      };
    }
    case "stream_done":
      return {
        tone: "green",
        icon: "✔",
        title: () => "流式完成",
        meta: (
          <>
            <Chip tone="green">{fmtTokens(p.chars ?? 0)} 字</Chip>
            <Show when={(p.reasoning_chars ?? 0) > 0}>
              <Chip tone="dim">思考 {fmtTokens(p.reasoning_chars)} 字</Chip>
            </Show>
          </>
        ),
      };
    case "error":
      return {
        tone: "red",
        icon: "✗",
        title: () => `错误 · ${p.stage ?? "unknown"}`,
        body: <div class="tp-error-text">{p.message}</div>,
      };
    case "turn_end": {
      const failed = p.ok === false;
      return {
        tone: failed ? "red" : "end",
        icon: failed ? "✗" : "■",
        title: () => (failed ? "回合失败" : "回合结束"),
        meta: (
          <>
            <Chip tone={failed ? "red" : "green"}>{fmtDuration(p.duration_ms)}</Chip>
            <Show when={!failed}>
              <Chip>{fmtTokens(p.response_chars ?? 0)} 字</Chip>
            </Show>
            <Show when={p.leak_fallback}>
              <Chip tone="amber">降级</Chip>
            </Show>
          </>
        ),
        body: failed && p.error ? <div class="tp-error-text">{p.error}</div> : undefined,
      };
    }
    case "stream_start":
      return null; // folded into stream_live by the store
    default:
      return {
        tone: "dim",
        icon: "·",
        title: () => first.kind,
        body: <CodeBlock text={JSON.stringify(p, null, 2)} json />,
      };
  }
}

function EntryRow(props: {
  entry: () => TraceEntry;
  turn: () => TraceTurn;
  pendingCalls: () => Set<string>;
}) {
  const s = entrySpec(props.entry, props.turn, props.pendingCalls);
  if (!s) return null;
  if (props.entry().kind === "round_start") {
    return (
      <div class="tp-round">
        <span class="tp-round-line" />
        <span class="tp-round-label">{s.title()}</span>
        {s.meta}
        <span class="tp-round-line" />
      </div>
    );
  }
  return (
    <div
      class={`tp-entry tone-${s.tone}`}
      classList={{ running: !!s.running?.() }}
    >
      <div class="tp-rail">
        <span class="tp-dot">
          <Show when={s.running?.()} fallback={<i class="tp-dot-icon">{s.icon}</i>}>
            <i class="tp-spinner" />
          </Show>
        </span>
      </div>
      <div class="tp-card">
        <div class="tp-card-h">
          <span class="tp-title">{s.title()}</span>
          <span class="tp-meta">{s.meta}</span>
          <span class="tp-ts">{fmtElapsed(props.entry().elapsedMs)}</span>
        </div>
        <Show when={s.body}>
          <div class="tp-card-b">{s.body}</div>
        </Show>
      </div>
    </div>
  );
}

/* ---------- turn section ---------- */

function TurnSection(props: { turn: () => TraceTurn; nowMs: () => number }) {
  const pendingCalls = createMemo(() => {
    const done = new Set<string>();
    const called = new Set<string>();
    for (const en of props.turn().entries) {
      if (en.kind === "tool_call") called.add(en.payload?.call_id);
      if (en.kind === "tool_result") done.add(en.payload?.call_id);
    }
    const pending = new Set<string>();
    for (const id of called) if (!done.has(id)) pending.add(id);
    return pending;
  });

  const entryIds = createMemo(() => props.turn().entries.map((en) => en.id));
  // Rows can briefly outlive a cleared/trimmed list; fall back to the last
  // known entry so accessors never return undefined mid-teardown.
  const entryById = (id: string) => {
    let last: TraceEntry | undefined;
    return () => {
      const found = props.turn().entries.find((en) => en.id === id);
      if (found) last = found;
      return (found ?? last) as TraceEntry;
    };
  };

  const elapsed = () =>
    props.turn().live
      ? Math.max(0, props.nowMs() - props.turn().startedTsMs)
      : props.turn().durationMs ?? 0;

  return (
    <section class={`tp-turn${props.turn().live ? " live" : ""}`}>
      <header class="tp-turn-h">
        <span class={`tp-live-dot${props.turn().live ? " on" : ""}`} />
        <span class="tp-turn-title">
          {props.turn().modeLabel || MODE_LABEL[props.turn().mode ?? ""] || "对话回合"}
        </span>
        <code class="tp-turn-id">{props.turn().messageId.slice(0, 8)}</code>
        <span class="grow" />
        <span class="tp-turn-stats">
          <Chip tone="dim">{fmtClock(props.turn().startedTsMs)}</Chip>
          <Chip tone="dim">R{props.turn().rounds}</Chip>
          <Chip tone="gold">{props.turn().toolCalls} 工具</Chip>
          <Chip tone="dim">
            ↥{fmtTokens(props.turn().promptTokens)} ↧{fmtTokens(props.turn().completionTokens)}
          </Chip>
          <Chip tone={props.turn().live ? "accent" : "green"}>{fmtDuration(elapsed())}</Chip>
        </span>
      </header>
      <div class="tp-timeline">
        <For each={entryIds()}>
          {(id) => (
            <EntryRow entry={entryById(id)} turn={props.turn} pendingCalls={pendingCalls} />
          )}
        </For>
      </div>
    </section>
  );
}

/* ---------- panel ---------- */

export function AgentTracePanel() {
  const { turns, panelOpen, follow, setFollow, ingest, clear, toggle } = useTrace();
  const { activeConversationId, ingestAgentTrace } = useConversation();

  const [nowMs, setNowMs] = createSignal(Date.now());
  let bodyRef: HTMLDivElement | undefined;

  const visibleTurns = createMemo(() => {
    const convId = activeConversationId();
    const all = turns();
    // Strict per-conversation view — showing another conversation's trace
    // unlabeled would mislead exactly the debugging this panel exists for.
    return convId ? all.filter((t) => t.conversationId === convId) : all;
  });

  const turnIds = createMemo(() => visibleTurns().map((t) => t.messageId));
  const turnById = (id: string) => {
    let last: TraceTurn | undefined;
    return () => {
      const found = turns().find((t) => t.messageId === id);
      if (found) last = found;
      return (found ?? last) as TraceTurn;
    };
  };

  const hasLive = createMemo(() => visibleTurns().some((t) => t.live));

  // onCleanup must be registered synchronously (before any await), or
  // Solid never attaches it and listeners leak on every Workspace remount.
  onMount(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onAgentTrace((e) => {
      ingest(e);
      ingestAgentTrace(e);
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyD") {
        ev.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    });
  });

  // Tick the live elapsed timer only while the panel is actually visible.
  createEffect(() => {
    if (!panelOpen()) return;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    onCleanup(() => clearInterval(timer));
  });

  // Follow the newest entry while live.
  createEffect(() => {
    turns();
    if (panelOpen() && follow() && bodyRef) {
      bodyRef.scrollTop = bodyRef.scrollHeight;
    }
  });

  function onWheel(e: WheelEvent) {
    if (e.deltaY < 0 && follow()) setFollow(false);
  }

  return (
    <aside class={`trace-panel${panelOpen() ? " open" : ""}`} aria-label="开发者跟踪面板">
      <div class="tp-accentbar" />
      <header class="tp-h">
        <span class="tp-h-glyph">⌬</span>
        <div class="tp-h-title">
          <b>AGENT TRACE</b>
          <small>后台执行实时跟踪 · dev</small>
        </div>
        <span class={`tp-h-live${hasLive() ? " on" : ""}`}>
          <span class="d" />
          {hasLive() ? "LIVE" : "IDLE"}
        </span>
        <span class="grow" />
        <button
          type="button"
          class={`tp-h-btn${follow() ? " on" : ""}`}
          title="自动滚动到底部"
          onClick={() => {
            setFollow(!follow());
            if (follow() && bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
          }}
        >
          ⤓ 跟随
        </button>
        <button type="button" class="tp-h-btn" title="清空跟踪记录" onClick={() => clear()}>
          清空
        </button>
        <button
          type="button"
          class="tp-h-btn tp-h-close"
          title="关闭 (Ctrl+Shift+D)"
          onClick={() => toggle(false)}
        >
          <Icon name="x" />
        </button>
      </header>

      <div class="tp-body scroll" ref={bodyRef} onWheel={onWheel}>
        {/* Timeline DOM only exists while the panel is visible, so closed
            panels do zero per-delta DOM work during streams. */}
        <Show when={panelOpen()}>
          <Show
            when={turnIds().length > 0}
            fallback={
              <div class="tp-empty">
                <span class="tp-empty-glyph">⌬</span>
                <p>暂无跟踪数据</p>
                <p class="tp-empty-sub">发送一条消息后，后台 agent 的每一步</p>
                <p class="tp-empty-sub">意图分类 · 工具调用 · 技能 · MCP · 思考 · 流式输出</p>
                <p class="tp-empty-sub">都会实时显示在这里</p>
              </div>
            }
          >
            <For each={turnIds()}>
              {(id) => <TurnSection turn={turnById(id)} nowMs={nowMs} />}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
