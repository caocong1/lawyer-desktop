import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMode } from "../../types/agentMode";
import { agentModeLabel } from "../../types/agentMode";
import { useConversation } from "../../stores/conversation";
import type { Message } from "../../stores/conversation";
import { useTrace } from "../../stores/trace";
import { containsToolLeakage } from "../../utils/legalDocument";
import type { ContextRefPayload } from "../../types/contextRefs";
import { onChatStream, onWorkspaceIndexProgress } from "../../services/api";
import type { ClarificationAnswer, WorkflowState } from "../../types/workflow";
import {
  formatFullTime,
  formatTimeDivider,
  parseTimeMs,
  shouldShowTimeDivider,
} from "../../utils/chatTime";
import { isVisibleChatMessage } from "../../utils/chatVisibility";
import { Icon } from "../icons/Icons";
import {
  ClarificationCard,
  WorkflowNotice,
  WorkflowSuggestions,
} from "./WorkflowProgressSteps";
import "./ChatPanel.css";

function pathToAlias(path: string, kind: ContextRefPayload["kind"]): string {
  const normalized = path.replace(/\\/g, "/");
  const segment = normalized.split("/").filter(Boolean).pop() ?? path;
  if (kind === "file") {
    const dot = segment.lastIndexOf(".");
    return dot > 0 ? segment.slice(0, dot) : segment;
  }
  return segment;
}

function AssistantContent(props: { text: string }) {
  return (
    <div class="prose chat-md">
      <SolidMarkdown remarkPlugins={[remarkGfm]}>{props.text}</SolidMarkdown>
    </div>
  );
}

export interface ChatPanelProps {
  onSend: (text: string) => void;
  sending: () => boolean;
}

function sessionTitle(
  prompt: string,
  messageCount: number,
  mode: AgentMode | "idle",
  modeLabel: string,
) {
  if (modeLabel.trim()) {
    return modeLabel.length > 24 ? `${modeLabel.slice(0, 24)}…` : modeLabel;
  }
  if (mode !== "idle") {
    return agentModeLabel(mode);
  }
  const p = prompt.trim();
  if (p) return p.length > 24 ? `${p.slice(0, 24)}…` : p;
  if (messageCount > 0) return "法律咨询";
  return "新会话";
}

type ChatTimelineItem =
  | { type: "time"; id: string; tsMs: number; label: string }
  | { type: "message"; id: string; tsMs?: number; message: Message }
  | { type: "workflow"; id: string; tsMs?: number; workflow: WorkflowState };

function messageTimeMs(message: Message): number | undefined {
  return parseTimeMs(message.created_at);
}

function workflowTimeMs(
  workflow: WorkflowState | undefined,
  fallback?: Message,
): number | undefined {
  const firstStepTime = workflow?.steps.find((step) => step.ts_ms)?.ts_ms;
  return firstStepTime ?? (fallback ? messageTimeMs(fallback) : undefined);
}

function timeTitle(ms?: number): string | undefined {
  return ms ? formatFullTime(ms) : undefined;
}

