import { createSignal } from "solid-js";
import type { AgentMode } from "../types/agentMode";
import type { ContextRefPayload } from "../types/contextRefs";
import type {
  Article,
  CitationAudit,
  CitationGroups,
  DocMeta,
  LegalDocumentModel,
} from "../types/legal";
import {
  auditSummaryLine,
  auditToCitationGroups,
  mergeAuditIntoGroups,
} from "../utils/citationAudit";
import {
  extractLegalDocumentJson,
  extractDraftOutputEnvelope,
  isPublishableDocument,
  markdownToLegalDocument,
  modelToArticles,
  modelToCitationGroups,
  modelToDocMeta,
  containsToolLeakage,
  sanitizeLlmDocumentContent,
  stripReportPreamble,
} from "../utils/legalDocument";
import { fallbackFollowupSuggestions } from "../utils/followupSuggestions";
import { mergeDirectoryRefs } from "../utils/evidenceFlow";
import { resolveInlineMentions } from "../utils/mentions";
import {
  getConversations,
  getMessages,
  deleteConversation as deleteConversationApi,
  setActiveConversation,
  sendMessage,
  parseLegalDocument,
  bindWorkspace,
  classifyAgentMode,
  updateMessageMetadata,
  generateFollowupPrompts,
} from "../services/api";
import type { AgentTraceEvent } from "../types/trace";
import type {
  ClarificationAnswer,
  ClarificationOption,
  ClarificationQuestion,
  ClarificationRequest,
  MessageMetadata,
  WorkflowState,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowStepState,
} from "../types/workflow";

export interface FileAttachment {
  path: string;
  name: string;
  file_type: string;
  size: number;
  content_preview?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  attachments?: FileAttachment[];
  tool_calls?: unknown[];
  attachments_json?: string | null;
  tool_calls_json?: string | null;
  metadata_json?: string | null;
  metadata?: MessageMetadata;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export type DocMode = "preview" | "edit";

export interface CiteState {
  open: boolean;
  tab: "law" | "case";
  key: string | null;
}

const emptyDocMeta = (): DocMeta => ({
  title: "",
  en: "",
  parties: [],
  recital: [],
});

const emptyCitations = (): CitationGroups => ({ law: [], case: [] });

const [conversations, setConversations] = createSignal<Conversation[]>([]);
const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<Message[]>([]);
const [isStreaming, setIsStreaming] = createSignal(false);
const [streamingContent, setStreamingContent] = createSignal("");
const [streamPhase, setStreamPhase] = createSignal<string | null>(null);
const [activeDraftResponse, setActiveDraftResponse] = createSignal(false);
/** True when the current reply is evidence-driven (workspace / 诉讼方案). */
const [activeEvidenceResponse, setActiveEvidenceResponse] = createSignal(false);
/** True from first doc-draft send until preview has a parsed document or the stream fails. */
const [draftWorkflowActive, setDraftWorkflowActive] = createSignal(false);
const [workflowByMessageId, setWorkflowByMessageId] = createSignal<Record<string, WorkflowState>>(
  {},
);
/** Backend citation audits keyed by message_id (from the trace channel). */
const [citationAuditByMessageId, setCitationAuditByMessageId] = createSignal<
  Record<string, CitationAudit>
>({});

const STREAM_WATCHDOG_MS = 5 * 60 * 1000;
let streamWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearStreamWatchdog() {
  if (streamWatchdog !== null) {
    clearTimeout(streamWatchdog);
    streamWatchdog = null;
  }
}

function parseMessageMetadata(msg: Message): MessageMetadata | undefined {
  if (msg.metadata) return msg.metadata;
  const raw = msg.metadata_json;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as MessageMetadata;
  } catch (e) {
    console.warn("解析消息元数据失败:", e);
    return undefined;
  }
}

function withMessageMetadata(msg: Message): Message {
  return { ...msg, metadata: parseMessageMetadata(msg) };
}

function hydrateWorkflowSnapshots(msgs: Message[]) {
  const snapshots: Record<string, WorkflowState> = {};
  for (const msg of msgs) {
    const workflow = parseMessageMetadata(msg)?.workflow;
    if (workflow) snapshots[msg.id] = workflow;
  }
  setWorkflowByMessageId((prev) => ({ ...prev, ...snapshots }));
}

function emptyWorkflow(e: AgentTraceEvent): WorkflowState {
  return {
    message_id: e.message_id,
    conversation_id: e.conversation_id,
    status: "running",
    steps: [],
  };
}

function closeRunningSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((step) =>
    step.state === "run" ? { ...step, state: "done" as WorkflowStepState } : step,
  );
}

function upsertStep(
  workflow: WorkflowState,
  id: string,
  kind: WorkflowStepKind,
  label: string,
  state: WorkflowStepState,
  seq?: number,
  detail?: string,
  tsMs?: number,
): WorkflowState {
  const idx = workflow.steps.findIndex((step) => step.id === id);
  const base: WorkflowStep = { id, kind, label, state, seq, detail, ts_ms: tsMs };
  if (idx >= 0) {
    const next = workflow.steps.slice();
    next[idx] = { ...next[idx], ...base, ts_ms: tsMs ?? next[idx].ts_ms };
    return { ...workflow, steps: next };
  }

  const steps = state === "run" ? closeRunningSteps(workflow.steps) : workflow.steps.slice();
  return { ...workflow, steps: [...steps, base] };
}

