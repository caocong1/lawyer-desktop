import { Component, createSignal, Show, createEffect } from "solid-js";
import TitleBar from "./components/layout/TitleBar";
import SideNav from "./components/layout/SideNav";
import HomePage from "./components/home/HomePage";
import Workspace from "./components/workspace/Workspace";
import SettingsPanel from "./components/settings/SettingsPanel";
import { useConversation } from "./stores/conversation";
import { createConversation } from "./services/api";
import "./themes/molv-tokens.css";
import "./themes/molv-base.css";
import "./App.css";

const App: Component = () => {
  const [view, setView] = createSignal<"home" | "workspace">("home");
  const [showSettings, setShowSettings] = createSignal(false);
  const [toast, setToast] = createSignal<{ msg: string; show: boolean }>({ msg: "", show: false });
  const [docReady, setDocReady] = createSignal(false);

  const { activeConversationId } = useConversation();

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

  createEffect(async () => {
    if (!activeConversationId()) {
      try {
        await createConversation();
      } catch (e) {
        console.error("[App] 创建初始会话失败:", e);
      }
    }
  });

  return (
    <div class="app">
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