export function ChatPanel(props: ChatPanelProps) {
  const {
    messages,
    workspacePrompt,
    workspaceMode,
    workspaceModeLabel,
    isStreaming,
    streamingContent,
    streamPhase,
    activeDraftResponse,
    activeEvidenceResponse,
    appendStreamChunk,
    finishStreaming,
    setStreamStatus,
    activeConversationId,
    messageDisplayContent,
    messageWorkflow,
    activeWorkflow,
    submitClarificationAnswers,
    pendingContextRefs,
    addContextRef,
    removeContextRef,
    applyWorkspaceIndexProgress,
    workspaceIndexForPath,
  } = useConversation();
  const { toggle: toggleTrace, panelOpen: tracePanelOpen } = useTrace();

  const [text, setText] = createSignal("");
  const [attachMenuOpen, setAttachMenuOpen] = createSignal(false);
  let threadRef: HTMLDivElement | undefined;
  let taRef: HTMLTextAreaElement | undefined;
  let attachRef: HTMLDivElement | undefined;

  const visibleMessages = () =>
    messages().filter((m) => isVisibleChatMessage(m));

  const liveWorkflow = () => activeWorkflow();

  const timelineItems = createMemo<ChatTimelineItem[]>(() => {
    const rawItems: ChatTimelineItem[] = [];
    const renderedWorkflowIds = new Set<string>();
    for (const message of visibleMessages()) {
      const workflow = message.role === "assistant" ? messageWorkflow(message.id) : undefined;
      if (workflow && !renderedWorkflowIds.has(workflow.message_id)) {
        renderedWorkflowIds.add(workflow.message_id);
        rawItems.push({
          type: "workflow",
          id: `workflow-${workflow.message_id}`,
          tsMs: workflowTimeMs(workflow, message),
          workflow,
        });
      }
      rawItems.push({
        type: "message",
        id: `message-${message.id}`,
        tsMs: messageTimeMs(message),
        message,
      });
    }

    const live = liveWorkflow();
    if (isStreaming() && live && !renderedWorkflowIds.has(live.message_id)) {
      rawItems.push({
        type: "workflow",
        id: `workflow-live-${live.message_id}`,
        tsMs: workflowTimeMs(live) ?? Date.now(),
        workflow: live,
      });
    }

    const withTime: ChatTimelineItem[] = [];
    let previousTs: number | undefined;
    for (const item of rawItems) {
      if (shouldShowTimeDivider(previousTs, item.tsMs)) {
        withTime.push({
          type: "time",
          id: `time-${item.id}`,
          tsMs: item.tsMs as number,
          label: formatTimeDivider(item.tsMs as number),
        });
      }
      if (item.tsMs) previousTs = item.tsMs;
      withTime.push(item);
    }
    return withTime;
  });

  createEffect(() => {
    timelineItems();
    isStreaming();
    streamingContent();
    const el = threadRef;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // onCleanup must be registered synchronously (before any await), or Solid
  // never attaches it — leaked listeners double-append stream chunks after
  // every workspace remount.
  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (attachMenuOpen() && attachRef && !attachRef.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);

    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    let unlistenStream: (() => void) | undefined;

    void onWorkspaceIndexProgress((event) => {
      if (
        event.conversation_id &&
        event.conversation_id !== activeConversationId()
      ) {
        return;
      }
      applyWorkspaceIndexProgress(event);
    }).then((u) => {
      if (disposed) u();
      else unlistenProgress = u;
    });

    void onChatStream((chunk) => {
      if (chunk.conversation_id !== activeConversationId()) return;
      if (chunk.status) {
        setStreamStatus(chunk.status);
      }
      if (chunk.done) {
        void finishStreaming(chunk.message_id);
      } else if (chunk.chunk) {
        appendStreamChunk(chunk.chunk);
      }
    }).then((u) => {
      if (disposed) u();
      else unlistenStream = u;
    });

    onCleanup(() => {
      disposed = true;
      document.removeEventListener("click", onDocClick);
      unlistenProgress?.();
      unlistenStream?.();
    });
  });

  function send() {
    const t = text().trim();
    if (!t || props.sending()) return;
    setText("");
    if (taRef) taRef.style.height = "auto";
    props.onSend(t);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function grow(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    setText(ta.value);
  }

  async function pickContextRef(kind: ContextRefPayload["kind"]) {
    setAttachMenuOpen(false);
    try {
      const selected = await open({
        multiple: false,
        directory: kind === "directory",
      });
      if (!selected || Array.isArray(selected)) return;
      addContextRef({
        alias: pathToAlias(selected, kind),
        path: selected,
        kind,
      });
    } catch (e) {
      console.error("选择路径失败:", e);
    }
  }

  const title = () =>
    sessionTitle(
      workspacePrompt(),
      visibleMessages().length,
      workspaceMode(),
      workspaceModeLabel(),
    );

  const phaseLabel = () => {
    const phase = streamPhase();
    if (phase === "indexing") return "正在索引案卷资料…";
    if (phase === "tool") return "正在检索案卷与法规…";
    if (phase === "streaming") return "正在生成内容…";
    if (phase === "thinking") return "正在分析需求并规划结构…";
    if (phase === "clarifying") return "正在确认补充信息…";
    if (phase === "error") return "请求出错";
    return "正在连接模型…";
  };

  const showEvidenceProgress = () =>
    activeEvidenceResponse() &&
    isStreaming() &&
    (!streamingContent() || containsToolLeakage(streamingContent()));

  const liveWorkflowRunningLabel = () => {
    const steps = liveWorkflow()?.steps ?? [];
    const running = [...steps].reverse().find((step) => step.state === "run");
    return running?.label;
  };

  const statusLine = () => {
    if (!isStreaming()) return `${visibleMessages().length} 条消息`;
    if (liveWorkflowRunningLabel()) return `${liveWorkflowRunningLabel()}…`;
    if (showEvidenceProgress()) return phaseLabel();
    if (streamingContent()) return "正在生成回复…";
    return phaseLabel();
  };

  function insertSuggestion(prompt: string) {
    setText(prompt);
    requestAnimationFrame(() => {
      if (!taRef) return;
      taRef.focus();
      taRef.style.height = "auto";
      taRef.style.height = `${Math.min(taRef.scrollHeight, 120)}px`;
    });
  }

  function answerClarification(messageId: string, answers: ClarificationAnswer[]) {
    void submitClarificationAnswers(messageId, answers).catch((e) => {
      console.error("提交澄清答案失败:", e);
    });
  }

  return (
    <div class="chat" style={{ "--chat-w": "500px" }}>
      <div class="chat-ctx">
        <div class="dic">
          <Icon name="doc" />
        </div>
        <div>
          <div class="ct">{title()}</div>
          <div class="cs">{statusLine()}</div>
        </div>
        <span class="grow" />
        <div class={`stage-pill${isStreaming() || showEvidenceProgress() ? " live" : ""}`}>
          <span class="d" />
          {showEvidenceProgress() ? "生成中" : isStreaming() ? "回复中" : "已就绪"}
        </div>
        <button
          type="button"
          class={`trace-toggle${tracePanelOpen() ? " on" : ""}${isStreaming() ? " busy" : ""}`}
          title="后台执行跟踪 (Ctrl+Shift+D)"
          onClick={() => toggleTrace()}
        >
          <Icon name="terminal" />
        </button>
      </div>

      <div class="thread scroll" ref={threadRef}>
        <Show
          when={timelineItems().length > 0 || isStreaming()}
          fallback={
            <div class="msg msg-agent">
              <div class="ava">墨</div>
              <div class="agent-body">
                <div class="agent-name">墨律 · 法律文书助理</div>
                <AssistantContent text="描述你的起草需求，或在下方向我补充指示。" />
              </div>
            </div>
          }
        >
          <For each={timelineItems()}>
            {(item) => {
              if (item.type === "time") {
                return (
                  <div class="time-divider" title={formatFullTime(item.tsMs)}>
                    {item.label}
                  </div>
                );
              }
              if (item.type === "workflow") {
                return (
                  <WorkflowNotice
                    workflow={() => item.workflow}
                    timeTitle={timeTitle(item.tsMs)}
                  />
                );
              }
              const m = item.message;
              return m.role === "user" ? (
                <div class="msg msg-user" title={timeTitle(item.tsMs)}>
                  <div class="bubble-user">{m.content}</div>
                </div>
              ) : (
                <div class="msg msg-agent" title={timeTitle(item.tsMs)}>
                  <div class="ava">墨</div>
                  <div class="agent-body">
                    <div class="agent-name">墨律 · 法律文书助理</div>
                    <Show when={messageDisplayContent(m).trim()}>
                      {(content) => <AssistantContent text={content()} />}
                    </Show>
                    <Show when={messageWorkflow(m.id)}>
                      {(workflow) => (
                        <>
                          <ClarificationCard
                            workflow={workflow}
                            disabled={props.sending}
                            onClarificationSubmit={answerClarification}
                          />
                          <WorkflowSuggestions
                            workflow={workflow}
                            disabled={props.sending}
                            onSuggestionClick={insertSuggestion}
                          />
                        </>
                      )}
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>
        <Show
          when={
            isStreaming() &&
            liveWorkflow() &&
            !activeDraftResponse() &&
            !activeEvidenceResponse() &&
            streamingContent() &&
            !containsToolLeakage(streamingContent())
          }
        >
          <div class="msg msg-agent" title={formatFullTime(Date.now())}>
            <div class="ava">墨</div>
            <div class="agent-body">
              <div class="agent-name">墨律 · 法律文书助理</div>
              <AssistantContent text={streamingContent()} />
            </div>
          </div>
        </Show>
        <Show when={isStreaming() && !liveWorkflow() && showEvidenceProgress()}>
          <div class="msg msg-agent">
            <div class="ava">墨</div>
            <div class="agent-body">
              <div class="agent-name">墨律 · 法律文书助理</div>
              <div class="streaming-wait">
                <span class="streaming-wait-dot" />
                {phaseLabel()}
              </div>
            </div>
          </div>
        </Show>
        <Show when={isStreaming() && !liveWorkflow() && !showEvidenceProgress() && !streamingContent()}>
          <div class="msg msg-agent">
            <div class="ava">墨</div>
            <div class="agent-body">
              <div class="agent-name">墨律 · 法律文书助理</div>
              <div class="streaming-wait">
                <span class="streaming-wait-dot" />
                {phaseLabel()}
              </div>
            </div>
          </div>
        </Show>
        <Show
          when={
            isStreaming() &&
            !liveWorkflow() &&
            !showEvidenceProgress() &&
            !activeDraftResponse() &&
            !activeEvidenceResponse() &&
            streamingContent()
          }
        >
          <div class="msg msg-agent">
            <div class="ava">墨</div>
            <div class="agent-body">
              <div class="agent-name">墨律 · 法律文书助理</div>
              <AssistantContent text={streamingContent()} />
            </div>
          </div>
        </Show>
      </div>

      <div class="composer">
        <div class="input-box">
          <Show when={pendingContextRefs().length > 0}>
            <div class="context-ref-chips">
              <For each={pendingContextRefs()}>
                {(ref) => {
                  const indexState = () =>
                    ref.kind === "directory" ? workspaceIndexForPath(ref.path) : undefined;
                  return (
                  <span class="context-ref-chip" title={ref.path}>
                    <span class="context-ref-alias">@{ref.alias}</span>
                    <span class="context-ref-kind">
                      {ref.kind === "directory" ? "目录" : "文件"}
                    </span>
                    <Show when={ref.kind === "directory" && indexState()}>
                      {(idx) => (
                        <span class="context-ref-index">
                          {idx().done
                            ? `已索引 ${idx().fileCount} 文件`
                            : idx().total > 0
                              ? `索引中 ${idx().processed}/${idx().total}`
                              : "索引中…"}
                        </span>
                      )}
                    </Show>
                    <button
                      type="button"
                      class="context-ref-remove"
                      aria-label={`移除 ${ref.alias}`}
                      onClick={() => removeContextRef(ref.path)}
                      disabled={props.sending()}
                    >
                      ×
                    </button>
                  </span>
                  );
                }}
              </For>
            </div>
          </Show>
          <textarea
            ref={taRef}
            rows={1}
            placeholder="补充指示，或描述新的起草需求……"
            value={text()}
            onInput={grow}
            onKeyDown={onKey}
            disabled={props.sending()}
          />
          <div class="input-row">
            <div class="attach-wrap" ref={attachRef}>
              <button
                type="button"
                class="tool attach-btn"
                title="附加文件或目录"
                disabled={props.sending()}
                onClick={(e) => {
                  e.stopPropagation();
                  setAttachMenuOpen((v) => !v);
                }}
              >
                <Icon name="attach" />
              </button>
              <Show when={attachMenuOpen()}>
                <div class="attach-menu">
                  <button type="button" onClick={() => void pickContextRef("file")}>
                    选择文件
                  </button>
                  <button type="button" onClick={() => void pickContextRef("directory")}>
                    选择文件夹
                  </button>
                </div>
              </Show>
            </div>
            <span class="tool">
              <Icon name="book" />
            </span>
            <span class="grow" />
            <button
              type="button"
              class="send-btn"
              onClick={send}
              disabled={!text().trim() || props.sending()}
            >
              发送
              <Icon name="send" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