function markStep(
  workflow: WorkflowState,
  id: string,
  state: WorkflowStepState,
): WorkflowState {
  return {
    ...workflow,
    steps: workflow.steps.map((step) =>
      step.id === id ? { ...step, state } : step,
    ),
  };
}

function traceToolLabel(name: string): { label: string; detail?: string } {
  if (name.startsWith("mcp__")) {
    if (/law|legal|fagui|statute|wenshu|case|judgment/i.test(name)) {
      return { label: "检索法律法规与类案" };
    }
    return { label: "查询外部数据源" };
  }
  if (name === "legal_search") return { label: "聚合检索法律依据" };
  if (name === "search_law") return { label: "检索本地法规库" };
  if (name === "get_law_article") return { label: "核对法条原文" };
  if (name === "search_workspace") return { label: "查找相关材料" };
  if (name === "read_chunk") return { label: "查看相关材料" };
  if (name === "read_file" || name === "read_user_file") return { label: "查看文件内容" };
  if (name === "list_files") return { label: "梳理材料清单" };
  if (name === "get_index_status") return { label: "确认材料索引" };
  if (name === "generate_docx") return { label: "生成文书文件" };
  if (name === "ask_user") return { label: "发现还需要补充信息" };
  return { label: "处理辅助任务" };
}

function normalizeClarification(payload: Record<string, unknown>): ClarificationRequest | undefined {
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  const questions: ClarificationQuestion[] = rawQuestions
    .map((raw, index): ClarificationQuestion | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const q = raw as Record<string, unknown>;
      const question = typeof q.question === "string" ? q.question.trim() : "";
      if (!question) return undefined;
      const rawOptions = Array.isArray(q.options) ? q.options : [];
      const options: ClarificationOption[] = rawOptions
        .map((opt, optIndex): ClarificationOption | undefined => {
          if (typeof opt === "string") {
            return { id: `q${index + 1}-o${optIndex + 1}`, label: opt, value: opt };
          }
          if (!opt || typeof opt !== "object") return undefined;
          const o = opt as Record<string, unknown>;
          const label =
            typeof o.label === "string"
              ? o.label.trim()
              : typeof o.value === "string"
                ? o.value.trim()
                : "";
          if (!label) return undefined;
          return {
            id: typeof o.id === "string" ? o.id : `q${index + 1}-o${optIndex + 1}`,
            label,
            value: typeof o.value === "string" ? o.value : label,
            description: typeof o.description === "string" ? o.description : undefined,
          };
        })
        .filter((opt): opt is ClarificationOption => !!opt);
      return {
        id: typeof q.id === "string" ? q.id : `q${index + 1}`,
        question,
        options,
        allow_free_text: q.allow_free_text !== false,
      };
    })
    .filter((q): q is ClarificationQuestion => !!q)
    .slice(0, 4);

  if (questions.length === 0) return undefined;
  return {
    id:
      typeof payload.id === "string"
        ? payload.id
        : `clarify-${Date.now().toString(36)}`,
    intro: typeof payload.intro === "string" ? payload.intro : undefined,
    questions,
    status: "pending",
  };
}

function applyTraceToWorkflow(workflow: WorkflowState, e: AgentTraceEvent): WorkflowState {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "turn_start":
      return workflow;
    case "classify_start":
      return upsertStep(workflow, "intent", "intent", "判断事项类型", "run", e.seq, undefined, e.ts_ms);
    case "classify_result": {
      const label =
        p.source === "fallback"
          ? "已用本地规则判断事项类型"
          : p.label
            ? `已确认事项类型：${p.label}`
            : "已确认事项类型";
      return upsertStep(
        {
          ...workflow,
          mode: typeof p.mode === "string" ? p.mode : workflow.mode,
          mode_label: typeof p.label === "string" ? p.label : workflow.mode_label,
        },
        "intent",
        "intent",
        label,
        "done",
        e.seq,
        undefined,
        e.ts_ms,
      );
    }
    case "skill_activated": {
      const name = typeof p.name === "string" ? p.name : "法律技能";
      return upsertStep(
        workflow,
        `skill-${name}`,
        "skill",
        "选用合适的法律能力",
        "done",
        e.seq,
        undefined,
        e.ts_ms,
      );
    }
    case "thinking":
    case "thinking_delta":
      return upsertStep(workflow, "thinking", "thinking", "梳理问题和处理思路", "run", e.seq, undefined, e.ts_ms);
    case "tool_call": {
      const name = typeof p.name === "string" ? p.name : "tool";
      if (name === "select_skill") return workflow;
      const label = traceToolLabel(name);
      return upsertStep(
        workflow,
        `tool-${name}`,
        name === "ask_user" ? "clarify" : "tool",
        label.label,
        "run",
        e.seq,
        label.detail,
        e.ts_ms,
      );
    }
    case "tool_result": {
      const name = typeof p.name === "string" ? p.name : "tool";
      return markStep(workflow, `tool-${name}`, p.ok === false ? "error" : "done");
    }
    case "ask_user": {
      const clarification = normalizeClarification(p);
      let next = upsertStep(
        workflow,
        "clarify",
        "clarify",
        "已列出待补充问题",
        "done",
        e.seq,
        undefined,
        e.ts_ms,
      );
      next = upsertStep(
        next,
        "wait-user",
        "clarify",
        "等待补充信息",
        "run",
        e.seq,
        undefined,
        e.ts_ms,
      );
      return {
        ...next,
        status: "waiting",
        clarification: clarification ?? next.clarification,
      };
    }
    case "final_answer":
    case "stream_delta": {
      const mode = workflow.mode;
      const label =
        mode === "evidence" ? "撰写分析报告" : mode === "draft" ? "起草正文" : "生成答复";
      return upsertStep(workflow, "draft", "draft", label, "run", e.seq, undefined, e.ts_ms);
    }
    case "citation_audit":
      return upsertStep(
        workflow,
        "cite-audit",
        "tool",
        "核验引用来源",
        "done",
        e.seq,
        undefined,
        e.ts_ms,
      );
    case "stream_done":
      return markStep(workflow, "draft", "done");
    case "error":
      return {
        ...upsertStep(workflow, "error", "error", "处理时遇到问题", "error", e.seq, undefined, e.ts_ms),
        status: "error",
      };
    case "turn_end": {
      if (workflow.status === "waiting") return workflow;
      if (p.ok === false) {
        return {
          ...upsertStep(workflow, "error", "error", "处理时遇到问题", "error", e.seq, undefined, e.ts_ms),
          status: "error",
        };
      }
      return {
        ...upsertStep(
          { ...workflow, steps: closeRunningSteps(workflow.steps) },
          "complete",
          "complete",
          "处理完成",
          "done",
          e.seq,
          undefined,
          e.ts_ms,
        ),
        status: "complete",
      };
    }
    default:
      return workflow;
  }
}

