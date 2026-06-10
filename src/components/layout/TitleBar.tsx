import { createMemo, For, Show } from "solid-js";
import { Icon } from "../icons/Icons";
import { useTheme, type ThemeVariant } from "../../stores/theme";
import { useConversation } from "../../stores/conversation";
import "./TitleBar.css";

export interface TitleBarProps {
  screen: "home" | "workspace";
  onGoHome: () => void;
  onOpenSettings: () => void;
}

export function TitleBar(props: TitleBarProps) {
  const { theme, setTheme } = useTheme();
  const { conversations, activeConversationId, workspacePrompt } = useConversation();

  const conversationTitle = createMemo(() => {
    const id = activeConversationId();
    if (!id) return "新会话";
    const conv = conversations().find((c) => c.id === id);
    return conv?.title || "新会话";
  });

  const documentTitle = createMemo(() => {
    if (workspacePrompt()) return "起草中";
    return "法律文书";
  });

  return (
    <div class="tb">
      <div class="tb-traffic">
        <span class="tb-dot" style={{ background: "var(--muted)", opacity: "0.5" }} />
        <span class="tb-dot" style={{ background: "var(--muted)", opacity: "0.5" }} />
        <span class="tb-dot" style={{ background: "var(--muted)", opacity: "0.5" }} />
      </div>
      <div class="brand" onClick={props.onGoHome}>
        <div class="seal">墨</div>
        <div class="brand-name">
          墨律<small>Inkstatute</small>
        </div>
      </div>
      <div class="tb-crumbs">
        <Show
          when={props.screen === "workspace"}
          fallback={<span class="muted">工作台</span>}
        >
          <span class="muted">{conversationTitle()}</span>
          <span class="sep">/</span>
          <span>{documentTitle()}</span>
        </Show>
      </div>
      <div class="tb-right">
        <div class="theme-switch">
          <For each={["a", "b", "c"] as ThemeVariant[]}>
            {(t) => (
              <span
                class={`theme-dot ${t}${theme() === t ? " on" : ""}`}
                title={`主题 ${t.toUpperCase()}`}
                onClick={() => setTheme(t)}
              />
            )}
          </For>
        </div>
        <button type="button" class="tb-ibtn" title="搜索">
          <Icon name="search" />
        </button>
        <button type="button" class="tb-ibtn" title="设置" onClick={props.onOpenSettings}>
          <Icon name="settings" />
        </button>
      </div>
    </div>
  );
}
