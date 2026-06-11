import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "../icons/Icons";
import { useTheme, type ThemeVariant } from "../../stores/theme";
import { agentModeLabel } from "../../types/agentMode";
import { useConversation } from "../../stores/conversation";
import "./TitleBar.css";

export interface TitleBarProps {
  screen: "home" | "workspace";
  onGoHome: () => void;
  onOpenConversations: () => void;
  onOpenSettings: () => void;
}

function isMacOS() {
  return /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
}

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "button, a, input, select, textarea, .tb-traffic, .tb-win-ctrls, .brand, .theme-switch",
    ),
  );
}

async function runWindowAction(action: (win: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (!isTauri()) return;
  try {
    await action(getCurrentWindow());
  } catch (error) {
    console.error("[TitleBar] window action failed:", error);
  }
}

function stopTitlebarMouseDown(event: MouseEvent) {
  event.stopPropagation();
}

function WinMinimizeIcon() {
  return (
    <svg viewBox="0 0 10 10" class="tb-win-icon" aria-hidden="true">
      <path d="M0 5h10" />
    </svg>
  );
}

function WinMaximizeIcon() {
  return (
    <svg viewBox="0 0 10 10" class="tb-win-icon" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
    </svg>
  );
}

function WinRestoreIcon() {
  return (
    <svg viewBox="0 0 10 10" class="tb-win-icon" aria-hidden="true">
      <path d="M3 1.5h5.5V7H3z" />
      <path d="M1.5 3h5.5v5.5H1.5z" />
    </svg>
  );
}

function WinCloseIcon() {
  return (
    <svg viewBox="0 0 10 10" class="tb-win-icon" aria-hidden="true">
      <path d="M1 1l8 8M9 1L1 9" />
    </svg>
  );
}

export function TitleBar(props: TitleBarProps) {
  const isMac = isMacOS();
  const { theme, setTheme } = useTheme();
  const { conversations, activeConversationId, workspaceMode, workspaceModeLabel } =
    useConversation();
  const [isMaximized, setIsMaximized] = createSignal(false);

  const conversationTitle = () => {
    const id = activeConversationId();
    if (!id) return "新会话";
    const conv = conversations().find((c) => c.id === id);
    return conv?.title || "新会话";
  };

  const documentTitle = () => {
    const mode = workspaceMode();
    if (mode !== "idle") {
      return workspaceModeLabel() || agentModeLabel(mode);
    }
    return "墨律";
  };

  onMount(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const win = getCurrentWindow();
        setIsMaximized(await win.isMaximized());
        unlisten = await win.onResized(async () => {
          setIsMaximized(await win.isMaximized());
        });
      } catch (error) {
        console.error("[TitleBar] failed to track window state:", error);
      }
    })();

    onCleanup(() => {
      unlisten?.();
    });
  });

  const handleDragRegionDoubleClick = (event: MouseEvent) => {
    if (isInteractiveTarget(event.target)) return;
    event.preventDefault();
    void runWindowAction((win) => win.toggleMaximize());
  };

  const handleMacDragMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    if (event.detail === 2) {
      event.preventDefault();
      void runWindowAction((win) => win.toggleMaximize());
      return;
    }
    void runWindowAction((win) => win.startDragging());
  };

  const minimize = () => void runWindowAction((win) => win.minimize());
  const toggleMaximize = () => void runWindowAction((win) => win.toggleMaximize());
  const close = () => void runWindowAction((win) => win.close());

  return (
    <div
      class={`tb${isMac ? " tb--mac" : " tb--win"}`}
      onDblClick={isMac ? undefined : handleDragRegionDoubleClick}
    >
      <Show when={isMac}>
        <div class="tb-traffic tb-no-drag">
          <button
            type="button"
            class="tb-dot tb-dot--close"
            aria-label="关闭"
            onMouseDown={stopTitlebarMouseDown}
            onClick={close}
          />
          <button
            type="button"
            class="tb-dot tb-dot--minimize"
            aria-label="最小化"
            onMouseDown={stopTitlebarMouseDown}
            onClick={minimize}
          />
          <button
            type="button"
            class="tb-dot tb-dot--maximize"
            aria-label="最大化"
            onMouseDown={stopTitlebarMouseDown}
            onClick={toggleMaximize}
          />
        </div>
      </Show>
      <div class="brand tb-no-drag" onClick={props.onGoHome}>
        <div class="seal">墨</div>
        <div class="brand-name">
          墨律<small>Inkstatute</small>
        </div>
      </div>
      <div
        class="tb-crumbs"
        {...(isMac
          ? {
              "data-tauri-drag-region": true,
              onMouseDown: handleMacDragMouseDown,
            }
          : {})}
      >
        <Show
          when={props.screen === "workspace"}
          fallback={null}
        >
          <span class="muted">{conversationTitle()}</span>
          <span class="sep">/</span>
          <span>{documentTitle()}</span>
        </Show>
      </div>
      <div class="tb-right tb-no-drag">
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
        <button
          type="button"
          class="tb-ibtn"
          title="会话列表"
          onClick={props.onOpenConversations}
        >
          <Icon name="search" />
        </button>
        <button type="button" class="tb-ibtn" title="设置" onClick={props.onOpenSettings}>
          <Icon name="settings" />
        </button>
        <Show when={!isMac}>
          <div class="tb-win-ctrls">
            <button
              type="button"
              class="tb-win-ctrl"
              aria-label="最小化"
              onMouseDown={stopTitlebarMouseDown}
              onClick={minimize}
            >
              <WinMinimizeIcon />
            </button>
            <button
              type="button"
              class="tb-win-ctrl"
              aria-label={isMaximized() ? "还原" : "最大化"}
              onMouseDown={stopTitlebarMouseDown}
              onClick={toggleMaximize}
            >
              <Show when={isMaximized()} fallback={<WinMaximizeIcon />}>
                <WinRestoreIcon />
              </Show>
            </button>
            <button
              type="button"
              class="tb-win-ctrl tb-win-ctrl--close"
              aria-label="关闭"
              onMouseDown={stopTitlebarMouseDown}
              onClick={close}
            >
              <WinCloseIcon />
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