const [workspacePrompt, setWorkspacePrompt] = createSignal<string>("");
const [workspaceMode, setWorkspaceMode] = createSignal<AgentMode | "idle">("idle");
const [workspaceModeLabel, setWorkspaceModeLabel] = createSignal<string>("");
const [legalDocument, setLegalDocument] = createSignal<LegalDocumentModel | null>(null);
const [documentMarkdown, setDocumentMarkdown] = createSignal("");
const [documentId, setDocumentId] = createSignal<string | null>(null);
const [documentVersion, setDocumentVersion] = createSignal(0);
const [docMeta, setDocMeta] = createSignal<DocMeta>(emptyDocMeta());
const [articles, setArticles] = createSignal<Article[]>([]);
const [citationGroups, setCitationGroups] = createSignal<CitationGroups>(emptyCitations());
const [docMode, setDocMode] = createSignal<DocMode>("preview");
const [justAddedId, setJustAddedId] = createSignal<string | null>(null);
const [citeState, setCiteState] = createSignal<CiteState>({ open: false, tab: "law", key: null });
const [pendingContextRefs, setPendingContextRefs] = createSignal<ContextRefPayload[]>([]);
const [inlineMentionPaths, setInlineMentionPaths] = createSignal<string[]>([]);
/** Per-path workspace index progress keyed by root_path. */
const [workspaceIndexByPath, setWorkspaceIndexByPath] = createSignal<
  Record<
    string,
    {
      processed: number;
      total: number;
      currentFile?: string;
      done: boolean;
      status: string;
      fileCount: number;
      chunkCount: number;
    }
  >
>({});

function clearDocumentState() {
  setLegalDocument(null);
  setDocumentMarkdown("");
  setDocumentId(null);
  setDocumentVersion(0);
  setDocMeta(emptyDocMeta());
  setArticles([]);
  setCitationGroups(emptyCitations());
}

type DocumentOrigin = "live" | "restore";

function applyDocumentModel(
  model: LegalDocumentModel,
  markdown: string,
  id: string | null,
  origin: DocumentOrigin = "live",
) {
  setLegalDocument(model);
  setDocumentMarkdown(markdown);
  setDocumentId(id);
  // Restores re-run on every conversation switch — they must not inflate 第N稿.
  setDocumentVersion((v) => (origin === "live" ? v + 1 : 1));
  setDocMeta(modelToDocMeta(model));
  setArticles(modelToArticles(model));
  setCitationGroups(modelToCitationGroups(model));
}

/** Evidence reports are plain markdown — clear stale structured docs so the latest output wins. */
function applyMarkdownReport(markdown: string, origin: DocumentOrigin = "live") {
  setLegalDocument(null);
  setDocumentId(null);
  setDocMeta(emptyDocMeta());
  setArticles([]);
  setCitationGroups(emptyCitations());
  setDocumentMarkdown(markdown);
  // Restores re-run on every conversation switch — they must not inflate 第N稿.
  setDocumentVersion((v) => (origin === "live" ? v + 1 : 1));
}

async function applyParsedDocument(
  jsonContent: string,
  origin: DocumentOrigin = "live",
): Promise<boolean> {
  const convId = activeConversationId();
  try {
    const res = await parseLegalDocument({
      json_content: jsonContent,
      conversation_id: convId ?? undefined,
    });
    applyDocumentModel(res.document, res.markdown, res.document_id, origin);
    return true;
  } catch (e) {
    console.warn("解析法律文书 JSON 失败:", e);
    return false;
  }
}

