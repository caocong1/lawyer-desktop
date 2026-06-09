import { Component, createSignal, Show, For } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { useConversation } from "../../stores/conversation";
import { sendMessage, prepareAttachment, onChatStream } from "../../services/api";
import type { FileAttachment } from "../../stores/conversation";
import "./ChatInput.css";

const ChatInput: Component = () => {
  const [inputText, setInputText] = createSignal("");
  const [attachments, setAttachments] = createSignal<FileAttachment[]>([]);
  const [sending, setSending] = createSignal(false);

  const {
    activeConversationId,
    addMessage,
    startStreaming,
    appendStreamChunk,
    finishStreaming,
    isStreaming,
  } = useConversation();

  // Listen for stream events
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
    if (!text && attachments().length === 0) return;
    if (!activeConversationId() || sending() || isStreaming()) return;

    setSending(true);
    const convId = activeConversationId()!;
    const currentAttachments = attachments();

    // Add user message to UI immediately
    addMessage({
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "user",
      content: text,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      created_at: new Date().toISOString(),
    });

    setInputText("");
    setAttachments([]);
    startStreaming();

    try {
      await sendMessage({
        conversation_id: convId,
        content: text,
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      });
    } catch (e) {
      console.error("Send message error:", e);
      finishStreaming("error");
      setSending(false);
    }
  }

  async function handleFileSelect() {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        const newAttachments: FileAttachment[] = [];

        for (const path of paths) {
          try {
            const att = await prepareAttachment(path);
            newAttachments.push(att);
          } catch (e) {
            console.error("Failed to prepare attachment:", e);
          }
        }

        setAttachments((prev) => [...prev, ...newAttachments]);
      }
    } catch (e) {
      console.error("File select error:", e);
    }
  }

  async function handleDirSelect() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected) {
        const att: FileAttachment = {
          path: selected,
          name: selected.split(/[/\\]/).pop() || selected,
          file_type: "directory",
          size: 0,
        };
        setAttachments((prev) => [...prev, att]);
      }
    } catch (e) {
      console.error("Dir select error:", e);
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files) {
      for (const file of Array.from(files)) {
        // Tauri drag-drop provides file paths
        const path = (file as any).path || file.name;
        if (path) {
          prepareAttachment(path).then((att) => {
            setAttachments((prev) => [...prev, att]);
          }).catch(console.error);
        }
      }
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  return (
    <div class="chat-input-area" onDrop={handleDrop} onDragOver={handleDragOver}>
      <Show when={attachments().length > 0}>
        <div class="attachments-preview">
          <For each={attachments()}>
            {(att, index) => (
              <span class="attachment-tag">
                {att.file_type === "directory" ? "📁" : "📄"} {att.name}
                <button class="remove-attachment" onClick={() => removeAttachment(index())}>
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="input-row">
        <div class="input-actions">
          <button class="action-btn" onClick={handleFileSelect} title="选择文件">
            📎
          </button>
          <button class="action-btn" onClick={handleDirSelect} title="选择目录">
            📁
          </button>
        </div>

        <textarea
          class="chat-textarea"
          placeholder="输入消息... (Shift+Enter 换行)"
          value={inputText()}
          onInput={(e) => setInputText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={sending() || isStreaming()}
          rows={3}
        />

        <button
          class="send-btn"
          onClick={handleSend}
          disabled={sending() || isStreaming() || (!inputText().trim() && attachments().length === 0)}
        >
          {sending() || isStreaming() ? "⏳" : "发送"}
        </button>
      </div>
    </div>
  );
};

export default ChatInput;
