import { Component, createSignal } from "solid-js";
import { useConversation } from "../../stores/conversation";
import { sendMessage, onChatStream } from "../../services/api";
import "./FloatingInput.css";

const FloatingInput: Component = () => {
  const [inputText, setInputText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  const {
    activeConversationId,
    addMessage,
    startStreaming,
    appendStreamChunk,
    finishStreaming,
    isStreaming,
    setIsStreaming,
    setStreamingContent,
  } = useConversation();

  onChatStream((chunk) => {
    if (chunk.done) {
      finishStreaming(chunk.message_id);
      setSending(false);
    } else {
      appendStreamChunk(chunk.chunk);
    }
  });

  async function handleSend() {
    const text = inputText().trim();
    if (!text || !activeConversationId() || sending() || isStreaming()) return;

    setErrorMsg(null);
    setSending(true);
    const convId = activeConversationId()!;

    // 先添加用户消息到 UI
    addMessage({
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    });

    setInputText("");
    startStreaming();

    try {
      await sendMessage({
        conversation_id: convId,
        content: text,
      });
    } catch (e: any) {
      console.error("Send error:", e);
      const errMsg = e?.toString() || "发送失败";
      setErrorMsg(errMsg);
      // 添加错误消息到 UI
      addMessage({
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: "assistant",
        content: `⚠️ 错误: ${errMsg}\n\n请确保已在设置中配置 LLM Provider。`,
        created_at: new Date().toISOString(),
      });
      setSending(false);
      // 重置 streaming 状态
      setIsStreaming(false);
      setStreamingContent("");
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div class="floating-input-wrapper">
      <div class="floating-input-container">
        <button class="input-action-btn" title="附加文件">
          <span class="material-symbols-outlined">attach_file</span>
        </button>
        
        <input
          type="text"
          class="floating-input"
          placeholder="向 Lexis-Forge 咨询法律条款..."
          value={inputText()}
          onInput={(e) => setInputText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={sending() || isStreaming()}
        />

        <div class="input-actions-right">
          <button class="input-action-btn" title="知识库">
            <span class="material-symbols-outlined">menu_book</span>
          </button>
          <button class="input-action-btn" title="语音输入">
            <span class="material-symbols-outlined">mic</span>
          </button>
          <button
            class="send-btn"
            onClick={handleSend}
            disabled={sending() || isStreaming() || !inputText().trim()}
          >
            <span class="material-symbols-outlined">arrow_forward</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default FloatingInput;