async function tryApplyDocumentFromContent(
  content: string,
  origin: DocumentOrigin = "live",
): Promise<boolean> {
  const envelope = extractDraftOutputEnvelope(content);
  if (!isPublishableDocument(content)) return false;

  if (envelope.documentJson) {
    return applyParsedDocument(envelope.documentJson, origin);
  }

  const cleaned = sanitizeLlmDocumentContent(envelope.documentMarkdown);
  const json = extractLegalDocumentJson(cleaned);
  if (json) {
    return applyParsedDocument(json, origin);
  }

  const model = markdownToLegalDocument(cleaned, workspacePrompt());
  if (model) {
    applyDocumentModel(model, cleaned, null, origin);
    return true;
  }

  return false;
}

async function restoreDocumentFromMessages() {
  const msgs = [...messages()].reverse();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    const meta = metadataForMessage(m);
    // Clarification placeholder messages also carry content_hidden + mode —
    // their workflow has a clarification; a real report's never does.
    if (
      meta?.content_hidden &&
      meta.workflow?.mode === "evidence" &&
      !meta.workflow?.clarification &&
      m.content.trim()
    ) {
      applyMarkdownReport(
        stripReportPreamble(sanitizeLlmDocumentContent(m.content)),
        "restore",
      );
      if (meta.citation_audit) {
        setCitationGroups(auditToCitationGroups(meta.citation_audit));
      }
      return;
    }
    if (meta?.workflow?.clarification) continue;
    if (await tryApplyDocumentFromContent(m.content, "restore")) {
      if (meta?.citation_audit) {
        setCitationGroups(mergeAuditIntoGroups(citationGroups(), meta.citation_audit));
      }
      if (
        m.content.length > 120 &&
        !meta?.display_content
      ) {
        const display = draftDisplayContent(
          extractDraftOutputEnvelope(m.content).assistantMarkdown,
          docMeta().title || workspacePrompt() || "法律文书",
        );
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === m.id
              ? {
                  ...msg,
                  metadata: buildMessageMetadata(
                    meta?.workflow,
                    display,
                    true,
                    meta?.citation_audit,
                  ),
                }
              : msg,
          ),
        );
      }
      return;
    }
  }
  clearDocumentState();
}

function draftCompletionSummary(title: string): string {
  return `已生成「${title}」草稿，正文见右侧文书预览。如有修改意见请继续补充。`;
}

function draftDisplayContent(assistantMarkdown: string, title: string): string {
  const summary = draftCompletionSummary(title);
  const notes = assistantMarkdown.trim();
  return notes ? `${notes}\n\n---\n\n${summary}` : summary;
}

function evidenceCompletionSummary(title: string): string {
  return `已生成「${title || "案卷分析报告"}」，正文见右侧文书预览。如需补充证据或调整策略请继续说明。`;
}

function clarificationSummary(): string {
  return "请先补充以下信息，以便继续起草。";
}

function metadataForMessage(msg: Message): MessageMetadata | undefined {
  return msg.metadata ?? parseMessageMetadata(msg);
}

function messageDisplayContent(msg: Message): string {
  const meta = metadataForMessage(msg);
  if (meta?.display_content) return meta.display_content;
  if (meta?.content_hidden) {
    return "已生成草稿，正文见右侧文书预览。如有修改意见请继续补充。";
  }
  return msg.content;
}

function workflowForMessageId(messageId: string): WorkflowState | undefined {
  const live = workflowByMessageId()[messageId];
  if (live) return live;
  const msg = messages().find((m) => m.id === messageId);
  return msg ? metadataForMessage(msg)?.workflow : undefined;
}

function activeWorkflowSnapshot(): WorkflowState | undefined {
  const convId = activeConversationId();
  const workflows = Object.values(workflowByMessageId());
  for (let i = workflows.length - 1; i >= 0; i -= 1) {
    const wf = workflows[i];
    if (convId && wf.conversation_id !== convId) continue;
    if (wf.status === "running" || wf.status === "waiting") return wf;
  }
  return undefined;
}

function isAgentModeValue(mode: unknown): mode is AgentMode {
  return mode === "chat" || mode === "draft" || mode === "evidence";
}

function buildMessageMetadata(
  workflow: WorkflowState | undefined,
  displayContent?: string,
  contentHidden?: boolean,
  citationAudit?: CitationAudit,
): MessageMetadata | undefined {
  if (!workflow && !displayContent && !contentHidden && !citationAudit) return undefined;
  return {
    workflow,
    display_content: displayContent,
    content_hidden: contentHidden,
    citation_audit: citationAudit,
  };
}

/** Repopulate the citation panel from an audit, respecting the current doc kind. */
function applyAuditToDocumentState(audit: CitationAudit) {
  if (audit.total === 0) return;
  if (legalDocument() !== null) {
    setCitationGroups(mergeAuditIntoGroups(citationGroups(), audit));
  } else if (documentMarkdown().trim()) {
    setCitationGroups(auditToCitationGroups(audit));
  }
}

/** Append the verification stats line once. */
function appendAuditLine(text: string, audit: CitationAudit): string {
  const line = auditSummaryLine(audit);
  if (!line || text.includes("引用核验：")) return text;
  return text ? `${text}\n\n${line}` : line;
}

/** The audit trace event may arrive after finishStreaming already persisted
 *  metadata — apply it retroactively to the finalized message. */
