import type { AgentMode } from "../types/agentMode";

export const CHAT_WIDTH_DEFAULT = 500;
export const CHAT_WIDTH_MIN = 360;
export const PREVIEW_WIDTH_MIN = 480;

const STORAGE_KEY = "molv.chatWidth";

export function clampChatWidth(desired: number, containerWidth: number): number {
  const max = Math.max(CHAT_WIDTH_MIN, containerWidth - PREVIEW_WIDTH_MIN);
  return Math.min(Math.max(desired, CHAT_WIDTH_MIN), max);
}

export function loadChatWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return CHAT_WIDTH_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : CHAT_WIDTH_DEFAULT;
  } catch {
    return CHAT_WIDTH_DEFAULT;
  }
}

export function saveChatWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* localStorage unavailable */
  }
}

export interface PreviewVisibilityInputs {
  committedMode: AgentMode | null;
  workspaceMode: AgentMode | "idle";
  hasLegalDocument: boolean;
  hasMarkdownDoc: boolean;
  draftWorkflowActive: boolean;
  activeEvidenceResponse: boolean;
}

export function shouldShowPreview(s: PreviewVisibilityInputs): boolean {
  return (
    s.committedMode === "draft" ||
    s.committedMode === "evidence" ||
    s.workspaceMode === "draft" ||
    s.workspaceMode === "evidence" ||
    s.hasLegalDocument ||
    s.hasMarkdownDoc ||
    s.draftWorkflowActive ||
    s.activeEvidenceResponse
  );
}
