import { createSignal, Show, For } from "solid-js";
import type { Message } from "../../stores/conversation";
import { submitMessageFeedback } from "../../services/api";
import { useConversation } from "../../stores/conversation";
import type { MessageMetadata } from "../../types/workflow";
import "./MessageFeedback.css";

const DIMENSIONS = ["案由", "法条", "结构", "检索", "其他"] as const;

export interface MessageFeedbackProps {
  message: Message;
  disabled?: boolean;
}

function skillFromMessage(msg: Message): { name?: string; plugin?: string } {
  const meta = msg.metadata as MessageMetadata | undefined;
  if (meta?.active_skill) {
    return { name: meta.active_skill.name, plugin: meta.active_skill.plugin_name };
  }
  const workflow = meta?.workflow;
  const skillStep = workflow?.steps?.find((s) => s.kind === "skill");
  if (skillStep?.detail) {
    const m = skillStep.detail.match(/「(.+?)」/);
    if (m) return { name: m[1] };
  }
  return {};
}

export function MessageFeedback(props: MessageFeedbackProps) {
  const { activeConversationId, persistMessageFeedback } = useConversation();
  const [expanded, setExpanded] = createSignal(false);
  const [comment, setComment] = createSignal("");
  const [dims, setDims] = createSignal<string[]>([]);
  const [submitting, setSubmitting] = createSignal(false);

  const existing = () => (props.message.metadata as MessageMetadata | undefined)?.feedback;

  const toggleDim = (d: string) => {
    setDims((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  };

  const submit = async (rating: "up" | "down") => {
    const convId = activeConversationId();
    if (!convId || submitting()) return;
    setSubmitting(true);
    const skill = skillFromMessage(props.message);
    try {
      await submitMessageFeedback({
        message_id: props.message.id,
        conversation_id: convId,
        skill_name: skill.name,
        plugin_name: skill.plugin,
        rating,
        comment: comment().trim() || undefined,
        dimensions: dims().length ? dims() : undefined,
      });
      persistMessageFeedback(props.message.id, {
        rating,
        comment: comment().trim() || undefined,
        dimensions: dims().length ? dims() : undefined,
        at: new Date().toISOString(),
      });
      setExpanded(false);
    } catch (e) {
      console.warn("反馈提交失败:", e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="msg-feedback">
      <Show
        when={existing()}
        fallback={
          <>
            <div class="msg-feedback-actions">
              <button
                type="button"
                class="msg-feedback-btn"
                disabled={props.disabled || submitting()}
                title="有帮助"
                onClick={() => void submit("up")}
              >
                👍
              </button>
              <button
                type="button"
                class="msg-feedback-btn"
                disabled={props.disabled || submitting()}
                title="需改进"
                onClick={() => {
                  setExpanded(true);
                }}
              >
                👎
              </button>
              <button
                type="button"
                class="msg-feedback-link"
                disabled={props.disabled}
                onClick={() => setExpanded((v) => !v)}
              >
                补充说明
              </button>
            </div>
            <Show when={expanded()}>
              <div class="msg-feedback-form">
                <textarea
                  class="msg-feedback-input"
                  placeholder="可选：一句话说明哪里好/哪里需改"
                  rows={2}
                  value={comment()}
                  onInput={(e) => setComment(e.currentTarget.value)}
                />
                <div class="msg-feedback-chips">
                  <For each={[...DIMENSIONS]}>
                    {(d) => (
                      <button
                        type="button"
                        class={`msg-feedback-chip${dims().includes(d) ? " on" : ""}`}
                        onClick={() => toggleDim(d)}
                      >
                        {d}
                      </button>
                    )}
                  </For>
                </div>
                <div class="msg-feedback-form-actions">
                  <button
                    type="button"
                    class="msg-feedback-submit down"
                    disabled={submitting()}
                    onClick={() => void submit("down")}
                  >
                    提交改进意见
                  </button>
                  <button
                    type="button"
                    class="msg-feedback-submit up"
                    disabled={submitting()}
                    onClick={() => void submit("up")}
                  >
                    提交好评
                  </button>
                </div>
              </div>
            </Show>
          </>
        }
      >
        {(fb) => (
          <div class="msg-feedback-done" title={fb().comment}>
            {fb().rating === "up" ? "已标记：有帮助" : "已标记：需改进"}
            {fb().dimensions?.length ? ` · ${(fb().dimensions ?? []).join("、")}` : ""}
          </div>
        )}
      </Show>
    </div>
  );
}
