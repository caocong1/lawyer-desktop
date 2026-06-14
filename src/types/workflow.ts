export type WorkflowStepState = "done" | "run" | "wait" | "error";

export type WorkflowStepKind =
  | "intent"
  | "skill"
  | "thinking"
  | "tool"
  | "draft"
  | "clarify"
  | "complete"
  | "error";

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  label: string;
  state: WorkflowStepState;
  detail?: string;
  seq?: number;
  ts_ms?: number;
}

export interface ClarificationOption {
  id: string;
  label: string;
  value?: string;
  description?: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
  allow_free_text?: boolean;
}

export interface ClarificationAnswer {
  question_id: string;
  question: string;
  answer: string;
  display_answer?: string;
}

export interface ClarificationRequest {
  id: string;
  intro?: string;
  questions: ClarificationQuestion[];
  status: "pending" | "answered";
  answers?: ClarificationAnswer[];
}

export interface WorkflowState {
  message_id: string;
  conversation_id: string;
  mode?: string;
  mode_label?: string;
  status: "running" | "waiting" | "complete" | "error";
  steps: WorkflowStep[];
  clarification?: ClarificationRequest;
  suggestions?: string[];
}

export interface MessageMetadata {
  display_content?: string;
  content_hidden?: boolean;
  workflow?: WorkflowState;
  /** Backend citation audit (citations::CitationAudit) — must survive every
   *  frontend metadata write or the backend's copy gets clobbered. */
  citation_audit?: import("./legal").CitationAudit;
  active_skill?: { name: string; plugin_name: string };
  feedback?: {
    rating: "up" | "down";
    comment?: string;
    dimensions?: string[];
    at: string;
  };
}
