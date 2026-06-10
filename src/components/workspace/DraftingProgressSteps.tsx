import { For } from "solid-js";
import { Icon } from "../icons/Icons";
import "./DraftingProgressSteps.css";

/** Display steps aligned with research-gate + contract-drafting workflow in Inkstatute UI. */
export const DRAFTING_STEPS = [
  { id: "law", label: "查询法律法规" },
  { id: "intake", label: "解析交易背景及要求" },
  { id: "research", label: "检索相似案例与文书" },
  { id: "draft", label: "拟定文书正文" },
  { id: "review", label: "审查合规风险" },
] as const;

/** Maps backend stream phases to the active step index (0-based). */
function phaseToActiveIndex(phase: string | null): number {
  if (!phase) return 0;
  switch (phase) {
    case "thinking":
      return 1;
    case "tool":
      return 2;
    case "streaming":
      return 3;
    case "review":
      return 4;
    default:
      return 0;
  }
}

function stepState(
  stepIndex: number,
  currentPhase: string | null,
): "done" | "run" | "wait" {
  const active = phaseToActiveIndex(currentPhase);
  if (stepIndex < active) return "done";
  if (stepIndex === active) return "run";
  return "wait";
}

export interface DraftingProgressStepsProps {
  phase: () => string | null;
  skillTitle?: string;
}

export function DraftingProgressSteps(props: DraftingProgressStepsProps) {
  const title = () => props.skillTitle ?? "草拟 · 法律文书起草";

  return (
    <div class="draft-steps">
      <div class="draft-steps-h">
        <Icon name="sparkle" style={{ width: "14px", height: "14px", color: "var(--accent)" }} />
        <span>{title()}</span>
      </div>
      <For each={DRAFTING_STEPS}>
        {(step, index) => {
          const state = () => stepState(index(), props.phase());
          return (
            <div class={`draft-step ${state()}`}>
              <div class="draft-step-mk">
                {state() === "done" ? (
                  <Icon name="check" />
                ) : state() === "run" ? (
                  <span class="draft-step-sp" />
                ) : null}
              </div>
              <span class="draft-step-tx">{step.label}</span>
              <span class="draft-step-meta">
                {state() === "run" ? "进行中" : state() === "done" ? "完成" : ""}
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
