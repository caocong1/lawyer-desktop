import { Component, createSignal, Show, onMount } from "solid-js";
import TitleBar from "./components/layout/TitleBar";
import SideNav from "./components/layout/SideNav";
import HomePage from "./components/home/HomePage";
import Workspace from "./components/workspace/Workspace";
import SettingsPanel from "./components/settings/SettingsPanel";
import { useConversation } from "./stores/conversation";
import { useSettings } from "./stores/settings";
import { createConversation } from "./services/api";
import "./themes/molv-tokens.css";
import "./themes/molv-base.css";
import "./App.css";

const App: Component = () => {
  const [view, setView] = createSignal<"home" | "workspace">("home");
  const [showSettings, setShowSettings] = createSignal(false);
  const [toast, setToast] = createSignal<{ msg: string; show: boolean }>({ msg: "", show: false });
  const [docReady, setDocReady] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(true);

  const { activeConversationId, loadConversations, switchConversation } = useConversation();
  const { restoreProvider, isConfigured } = useSettings();

  function showToast(msg: string) {
    setToast({ msg, show: true });
    setTimeout(() => setToast({ msg: "", show: false }), 2500);
  }

  function handleStart(prompt: string) {
    setView("workspace");
    setDocReady(true);
    showToast("开始起草：" + prompt.slice(0, 30));
  }

  function handleNavigate(section: string) {
    if (section === "settings") {
      setShowSettings(true);
    } else if (section === "home") {
      setView("home");
    }
  }

  onMount(async () => {
    try {
      await restoreProvider();
      if (!isConfigured()) {
        setShowSettings(true);
      }
      await loadConversations();
      const convs = useConversation().conversations();
      if (convs.length > 0 && !activeConversationId()) {
        await switchConversation(convs[0].id);
      } else if (!activeConversationId()) {
        await createConversation();
      }
    } catch (e) {
      console.error("[App] 启动加载失败:", e);
    } finally {
      setIsLoading(false);
    }
  });

  return (
    <div class="app">
      <Show when={isLoading()}>
        <div class="loading-overlay">
          <div class="loading-spinner" />
          <span>加载中...</span>
        </div>
      </Show>
      <TitleBar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <SideNav onNavigate={handleNavigate} />
        <Show when={view() === "home"}>
          <HomePage onStart={handleStart} onToast={showToast} />
        </Show>
        <Show when={view() === "workspace"}>
          <Workspace docReady={docReady()} onToast={showToast} />
        </Show>
      </div>
      <Show when={showSettings()}>
        <SettingsPanel onClose={() => setShowSettings(false)} />
      </Show>
      <Show when={toast().show}>
        <div class="toast">{toast().msg}</div>
      </Show>
    </div>
  );
};

export default App;
