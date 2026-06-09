import { Component, Show, For } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../../stores/conversation";
import { submitFeedback } from "../../services/api";
import "./ChatView.css";

interface MessageBubbleProps {
  message: Message;
}

const MessageBubble: Component<MessageBubbleProps> = (props) => {
  async function handleFeedback(rating: number) {
    try {
      await submitFeedback({
        message_id: props.message.id,
        conversation_id: props.message.conversation_id,
        rating,
      });
    } catch (e) {
      console.error("Failed to submit feedback:", e);
    }
  }

  return (
    <div class={`message ${props.message.role}`}>
      <Show when={props.message.attachments && props.message.attachments.length > 0}>
        <div class="message-attachments">
          <For each={props.message.attachments}>
            {(att) => (
              <span class="attachment-chip">
                {att.file_type === "directory" ? "📁" : "📄"} {att.name}
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="message-content">
        <Show
          when={props.message.role === "assistant"}
          fallback={<span>{props.message.content}</span>}
        >
          <SolidMarkdown remarkPlugins={[remarkGfm]}>
            {props.message.content}
          </SolidMarkdown>
        </Show>
      </div>

      <Show when={props.message.role === "assistant" && props.message.content.length > 0}>
        <div class="feedback-row">
          <button class="feedback-btn" onClick={() => handleFeedback(2)} title="有帮助">
            👍
          </button>
          <button class="feedback-btn" onClick={() => handleFeedback(1)} title="需要改进">
            👎
          </button>
        </div>
      </Show>
    </div>
  );
};

export default MessageBubble;
