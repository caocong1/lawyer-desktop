export type AgentMode = "chat" | "draft" | "evidence";

/** Intent transition relative to the committed task. Drives the switch-confirm gate. */
export type AgentModeAction = "continue" | "switch" | "aside";

export interface ClassifyAgentModeResult {
  mode: AgentMode;
  label: string;
  reason: string;
  action?: AgentModeAction;
  source?: "llm" | "fallback" | "override";
  fallback_reason?: string;
  diagnostic?: string;
}

export function agentModeLabel(mode: AgentMode | "idle"): string {
  switch (mode) {
    case "draft":
      return "文书起草";
    case "evidence":
      return "案情分析";
    case "chat":
      return "法律问答";
    default:
      return "墨律";
  }
}

export function agentModeStatus(mode: AgentMode | "idle"): string {
  switch (mode) {
    case "draft":
      return "起草中";
    case "evidence":
      return "分析中";
    case "chat":
      return "解答中";
    default:
      return "已就绪";
  }
}
