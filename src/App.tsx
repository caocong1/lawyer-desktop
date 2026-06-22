import { createSignal, Show, onMount } from "solid-js";
import { HomePage } from "./components/home/HomePage";
import { ConversationDrawer } from "./components/layout/ConversationDrawer";
import { TitleBar } from "./components/layout/TitleBar";
import { AppUpdateBanner } from "./components/layout/AppUpdateBanner";
import { Workspace } from "./components/workspace/Workspace";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { useSettings } from "./stores/settings";
import { useConversation } from "./stores/conversation";
import { createConversation } from "./services/api";
import "./App.css";
import "./components/layout/AppUpdateBanner.css";

type Screen = "home" | "workspace";

export default function App() {
  const [screen, setScreen] = createSignal<Screen>("home");
  const [draftKey, setDraftKey] = createSignal(0);
  const [prompt, setPrompt] = createSignal<string>("");
  const [toast, setToast] = createSignal("");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [conversationListOpen, setConversationListOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const { restoreProvider, isConfigured } = useSettings();
  const { loadConversations, activeConversationId, setActiveConversationId, addConversation, switchConversation, messages } =
    useConversation();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(async () => {
    try {
      await restoreProvider();
      if (!isConfigured()) {
        setSettingsOpen(true);
      }
      await loadConversations();
      if (!activeConversationId()) {
        const conv = await createConversation();
        addConversation(conv);
        setActiveConversationId(conv.id);
      }
    } catch (e) {
      console.error("[App] 启动加载失败:", e);
    } finally {
      setLoading(false);
    }
  });

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(""), 2400);
  }

  async function start(p: string) {
    if (!isConfigured()) {
      setSettingsOpen(true);
      showToast("请先在设置中配置 LLM 模型");
      return;
    }
    try {
      const conv = await createConversation();
      addConversation(conv);
      setActiveConversationId(conv.id);
      setPrompt(p);
      setDraftKey((k) => k + 1);
      setScreen("workspace");
    } catch (e) {
      console.error("创建会话失败:", e);
      showToast(`创建会话失败: ${String(e)}`);
    }
  }

  async function openConversation(id: string) {
    await switchConversation(id);
    const msgs = messages();
    const firstUser = msgs.find((m) => m.role === "user");
    setPrompt(firstUser?.content || "");
    setDraftKey((k) => k + 1);
    setScreen("workspace");
    setConversationListOpen(false);
  }

  return (
    <div class="app">
      <Show when={loading()}>
        <div class="loading-overlay">
          <div class="loading-spinner" />
          <span>加载中...</span>
        </div>
      </Show>
      <TitleBar
        screen={screen()}
        onGoHome={() => setScreen("home")}
        onOpenConversations={() => setConversationListOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <AppUpdateBanner />

      <div class="stage">
        <Show
          when={screen() === "workspace"}
          fallback={
            <div class="screen anim">
              <HomePage
                onStart={(p) => void start(p)}
                onToast={showToast}
              />
            </div>
          }
        >
          <div class="screen anim">
            <Workspace
              draftKey={draftKey()}
              prompt={prompt()}
              onToast={showToast}
              toast={toast()}
            />
          </div>
        </Show>
      </div>

      <Show when={settingsOpen()}>
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSaved={(msg) => showToast(msg)}
        />
      </Show>

      <ConversationDrawer
        open={conversationListOpen()}
        onClose={() => setConversationListOpen(false)}
        onOpenConversation={(id) => void openConversation(id)}
        onDeletedEmpty={() => {
          setPrompt("");
          setScreen("home");
        }}
        onToast={showToast}
      />
    </div>
  );
}
