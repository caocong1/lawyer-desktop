import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { Icon } from "../icons/Icons";
import { useConversation, type Conversation } from "../../stores/conversation";
import { formatFullTime, parseTimeMs } from "../../utils/chatTime";
import { iconForConversationTitle } from "../../utils/docTypes";
import "./ConversationDrawer.css";

export interface ConversationDrawerProps {
  open: boolean;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
  onDeletedEmpty?: () => void;
  onToast?: (msg: string) => void;
}

function formatRelativeTime(iso: string): string {
  const ms = parseTimeMs(iso);
  if (!ms) return "未知时间";
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function fullTime(iso: string): string {
  const ms = parseTimeMs(iso);
  return ms ? formatFullTime(ms) : "未知时间";
}

function matchesQuery(conversation: Conversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    conversation.title.toLowerCase().includes(q) ||
    conversation.id.toLowerCase().includes(q)
  );
}

export function ConversationDrawer(props: ConversationDrawerProps) {
  const {
    conversations,
    activeConversationId,
    loadConversations,
    removeConversation,
  } = useConversation();
  const [query, setQuery] = createSignal("");
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  let searchRef: HTMLInputElement | undefined;

  const filtered = createMemo(() =>
    conversations().filter((conversation) => matchesQuery(conversation, query())),
  );

  createEffect(() => {
    if (!props.open) return;
    void loadConversations();
    queueMicrotask(() => searchRef?.focus());
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && props.open) props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  async function deleteConversation(event: MouseEvent | KeyboardEvent, conversation: Conversation) {
    event.stopPropagation();
    const ok = window.confirm(`删除会话“${conversation.title || "新会话"}”？此操作不可撤销。`);
    if (!ok) return;

    const wasActive = activeConversationId() === conversation.id;
    setDeletingId(conversation.id);
    try {
      const nextId = await removeConversation(conversation.id);
      props.onToast?.("已删除会话");
      if (wasActive && !nextId) props.onDeletedEmpty?.();
    } catch (error) {
      console.error("删除会话失败:", error);
      props.onToast?.(`删除会话失败: ${String(error)}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Show when={props.open}>
      <div class="conversation-drawer" onClick={props.onClose}>
        <aside
          class="conversation-panel"
          role="dialog"
          aria-modal="true"
          aria-label="会话列表"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="conversation-panel-head">
            <div>
              <div class="conversation-panel-title">会话列表</div>
              <div class="conversation-panel-sub">{conversations().length} 个会话</div>
            </div>
            <button type="button" class="conversation-icon-btn" aria-label="关闭" onClick={props.onClose}>
              <Icon name="x" />
            </button>
          </div>

          <label class="conversation-search">
            <Icon name="search" />
            <input
              ref={searchRef}
              value={query()}
              placeholder="搜索标题或会话 ID"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Show when={query().trim().length > 0}>
              <button
                type="button"
                class="conversation-clear"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
              >
                <Icon name="x" />
              </button>
            </Show>
          </label>

          <div class="conversation-list scroll">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="conversation-empty">
                  <Icon name="doc" />
                  <span>{query().trim() ? "没有匹配的会话" : "暂无会话"}</span>
                </div>
              }
            >
              <For each={filtered()}>
                {(conversation) => (
                  <div
                    class={`conversation-row${
                      activeConversationId() === conversation.id ? " active" : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    title={fullTime(conversation.updated_at)}
                    onClick={() => props.onOpenConversation(conversation.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        props.onOpenConversation(conversation.id);
                      }
                    }}
                  >
                    <span class="conversation-row-ic">
                      <Icon name={iconForConversationTitle(conversation.title)} />
                    </span>
                    <span class="conversation-row-main">
                      <span class="conversation-row-title">{conversation.title || "新会话"}</span>
                      <span class="conversation-row-meta">{formatRelativeTime(conversation.updated_at)}</span>
                    </span>
                    <button
                      type="button"
                      class="conversation-delete"
                      aria-label={`删除 ${conversation.title || "新会话"}`}
                      title="删除"
                      onClick={(event) => void deleteConversation(event, conversation)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void deleteConversation(event, conversation);
                        }
                      }}
                    >
                      <Show
                        when={deletingId() === conversation.id}
                        fallback={<Icon name="trash" />}
                      >
                        <span class="conversation-mini-spinner" />
                      </Show>
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </aside>
      </div>
    </Show>
  );
}
