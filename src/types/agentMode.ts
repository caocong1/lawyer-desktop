export type AgentMode = "chat" | "draft" | "evidence";

export interface ClassifyAgentModeResult {
  mode: AgentMode;
  label: string;
  reason: string;
  source?: "llm" | "fallback";
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
      return "法律咨询";
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
      return "咨询中";
    default:
      return "已就绪";
  }
}
