import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../icons/Icons";
import type {
  ClarificationAnswer,
  ClarificationOption,
  ClarificationQuestion,
  WorkflowState,
  WorkflowStep,
} from "../../types/workflow";
import "./DraftingProgressSteps.css";

export interface WorkflowNoticeProps {
  workflow: () => WorkflowState | undefined;
  timeTitle?: string;
}

export interface ClarificationCardProps {
  workflow: () => WorkflowState | undefined;
  disabled?: () => boolean;
  onClarificationSubmit?: (messageId: string, answers: ClarificationAnswer[]) => void;
}

export interface WorkflowSuggestionsProps {
  workflow: () => WorkflowState | undefined;
  disabled?: () => boolean;
  onSuggestionClick?: (prompt: string) => void;
}

function stepMeta(step: WorkflowStep): string {
  if (step.state === "run") return "进行中";
  if (step.state === "done") return "完成";
  if (step.state === "error") return "异常";
  return "";
}

function workflowTitle(wf: WorkflowState | undefined): string {
  if (wf?.mode_label) return wf.mode_label;
  if (wf?.mode === "evidence") return "案情分析";
  if (wf?.mode === "draft") return "文书起草";
  if (wf?.mode === "chat") return "法律问答";
  return "处理进度";
}

function workflowSummary(wf: WorkflowState | undefined): string {
  if (!wf) return "正在处理";
  const running = [...wf.steps].reverse().find((step) => step.state === "run");
  if (wf.status === "waiting") return running?.label || "等待你补充后继续";
  if (wf.status === "error") return "处理时遇到问题";
  if (wf.status === "complete") return "处理完成";
  return running?.label || "正在处理";
}

function questionAnswerKey(messageId: string, question: ClarificationQuestion): string {
  return `${messageId}:${question.id}`;
}

type ClarificationSelection = { value: string; label: string };

function optionDisplayForAnswer(
  question: ClarificationQuestion,
  answer: string | undefined,
): string | undefined {
  if (!answer) return undefined;
  const parts = answer.includes("|") ? answer.split("|") : [answer];
  const labels = parts
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return undefined;
      const option = question.options.find(
        (opt) => opt.value === trimmed || opt.label === trimmed || opt.id === trimmed,
      );
      return option?.label ?? trimmed;
    })
    .filter((label): label is string => !!label);
  return labels.length > 0 ? labels.join("、") : answer;
}

function isOptionSelected(
  selections: ClarificationSelection[],
  value: string,
): boolean {
  return selections.some((item) => item.value === value);
}

function toggleSelection(
  prev: ClarificationSelection[],
  entry: ClarificationSelection,
  allowMultiple: boolean,
): ClarificationSelection[] {
  if (!allowMultiple) return [entry];
  if (isOptionSelected(prev, entry.value)) {
    return prev.filter((item) => item.value !== entry.value);
  }
  return [...prev, entry];
}

