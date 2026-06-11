import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../icons/Icons";
import type {
  ClarificationAnswer,
  ClarificationQuestion,
  WorkflowState,
  WorkflowStep,
} from "../../types/workflow";
import "./DraftingProgressSteps.css";

export interface WorkflowProgressStepsProps {
  workflow: () => WorkflowState | undefined;
  disabled?: () => boolean;
  onClarificationSubmit?: (messageId: string, answers: ClarificationAnswer[]) => void;
  onSuggestionClick?: (prompt: string) => void;
}

function stepMeta(step: WorkflowStep): string {
  if (step.state === "run") return "进行中";
  if (step.state === "done") return "完成";
  if (step.state === "error") return "异常";
  return "";
}

function questionAnswerKey(messageId: string, question: ClarificationQuestion): string {
  return `${messageId}:${question.id}`;
}

export function WorkflowProgressSteps(props: WorkflowProgressStepsProps) {
  const [selected, setSelected] = createSignal<Record<string, string>>({});
  const [freeText, setFreeText] = createSignal<Record<string, string>>({});

  const workflow = () => props.workflow();
  const clarification = () => workflow()?.clarification;
  const pending = () => clarification()?.status === "pending";
  const title = () => {
    const wf = workflow();
    if (wf?.mode_label) return wf.mode_label;
    if (wf?.mode === "evidence") return "案卷分析";
    if (wf?.mode === "draft") return "法律文书起草";
    return "任务编排";
  };

  const canSubmit = createMemo(() => {
    const wf = workflow();
    const c = clarification();
    if (!wf || !c || !pending()) return false;
    return c.questions.every((q) => {
      const key = questionAnswerKey(wf.message_id, q);
      return (selected()[key] ?? freeText()[key] ?? "").trim().length > 0;
    });
  });

  function answerForQuestion(wf: WorkflowState, q: ClarificationQuestion): string {
    const key = questionAnswerKey(wf.message_id, q);
    return (freeText()[key] || selected()[key] || "").trim();
  }

  function submitAnswers() {
    const wf = workflow();
    const c = clarification();
    if (!wf || !c || !canSubmit() || props.disabled?.()) return;
    const answers = c.questions.map((q) => ({
      question_id: q.id,
      question: q.question,
      answer: answerForQuestion(wf, q),
    }));
    props.onClarificationSubmit?.(wf.message_id, answers);
  }

  return (
    <div class="draft-steps workflow-steps">
      <div class="draft-steps-h">
        <Icon name="sparkle" style={{ width: "14px", height: "14px", color: "var(--accent)" }} />
        <span>{title()}</span>
      </div>
      <For each={workflow()?.steps ?? []}>
        {(step) => (
          <div class={`draft-step ${step.state}`}>
            <div class="draft-step-mk">
              {step.state === "done" ? (
                <Icon name="check" />
              ) : step.state === "run" ? (
                <span class="draft-step-sp" />
              ) : null}
            </div>
            <span class="draft-step-tx">
              {step.label}
              <Show when={step.detail}>
                <small>{step.detail}</small>
              </Show>
            </span>
            <span class="draft-step-meta">{stepMeta(step)}</span>
          </div>
        )}
      </For>

      <Show when={clarification()}>
        {(c) => (
          <div class={`clarify-card ${c().status}`}>
            <Show when={c().intro}>
              <p class="clarify-intro">{c().intro}</p>
            </Show>
            <For each={c().questions}>
              {(q, index) => {
                const wf = () => workflow();
                const key = () => (wf() ? questionAnswerKey((wf() as WorkflowState).message_id, q) : q.id);
                const answered = () =>
                  c().answers?.find((answer) => answer.question_id === q.id)?.answer;
                return (
                  <div class="clarify-q">
                    <div class="clarify-q-title">
                      {index() + 1}. {q.question}
                    </div>
                    <Show
                      when={c().status === "answered"}
                      fallback={
                        <>
                          <div class="clarify-options">
                            <For each={q.options}>
                              {(opt) => (
                                <button
                                  type="button"
                                  class={`clarify-option${selected()[key()] === (opt.value ?? opt.label) ? " on" : ""}`}
                                  disabled={props.disabled?.()}
                                  title={opt.description}
                                  onClick={() =>
                                    setSelected((prev) => ({
                                      ...prev,
                                      [key()]: opt.value ?? opt.label,
                                    }))
                                  }
                                >
                                  <span>{opt.label}</span>
                                  <Show when={opt.description}>
                                    <small>{opt.description}</small>
                                  </Show>
                                </button>
                              )}
                            </For>
                          </div>
                          <Show when={q.allow_free_text !== false}>
                            <input
                              class="clarify-free"
                              value={freeText()[key()] ?? ""}
                              disabled={props.disabled?.()}
                              placeholder="也可以直接输入补充信息"
                              onInput={(e) =>
                                setFreeText((prev) => ({
                                  ...prev,
                                  [key()]: e.currentTarget.value,
                                }))
                              }
                            />
                          </Show>
                        </>
                      }
                    >
                      <div class="clarify-answer">已回答：{answered()}</div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={pending()}>
              <button
                type="button"
                class="clarify-submit"
                disabled={!canSubmit() || props.disabled?.()}
                onClick={submitAnswers}
              >
                提交补充信息
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={(workflow()?.suggestions ?? []).length > 0}>
        <div class="workflow-suggestions">
          <For each={workflow()?.suggestions ?? []}>
            {(prompt) => (
              <button
                type="button"
                onClick={() => props.onSuggestionClick?.(prompt)}
                disabled={props.disabled?.()}
              >
                {prompt}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
