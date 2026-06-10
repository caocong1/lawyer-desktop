import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import { useConversation } from "../../stores/conversation";
import { onChatStream } from "../../services/api";
import { Icon } from "../icons/Icons";
import "./ChatPanel.css";

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

function sessionTitle(prompt: string, messageCount: number) {
  const p = prompt.trim();
  if (p) return p.length > 24 ? `${p.slice(0, 24)}…` : p;
  if (messageCount > 0) return "法律文书起草";
  return "新会话";
}

export function ChatPanel(props: ChatPanelProps) {
  const {
    messages,
    workspacePrompt,
    isStreaming,
    streamingContent,
    appendStreamChunk,
    finishStreaming,
    activeConversationId,
  } = useConversation();

  const [text, setText] = createSignal("");
  let threadRef: HTMLDivElement | undefined;
  let taRef: HTMLTextAreaElement | undefined;

  const visibleMessages = () =>
    messages().filter((m) => m.role === "user" || m.role === "assistant");

  createEffect(() => {
    visibleMessages();
    isStreaming();
    streamingContent();
    const el = threadRef;
    if (el) el.scrollTop = el.scrollHeight;
  });

  onMount(async () => {
    const unlisten = await onChatStream((chunk) => {
      if (chunk.conversation_id !== activeConversationId()) return;
      if (chunk.done) {
        finishStreaming(chunk.message_id);
      } else if (chunk.chunk) {
        appendStreamChunk(chunk.chunk);
      }
    });
    onCleanup(() => {
      unlisten();
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

  const title = () => sessionTitle(workspacePrompt(), visibleMessages().length);

  return (
    <div class="chat" style={{ "--chat-w": "500px" }}>
      <div class="chat-ctx">
        <div class="dic">
          <Icon name="doc" />
        </div>
        <div>
          <div class="ct">{title()}</div>
          <div class="cs">
            {isStreaming() ? "正在生成回复…" : `${visibleMessages().length} 条消息`}
          </div>
        </div>
        <span class="grow" />
        <div class={`stage-pill${isStreaming() ? " live" : ""}`}>
          <span class="d" />
          {isStreaming() ? "回复中" : "已就绪"}
        </div>
      </div>

      <div class="thread scroll" ref={threadRef}>
        <Show
          when={visibleMessages().length > 0 || isStreaming()}
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
          <For each={visibleMessages()}>
            {(m) =>
              m.role === "user" ? (
                <div class="msg msg-user">
                  <div class="bubble-user">{m.content}</div>
                </div>
              ) : (
                <div class="msg msg-agent">
                  <div class="ava">墨</div>
                  <div class="agent-body">
                    <div class="agent-name">墨律 · 法律文书助理</div>
                    <AssistantContent text={m.content} />
                  </div>
                </div>
              )
            }
          </For>
        </Show>
        <Show when={isStreaming() && streamingContent()}>
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
            <span class="tool">
              <Icon name="attach" />
            </span>
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