export function WorkflowNotice(props: WorkflowNoticeProps) {
  const [expanded, setExpanded] = createSignal(false);
  const workflow = () => props.workflow();
  const collapsedByDefault = () => {
    const status = workflow()?.status;
    return status === "complete" || status === "error";
  };
  const showSteps = () => !collapsedByDefault() || expanded();

  return (
    <div class={`workflow-notice ${workflow()?.status ?? "running"}`} title={props.timeTitle}>
      <div class="workflow-notice-main">
        <span class="workflow-notice-dot" />
        <span class="workflow-notice-title">{workflowTitle(workflow())}</span>
        <span class="workflow-notice-summary">{workflowSummary(workflow())}</span>
        <Show when={collapsedByDefault()}>
          <button
            type="button"
            class="workflow-notice-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded() ? "收起" : "详情"}
          </button>
        </Show>
      </div>

      <Show when={showSteps()}>
        <div class="workflow-notice-steps">
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
                <span class="draft-step-tx">{step.label}</span>
                <span class="draft-step-meta">{stepMeta(step)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function ClarificationCard(props: ClarificationCardProps) {
  const [selected, setSelected] = createSignal<Record<string, ClarificationSelection[]>>({});
  const [freeText, setFreeText] = createSignal<Record<string, string>>({});

  const workflow = () => props.workflow();
  const clarification = () => workflow()?.clarification;
  const pending = () => clarification()?.status === "pending";

  const canSubmit = createMemo(() => {
    const wf = workflow();
    const c = clarification();
    if (!wf || !c || !pending()) return false;
    return c.questions.every((q) => {
      const key = questionAnswerKey(wf.message_id, q);
      const hasSelection = (selected()[key] ?? []).length > 0;
      return hasSelection || (freeText()[key] || "").trim().length > 0;
    });
  });

  function answerForQuestion(
    wf: WorkflowState,
    question: ClarificationQuestion,
  ): ClarificationAnswer {
    const key = questionAnswerKey(wf.message_id, question);
    const free = (freeText()[key] ?? "").trim();
    if (free) {
      return {
        question_id: question.id,
        question: question.question,
        answer: free,
        display_answer: free,
      };
    }
    const chosen = selected()[key] ?? [];
    const values = chosen.map((item) => item.value).join("|");
    const labels = chosen.map((item) => item.label).join("、");
    return {
      question_id: question.id,
      question: question.question,
      answer: values,
      display_answer: labels,
    };
  }

  function submitAnswers() {
    const wf = workflow();
    const c = clarification();
    if (!wf || !c || !canSubmit() || props.disabled?.()) return;
    props.onClarificationSubmit?.(
      wf.message_id,
      c.questions.map((q) => answerForQuestion(wf, q)),
    );
  }

  return (
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
              const answered = () => c().answers?.find((answer) => answer.question_id === q.id);
              const answeredDisplay = () =>
                answered()?.display_answer ??
                optionDisplayForAnswer(q, answered()?.answer) ??
                answered()?.answer;
              return (
                <div class="clarify-q">
                  <div class="clarify-q-title">
                    {index() + 1}. {q.question}
                    <Show when={q.allow_multiple}>
                      <span class="clarify-q-hint">（可多选）</span>
                    </Show>
                  </div>
                  <Show
                    when={c().status === "answered"}
                    fallback={
                      <>
                        <div class={`clarify-options${q.allow_multiple ? " multi" : ""}`}>
                          <For each={q.options}>
                            {(opt: ClarificationOption) => {
                              const value = () => opt.value ?? opt.label;
                              const on = () =>
                                isOptionSelected(selected()[key()] ?? [], value());
                              return (
                                <button
                                  type="button"
                                  class={`clarify-option${on() ? " on" : ""}`}
                                  disabled={props.disabled?.()}
                                  title={opt.description}
                                  onClick={() =>
                                    setSelected((prev) => ({
                                      ...prev,
                                      [key()]: toggleSelection(
                                        prev[key()] ?? [],
                                        { value: value(), label: opt.label },
                                        q.allow_multiple === true,
                                      ),
                                    }))
                                  }
                                >
                                  <span>{opt.label}</span>
                                  <Show when={opt.description}>
                                    <small>{opt.description}</small>
                                  </Show>
                                </button>
                              );
                            }}
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
                    <div class="clarify-answer">已选：{answeredDisplay()}</div>
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
  );
}

export interface ModeSwitchCardProps {
  curLabel: string;
  newLabel: string;
  disabled?: () => boolean;
  onSwitch: () => void;
  onContinue: () => void;
  onCustom: () => void;
}

/** Pre-turn confirmation shown when a message would switch away from the
 *  committed producing task. Reuses the clarification card styling. */
export function ModeSwitchCard(props: ModeSwitchCardProps) {
  return (
    <div class="clarify-card pending mode-switch-card">
      <p class="clarify-intro">
        检测到你可能想从「{props.curLabel}」切换为「{props.newLabel}」。要怎么做？
      </p>
      <div class="clarify-options">
        <button
          type="button"
          class="clarify-option"
          disabled={props.disabled?.()}
          onClick={() => props.onSwitch()}
        >
          <span>切换到「{props.newLabel}」</span>
          <small>当前「{props.curLabel}」草稿将归档保留在对话中</small>
        </button>
        <button
          type="button"
          class="clarify-option"
          disabled={props.disabled?.()}
          onClick={() => props.onContinue()}
        >
          <span>继续完善「{props.curLabel}」</span>
          <small>把这条当作对当前文书的修改</small>
        </button>
        <button
          type="button"
          class="clarify-option"
          disabled={props.disabled?.()}
          onClick={() => props.onCustom()}
        >
          <span>都不是，我再说明…</span>
          <small>把这条消息放回输入框重新编辑</small>
        </button>
      </div>
    </div>
  );
}

export function WorkflowSuggestions(props: WorkflowSuggestionsProps) {
  return (
    <Show when={(props.workflow()?.suggestions ?? []).length > 0}>
      <div class="workflow-suggestions">
        <For each={props.workflow()?.suggestions ?? []}>
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
  );
}