function applyLateCitationAudit(messageId: string, audit: CitationAudit) {
  const msg = messages().find((m) => m.id === messageId);
  if (!msg) return; // still streaming — finishStreaming picks it up
  const meta = metadataForMessage(msg);
  if (meta?.citation_audit) return; // already applied
  if (audit.total === 0) return;

  applyAuditToDocumentState(audit);
  const display = appendAuditLine(meta?.display_content ?? messageDisplayContent(msg), audit);
  const metadata: MessageMetadata = {
    ...(meta ?? {}),
    workflow: meta?.workflow ?? workflowForMessageId(messageId),
    display_content: display,
    citation_audit: audit,
  };
  attachMetadataToMessage(messageId, metadata);
  persistMessageMetadata(messageId, metadata);
}

function attachMetadataToMessage(messageId: string, metadata: MessageMetadata) {
  setMessages((prev) =>
    prev.map((msg) => (msg.id === messageId ? { ...msg, metadata } : msg)),
  );
  if (metadata.workflow) {
    setWorkflowByMessageId((prev) => ({
      ...prev,
      [messageId]: metadata.workflow as WorkflowState,
    }));
  }
}

// Writes are serialized per message so a retrying earlier snapshot can never
// land after (and clobber) a newer one, e.g. the suggestions update.
const metadataWriteChain = new Map<string, Promise<void>>();

async function writeMetadataWithRetry(messageId: string, metadata: MessageMetadata) {
  for (let attempt = 0; ; attempt++) {
    try {
      await updateMessageMetadata(messageId, metadata);
      return;
    } catch (e) {
      if (attempt >= 5) {
        console.warn("保存消息进度快照失败:", e);
        return;
      }
      await new Promise((r) => setTimeout(r, 180 * (attempt + 1)));
    }
  }
}

function persistMessageMetadata(messageId: string, metadata: MessageMetadata) {
  const prev = metadataWriteChain.get(messageId) ?? Promise.resolve();
  metadataWriteChain.set(
    messageId,
    prev.then(() => writeMetadataWithRetry(messageId, metadata)),
  );
}

function persistMessageFeedback(
  messageId: string,
  feedback: NonNullable<MessageMetadata["feedback"]>,
) {
  const msg = messages().find((m) => m.id === messageId);
  const meta = msg ? metadataForMessage(msg) ?? {} : {};
  const metadata: MessageMetadata = {
    ...meta,
    workflow: meta.workflow ?? workflowForMessageId(messageId),
    citation_audit: meta.citation_audit,
    feedback,
  };
  attachMetadataToMessage(messageId, metadata);
  persistMessageMetadata(messageId, metadata);
}

function completeWorkflowSnapshot(messageId: string): WorkflowState | undefined {
  const current =
    workflowForMessageId(messageId) ??
    (activeConversationId()
      ? {
          message_id: messageId,
          conversation_id: activeConversationId() as string,
          status: "running" as const,
          steps: [],
        }
      : undefined);
  if (!current) return undefined;
  if (current.status === "waiting") return current;
  const complete = upsertStep(
    { ...current, steps: closeRunningSteps(current.steps) },
    "complete",
    "complete",
    "处理完成",
    "done",
    undefined,
    undefined,
    Date.now(),
  );
  const next: WorkflowState = { ...complete, status: "complete" };
  setWorkflowByMessageId((prev) => ({ ...prev, [messageId]: next }));
  return next;
}

function workflowHasPendingClarification(workflow: WorkflowState | undefined): boolean {
  return workflow?.clarification?.status === "pending";
}

function answerTextFromClarification(answers: ClarificationAnswer[]): string {
  const lines = answers.map(
    (answer, index) =>
      `${index + 1}. ${answer.question}\n回答：${answer.display_answer || answer.answer}`,
  );
  return `以下是补充信息，请基于这些答案继续推进起草：\n\n${lines.join("\n\n")}`;
}

async function attachFollowupSuggestions(messageId: string, summary: string) {
  const workflow = workflowForMessageId(messageId);
  if (!workflow || workflow.status === "waiting") return;
  let clean: string[] = [];
  try {
    const suggestions = await generateFollowupPrompts({
      conversation_id: workflow.conversation_id,
      message_id: messageId,
      mode: workflow.mode,
      user_prompt: workspacePrompt(),
      summary,
    });
    clean = suggestions.map((s) => s.trim()).filter(Boolean).slice(0, 3);
  } catch (e) {
    console.warn("生成推荐追问失败:", e);
  }
  // The suggestion row must always appear — fall back locally when the LLM call fails.
  if (clean.length === 0) clean = fallbackFollowupSuggestions(workflow.mode);
  const nextWorkflow: WorkflowState = { ...workflow, suggestions: clean };
  const msg = messages().find((m) => m.id === messageId);
  // Conversation switched/deleted while the LLM call was in flight — persisting
  // metadata built without the live message would erase its content_hidden flag.
  if (!msg) return;
  const oldMeta = metadataForMessage(msg);
  const metadata = buildMessageMetadata(
    nextWorkflow,
    oldMeta?.display_content ?? summary,
    oldMeta?.content_hidden,
    oldMeta?.citation_audit,
  );
  if (!metadata) return;
  attachMetadataToMessage(messageId, metadata);
  persistMessageMetadata(messageId, metadata);
}

