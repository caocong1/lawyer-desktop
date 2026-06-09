import { Component, createSignal, onMount, Show } from "solid-js";
import TitleBar from "./components/layout/TitleBar";
import SideNav from "./components/layout/SideNav";
import ChatArea from "./components/chat/ChatArea";
import StatusBar from "./components/layout/StatusBar";
import SettingsPanel from "./components/settings/SettingsPanel";
import { useTheme } from "./stores/theme";
import { useConversation } from "./stores/conversation";
import { createConversation } from "./services/api";
import "./themes/stitch-dark.css";
import "./App.css";

const App: Component = () => {
  const [activeSection, setActiveSection] = createSignal("chat");
  const [showSettings, setShowSettings] = createSignal(false);
  const { theme } = useTheme();
  const { addConversation, selectConversation, activeConversationId } = useConversation();

  onMount(async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    // Load Material Symbols font
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);

    // 启动时自动创建一个会话
    try {
      const conv = await createConversation();
      addConversation(conv);
      selectConversation(conv.id);
      console.log("[App] 初始会话已创建:", conv.id);
    } catch (e) {
      console.error("[App] 创建初始会话失败:", e);
    }
  });

  async function handleNewChat() {
    try {
      const conv = await createConversation();
      addConversation(conv);
      selectConversation(conv.id);
    } catch (e) {
      console.error("Failed to create conversation:", e);
    }
  }

  function handleNavigate(section: string) {
    if (section === "settings") {
      setShowSettings(true);
      return;
    }
    setActiveSection(section);
    if (section === "chat" && !activeConversationId()) {
      handleNewChat();
    }
  }

  return (
    <div class="app">
      <TitleBar />
      <div class="app-body">
        <SideNav onNavigate={handleNavigate} activeSection={activeSection()} />
        <ChatArea />
      </div>
      <StatusBar />
      <Show when={showSettings()}>
        <SettingsPanel onClose={() => setShowSettings(false)} />
      </Show>
    </div>
  );
};

export default App;
