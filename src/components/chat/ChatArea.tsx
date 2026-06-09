import { Component, For, Show, createEffect } from "solid-js";
import { useConversation } from "../../stores/conversation";
import FloatingInput from "./FloatingInput";
import { save } from "@tauri-apps/plugin-dialog";
import { generateDocx } from "../../services/api";
import "./ChatArea.css";

const ChatArea: Component = () => {
  const { messages, activeConversationId, isStreaming, streamingContent } = useConversation();
  let messagesEndRef: HTMLDivElement | undefined;

  createEffect(() => {
    // 追踪 messages 和 streamingContent 的变化以触发自动滚动
    messages();
    streamingContent();
    setTimeout(() => messagesEndRef?.scrollIntoView({ behavior: "smooth" }), 50);
  });

  async function handleExport() {
    const currentMessages = messages();
    if (currentMessages.length === 0) return;

    // Build markdown content from messages
    let markdown = "";
    for (const msg of currentMessages) {
      if (msg.role === "user") {
        markdown += `## 用户\n\n${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        markdown += `## AI 助手\n\n${msg.content}\n\n`;
      }
    }

    // Open save dialog
    const filePath = await save({
      filters: [{ name: "Word Document", extensions: ["docx"] }],
      defaultPath: "法律助手对话.docx",
    });

    if (filePath) {
      try {
        await generateDocx({
          title: "法律助手对话记录",
          content_markdown: markdown,
          output_path: filePath,
        });
        alert("导出成功！");
      } catch (e) {
        console.error("Export failed:", e);
        alert("导出失败: " + e);
      }
    }
  }

  return (
    <main class="chat-area">
      <div class="mesh-gradient"></div>

      <Show
        when={activeConversationId()}
        fallback={
          <div class="chat-empty">
            <div class="empty-icon">⚖️</div>
            <h2 class="empty-title">Lexis-Forge AI</h2>
            <p class="empty-subtitle">中国法律 AI 助手</p>
            <p class="empty-hint">选择或新建一个会话开始工作</p>
          </div>
        }
      >
        <div class="chat-toolbar">
          <button class="toolbar-btn" onClick={handleExport} title="导出为 Word 文档">
            <span class="material-symbols-outlined">download</span>
            <span>导出</span>
          </button>
        </div>
        <div class="messages-scroll">
          <div class="messages-container">
            <For each={messages()}>
              {(msg) => (
                <div class={`message-row ${msg.role}`}>
                  <Show when={msg.role === "user"}>
                    <div class="message-bubble user-bubble">
                      <div class="message-header">
                        <span class="message-sender">User</span>
                      </div>
                      <p class="message-content">{msg.content}</p>
                    </div>
                  </Show>
                  <Show when={msg.role === "assistant"}>
                    <div class="message-bubble ai-bubble">
                      <div class="message-header">
                        <span class="material-symbols-outlined ai-icon">auto_awesome</span>
                        <span class="message-sender">Lexis-Forge AI Analysis</span>
                      </div>
                      <div class="message-content markdown-content">{msg.content}</div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={isStreaming()}>
              <div class="message-row assistant">
                <div class="message-bubble ai-bubble">
                  <div class="message-header">
                    <span class="material-symbols-outlined ai-icon">auto_awesome</span>
                    <span class="message-sender">Lexis-Forge AI Analysis</span>
                  </div>
                  <div class="message-content">
                    {streamingContent() || <span class="typing-indicator">思考中...</span>}
                  </div>
                </div>
              </div>
            </Show>
            <div ref={messagesEndRef} />
          </div>
        </div>
        <FloatingInput />
      </Show>
    </main>
  );
};

export default ChatArea;