export function useConversation() {
  function addConversation(conv: Conversation) {
    setConversations((prev) => [conv, ...prev]);
  }

  async function loadConversations() {
    try {
      const result = await getConversations();
      setConversations(result);
    } catch (e) {
      console.error("加载会话列表失败:", e);
    }
  }

  async function loadMessages(conversationId: string) {
    try {
      const result = await getMessages(conversationId);
      const hydrated = result.map(withMessageMetadata);
      setMessages(hydrated);
      hydrateWorkflowSnapshots(hydrated);
    } catch (e) {
      console.error("加载消息失败:", e);
    }
  }

  async function removeConversation(id: string): Promise<string | null> {
    const wasActive = activeConversationId() === id;
    const nextActiveId = wasActive
      ? conversations().find((c) => c.id !== id)?.id ?? null
      : activeConversationId();
    try {
      await deleteConversationApi(id);
    } catch (e) {
      console.error("删除会话失败:", e);
      throw e;
    }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (wasActive) {
      if (nextActiveId) {
        await switchConversation(nextActiveId);
        return nextActiveId;
      }
      setActiveConversationId(null);
      setMessages([]);
      setWorkflowByMessageId({});
      setPendingContextRefs([]);
      clearInlineMentions();
      clearStreamWatchdog();
      setStreamingContent("");
      setStreamPhase(null);
      setIsStreaming(false);
      setDraftWorkflowActive(false);
      clearDocumentState();
    }
    return nextActiveId;
  }

  async function switchConversation(id: string) {
    setActiveConversationId(id);
    setPendingContextRefs([]);
    clearInlineMentions();
    clearStreamWatchdog();
    setStreamingContent("");
    setStreamPhase(null);
    setIsStreaming(false);
    setDraftWorkflowActive(false);
    await loadMessages(id);
    await restoreDocumentFromMessages();
    try {
      await setActiveConversation(id);
    } catch (e) {
      console.error("保存活动会话失败:", e);
    }
  }

  function selectConversation(id: string) {
    setActiveConversationId(id);
    setMessages([]);
    setWorkflowByMessageId({});
    setPendingContextRefs([]);
    clearInlineMentions();
    clearStreamWatchdog();
    setStreamingContent("");
    setStreamPhase(null);
    setIsStreaming(false);
    setDraftWorkflowActive(false);
    clearDocumentState();
  }

  function addMessage(msg: Message) {
    setMessages((prev) => [...prev, msg]);
  }

  function startStreaming() {
    setIsStreaming(true);
    setStreamingContent("");
    setStreamPhase("thinking");
    clearStreamWatchdog();
    streamWatchdog = setTimeout(() => {
      if (!isStreaming()) return;
      console.warn("流式回复超时，自动结束");
      setIsStreaming(false);
      setStreamingContent("");
      setStreamPhase(null);
      setDraftWorkflowActive(false);
      addMessage({
        id: `timeout-${Date.now()}`,
        conversation_id: activeConversationId() || "",
        role: "assistant",
        content: "**请求超时：** 模型或工具调用超过 5 分钟未响应，请检查网络与 API 配置后重试。",
        created_at: new Date().toISOString(),
      });
    }, STREAM_WATCHDOG_MS);
  }

  function appendStreamChunk(chunk: string) {
    setStreamingContent((prev) => prev + chunk);
  }

  async function finishStreaming(messageId: string) {
    if (!isStreaming()) return;
    clearStreamWatchdog();
    const content = streamingContent();
    const isDocDraft = activeDraftResponse();
    const isEvidence = activeEvidenceResponse();
    const workflow = completeWorkflowSnapshot(messageId);
    const pendingClarification = workflowHasPendingClarification(workflow);

    if (pendingClarification) {
      const display = clarificationSummary();
      const metadata = buildMessageMetadata(workflow, display, true);
      addMessage({
        id: messageId,
        conversation_id: activeConversationId() || "",
        role: "assistant",
        content: display,
        metadata,
        created_at: new Date().toISOString(),
      });
      if (metadata) persistMessageMetadata(messageId, metadata);
    } else if (content) {
      let displayContent = content;
      let contentHidden = false;
      let shouldSuggest = true;

      if (isDocDraft) {
        setStreamPhase("review");
        const envelope = extractDraftOutputEnvelope(content);
        const parsed = await tryApplyDocumentFromContent(content);
        if (parsed) {
          displayContent = draftDisplayContent(
            envelope.assistantMarkdown,
            docMeta().title || "法律文书",
          );
          contentHidden = true;
        } else {
          // Keep any previously rendered document — the failed turn produced nothing usable.
          setDraftWorkflowActive(false);
          displayContent =
            "**起草未完成：** 模型返回了工具调用残留或非法务正文，右侧预览已跳过。请重试发送，或检查模型是否支持工具调用。";
          shouldSuggest = false;
        }
      } else if (isEvidence) {
        const cleaned = sanitizeLlmDocumentContent(content);
        if (!cleaned || containsToolLeakage(cleaned)) {
          displayContent =
            "**分析未完成：** 模型返回了工具调用残留，未能生成可读报告。请重试，或检查模型是否支持标准工具调用。";
          // Keep any previously rendered report — the failed turn wrote nothing
          // to the store, and restore would re-apply the old one anyway.
          shouldSuggest = false;
        } else {
          applyMarkdownReport(stripReportPreamble(cleaned));
          displayContent = evidenceCompletionSummary(workspaceModeLabel() || "案卷分析报告");
          contentHidden = true;
        }
      } else {
        const envelope = extractDraftOutputEnvelope(content);
        const parsed = await tryApplyDocumentFromContent(content);
        if (parsed) {
          displayContent = envelope.assistantMarkdown
            ? draftDisplayContent(envelope.assistantMarkdown, docMeta().title || "法律文书")
            : draftCompletionSummary(docMeta().title || "法律文书");
          contentHidden = true;
        }
      }

      // Citation audit (if its trace event already arrived): badge the panel
      // and append the verification stats line. Late arrivals are handled by
      // applyLateCitationAudit.
      const audit = citationAuditByMessageId()[messageId];
      if (audit && audit.total > 0) {
        applyAuditToDocumentState(audit);
        displayContent = appendAuditLine(displayContent, audit);
      }

      const metadata = buildMessageMetadata(workflow, displayContent, contentHidden, audit);
      addMessage({
        id: messageId,
        conversation_id: activeConversationId() || "",
        role: "assistant",
        content,
        metadata,
        created_at: new Date().toISOString(),
      });
      if (metadata) persistMessageMetadata(messageId, metadata);
      if (shouldSuggest) {
        void attachFollowupSuggestions(messageId, displayContent);
      }
    } else if (isDocDraft) {
      setDraftWorkflowActive(false);
    }

    setActiveDraftResponse(false);
    setActiveEvidenceResponse(false);
    setIsStreaming(false);
    setStreamingContent("");
    setStreamPhase(null);
    if (legalDocument() !== null) {
      setDraftWorkflowActive(false);
    }
  }

  function setStreamStatus(status: string | null) {
    if (status === "tool" || status === "thinking" || status === "clarifying") {
      setStreamingContent("");
    }
    if (status) setStreamPhase(status);
  }

  function addContextRef(ref: ContextRefPayload) {
    setPendingContextRefs((prev) => {
      if (prev.some((r) => r.path === ref.path)) return prev;
      return [...prev, ref];
    });
    if (ref.kind === "directory") {
      const convId = activeConversationId();
      void bindWorkspace(ref.path, convId ?? undefined).catch((e) => {
        console.error("绑定 workspace 失败:", e);
      });
    }
  }

  function removeContextRef(path: string) {
    setPendingContextRefs((prev) => prev.filter((r) => r.path !== path));
    removeInlineMention(path);
  }

  function clearContextRefs() {
    setPendingContextRefs([]);
  }

  function addInlineMention(path: string) {
    setInlineMentionPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }

  function removeInlineMention(path: string) {
    setInlineMentionPaths((prev) => prev.filter((p) => p !== path));
  }

  function clearInlineMentions() {
    setInlineMentionPaths([]);
  }

  function applyWorkspaceIndexProgress(event: {
    root_path: string;
    processed: number;
    total: number;
    current_file?: string | null;
    done: boolean;
    stats?: { file_count: number; chunk_count: number } | null;
  }) {
    setWorkspaceIndexByPath((prev) => ({
      ...prev,
      [event.root_path]: {
        processed: event.processed,
        total: event.total,
        currentFile: event.current_file ?? undefined,
        done: event.done,
        status: event.done ? "ready" : "indexing",
        fileCount: event.stats?.file_count ?? event.processed,
        chunkCount: event.stats?.chunk_count ?? 0,
      },
    }));
  }

  function workspaceIndexForPath(path: string) {
    return workspaceIndexByPath()[path];
  }

  function ingestAgentTrace(event: AgentTraceEvent) {
    if (event.kind === "citation_audit") {
      const audit = event.payload as unknown as CitationAudit;
      if (audit && typeof audit.total === "number") {
        setCitationAuditByMessageId((prev) => ({
          ...prev,
          [event.message_id]: audit,
        }));
        applyLateCitationAudit(event.message_id, audit);
      }
    }
    if (event.kind === "classify_result") {
      const mode = event.payload?.mode;
      if (isAgentModeValue(mode)) {
        setWorkspaceMode(mode);
        setWorkspaceModeLabel(
          typeof event.payload.label === "string" ? event.payload.label : "",
        );
        setActiveDraftResponse(mode === "draft");
        setActiveEvidenceResponse(mode === "evidence");
        if (mode === "draft") {
          setDraftWorkflowActive(true);
        } else if (mode === "evidence") {
          setDraftWorkflowActive(false);
          setStreamPhase("indexing");
        } else {
          setDraftWorkflowActive(false);
        }
      }
    }
    setWorkflowByMessageId((prev) => {
      const current = prev[event.message_id] ?? emptyWorkflow(event);
      return {
        ...prev,
        [event.message_id]: applyTraceToWorkflow(current, event),
      };
    });
  }

  function messageWorkflow(messageId: string) {
    return workflowForMessageId(messageId);
  }

  function activeWorkflow() {
    return activeWorkflowSnapshot();
  }

  function submitClarificationAnswers(messageId: string, answers: ClarificationAnswer[]) {
    const workflow = workflowForMessageId(messageId);
    if (!workflow?.clarification) return Promise.resolve();
    const clarification: ClarificationRequest = {
      ...workflow.clarification,
      status: "answered",
      answers,
    };
    const nextWorkflow: WorkflowState = {
      ...markStep(workflow, "wait-user", "done"),
      status: "complete",
      clarification,
    };
    const msg = messages().find((m) => m.id === messageId);
    const oldMeta = msg ? metadataForMessage(msg) : undefined;
    const metadata = buildMessageMetadata(
      nextWorkflow,
      oldMeta?.display_content ?? clarificationSummary(),
      true,
      oldMeta?.citation_audit,
    );
    if (metadata) {
      attachMetadataToMessage(messageId, metadata);
      persistMessageMetadata(messageId, metadata);
    }
    return sendChatMessage(answerTextFromClarification(answers), { uiHidden: true });
  }

  async function resolveAgentMode(content: string, refs: ContextRefPayload[]) {
    const result = await classifyAgentMode({
      content,
      context_refs: refs.length > 0 ? refs : undefined,
    });
    setWorkspaceMode(result.mode);
    setWorkspaceModeLabel(result.label);
    return result;
  }

  async function initWorkspace(prompt: string, conversationId: string) {
    setWorkspacePrompt(prompt);
    setWorkspaceMode("idle");
    setWorkspaceModeLabel("");
    setDocMode("preview");
    setJustAddedId(null);
    setCiteState({ open: false, tab: "law", key: null });
    clearStreamWatchdog();
    setStreamingContent("");
    setStreamPhase(null);
    setIsStreaming(false);
    setDraftWorkflowActive(false);
    clearDocumentState();
    await loadMessages(conversationId);
    await restoreDocumentFromMessages();
    const trimmed = prompt.trim();
    const refs = mergeDirectoryRefs(trimmed, pendingContextRefs());
    if (trimmed || refs.length > 0) {
      try {
        await resolveAgentMode(trimmed || "分析附加的本地资料", refs);
      } catch (e) {
        console.warn("意图分类失败:", e);
      }
    }
  }

  function sendChatMessage(
    text: string,
    options: { uiHidden?: boolean } = {},
  ): Promise<void> {
    const convId = activeConversationId();
    const trimmed = text.trim();
    const allRefs = mergeDirectoryRefs(trimmed, pendingContextRefs());
    // Resolve inline @ mentions: if user used @refs in text, use only those; otherwise use all attachments
    const inlineRefs = resolveInlineMentions(trimmed, allRefs, inlineMentionPaths());
    const refs = inlineRefs.length > 0 ? inlineRefs : allRefs;
    if (!convId || isStreaming()) return Promise.resolve();
    if (!trimmed && refs.length === 0) return Promise.resolve();
    clearContextRefs();
    clearInlineMentions();

    for (const ref of refs) {
      if (ref.kind === "directory") {
        void bindWorkspace(ref.path, convId ?? undefined).catch((e) => {
          console.error("绑定 workspace 失败:", e);
        });
      }
    }

    if (!options.uiHidden) {
      addMessage({
        id: `pending-user-${Date.now()}`,
        conversation_id: convId,
        role: "user",
        content: trimmed || (refs.length > 0 ? `[已附加 ${refs.length} 项本地资料]` : ""),
        created_at: new Date().toISOString(),
      });
    }

    setActiveDraftResponse(false);
    setActiveEvidenceResponse(false);
    setDraftWorkflowActive(false);
    startStreaming();

    return sendMessage({
      conversation_id: convId,
      content: trimmed,
      context_refs: refs.length > 0 ? refs : undefined,
      ui_hidden: options.uiHidden || undefined,
    })
      .then((messageId) => {
        void loadConversations();
        setTimeout(() => {
          if (isStreaming()) {
            void finishStreaming(messageId);
          }
        }, 250);
      })
      .catch((e) => {
        console.error("发送消息失败:", e);
        clearStreamWatchdog();
        setIsStreaming(false);
        setStreamingContent("");
        setStreamPhase(null);
        setActiveDraftResponse(false);
        setActiveEvidenceResponse(false);
        setDraftWorkflowActive(false);
        throw e;
      });
  }

  function flashArticle(id: string) {
    setJustAddedId(id);
    setTimeout(() => setJustAddedId(null), 1700);
  }

  return {
    conversations,
    activeConversationId,
    messages,
    isStreaming,
    streamingContent,
    streamPhase,
    activeDraftResponse,
    activeEvidenceResponse,
    draftWorkflowActive,
    workflowByMessageId,
    workspacePrompt,
    workspaceMode,
    workspaceModeLabel,
    legalDocument,
    documentMarkdown,
    documentId,
    documentVersion,
    docMeta,
    articles,
    citationGroups,
    docMode,
    justAddedId,
    citeState,
    pendingContextRefs,
    inlineMentionPaths,
    workspaceIndexByPath,
    messageDisplayContent,
    messageWorkflow,
    activeWorkflow,
    ingestAgentTrace,
    submitClarificationAnswers,
    addContextRef,
    removeContextRef,
    clearContextRefs,
    addInlineMention,
    removeInlineMention,
    clearInlineMentions,
    applyWorkspaceIndexProgress,
    workspaceIndexForPath,
    addConversation,
    loadConversations,
    loadMessages,
    removeConversation,
    switchConversation,
    selectConversation,
    setActiveConversationId,
    addMessage,
    startStreaming,
    appendStreamChunk,
    finishStreaming,
    setStreamStatus,
    setIsStreaming,
    setStreamingContent,
    setWorkspacePrompt,
    setArticles,
    setDocMode,
    setJustAddedId,
    setCiteState,
    initWorkspace,
    sendChatMessage,
    flashArticle,
    persistMessageFeedback,
  };
}
