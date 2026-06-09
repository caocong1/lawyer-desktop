import { Component, For, Show, createEffect, onMount } from "solid-js";
import { useConversation } from "../../stores/conversation";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import "./ChatView.css";

const ChatView: Component = () => {
  const { messages, activeConversationId, isStreaming, streamingContent } = useConversation();
  let messagesEndRef: HTMLDivElement | undefined;

  createEffect(() => {
    // Auto-scroll on new messages or streaming
    messages.length;
    streamingContent();
    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
  });

  return (
    <div class="chat-view">
      <Show
        when={activeConversationId()}
        fallback={
          <div class="chat-empty">
            <div class="empty-icon">⚖️</div>
            <h2>律师助手</h2>
            <p>选择或新建一个会话开始工作</p>
            <p class="empty-hint">
              支持合同审查、法律文书起草、法律研究等
            </p>
          </div>
        }
      >
        <div class="messages-container">
          <For each={messages}>
            {(msg) => <MessageBubble message={msg} />}
          </For>
          <Show when={isStreaming()}>
            <div class="message assistant streaming">
              <div class="message-content">
                {streamingContent() || <span class="typing-indicator">思考中...</span>}
              </div>
            </div>
          </Show>
          <div ref={messagesEndRef} />
        </div>
        <ChatInput />
      </Show>
    </div>
  );
};

export default ChatView;
