import { Component, For, Show } from "solid-js";
import { useConversation } from "../../stores/conversation";
import { useTheme } from "../../stores/theme";
import "./Sidebar.css";

interface SidebarProps {
  onNewChat: () => void;
  onOpenSettings: () => void;
}

const Sidebar: Component<SidebarProps> = (props) => {
  const { conversations, activeConversationId, selectConversation, removeConversation } =
    useConversation();
  const { theme, toggleTheme } = useTheme();

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2 class="sidebar-title">律师助手</h2>
        <button class="icon-btn" onClick={toggleTheme} title="切换主题">
          {theme() === "light" ? "🌙" : "☀️"}
        </button>
      </div>

      <button class="new-chat-btn" onClick={props.onNewChat}>
        <span class="icon">+</span>
        新建会话
      </button>

      <div class="conversation-list">
        <For each={conversations()}>
          {(conv) => (
            <div
              class={`conversation-item ${conv.id === activeConversationId() ? "active" : ""}`}
              onClick={() => selectConversation(conv.id)}
            >
              <span class="conv-title">{conv.title}</span>
              <button
                class="conv-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  removeConversation(conv.id);
                }}
                title="删除会话"
              >
                ×
              </button>
            </div>
          )}
        </For>
        <Show when={conversations().length === 0}>
          <div class="empty-hint">暂无会话记录</div>
        </Show>
      </div>

      <div class="sidebar-footer">
        <button class="settings-btn" onClick={props.onOpenSettings}>
          ⚙️ 设置
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
