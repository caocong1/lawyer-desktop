import { createSignal } from "solid-js";
import type { AgentMode } from "../types/agentMode";
import type { ContextRefPayload } from "../types/contextRefs";
import type {
  Article,
  CitationGroups,
  DocMeta,
  LegalDocumentModel,
} from "../types/legal";
import {
  extractLegalDocumentJson,
  isPublishableDocument,
  markdownToLegalDocument,
  modelToArticles,
  modelToCitationGroups,
  modelToDocMeta,
  containsToolLeakage,
  sanitizeLlmDocumentContent,
} from "../utils/legalDocument";
import { mergeDirectoryRefs } from "../utils/evidenceFlow";
import {
  getConversations,
  getMessages,
  deleteConversation as deleteConversationApi,
  setActiveConversation,
  sendMessage,
  parseLegalDocument,
  bindWorkspace,
  classifyAgentMode,
} from "../services/api";

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

const STREAM_WATCHDOG_MS = 5 * 60 * 1000;
let streamWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearStreamWatchdog() {
  if (streamWatchdog !== null) {
    clearTimeout(streamWatchdog);
    streamWatchdog = null;
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

function applyDocumentModel(model: LegalDocumentModel, markdown: string, id: string | null) {
  setLegalDocument(model);
  setDocumentMarkdown(markdown);
  setDocumentId(id);
  setDocumentVersion((v) => v + 1);
  setDocMeta(modelToDocMeta(model));
  setArticles(modelToArticles(model));
  setCitationGroups(modelToCitationGroups(model));
}

async function applyParsedDocument(jsonContent: string): Promise<boolean> {
  const convId = activeConversationId();
  try {
    const res = await parseLegalDocument({
      json_content: jsonContent,
      conversation_id: convId ?? undefined,
    });
    applyDocumentModel(res.document, res.markdown, res.document_id);
    return true;
  } catch (e) {
    console.warn("解析法律文书 JSON 失败:", e);
    return false;
  }
}

async function tryApplyDocumentFromContent(content: string): Promise<boolean> {
  if (!isPublishableDocument(content)) return false;

  const cleaned = sanitizeLlmDocumentContent(content);
  const json = extractLegalDocumentJson(cleaned) ?? extractLegalDocumentJson(content);
  if (json) {
    return applyParsedDocument(json);
  }

  const model = markdownToLegalDocument(cleaned, workspacePrompt());
  if (model) {
    applyDocumentModel(model, cleaned, null);
    return true;
  }

  return false;
}

async function restoreDocumentFromMessages() {
  const msgs = [...messages()].reverse();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    if (m.content.includes("正文见右侧文书预览")) continue;
    if (await tryApplyDocumentFromContent(m.content)) {
      if (
        m.content.length > 120 &&
        !m.content.includes("正文见右侧文书预览")
      ) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === m.id
              ? {
                  ...msg,
                  content: draftCompletionSummary(
                    docMeta().title || workspacePrompt(),
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
      setMessages(result);
    } catch (e) {
      console.error("加载消息失败:", e);
    }
  }

  async function removeConversation(id: string) {
    try {
      await deleteConversationApi(id);
    } catch (e) {
      console.error("删除会话失败:", e);
    }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId() === id) {
      const remaining = conversations().filter((c) => c.id !== id);
      setActiveConversationId(remaining.length > 0 ? remaining[0].id : null);
      setMessages([]);
      clearDocumentState();
    }
  }

  async function switchConversation(id: string) {
    setActiveConversationId(id);
    setPendingContextRefs([]);
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
    setPendingContextRefs([]);
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

    if (content) {
      let chatContent = content;

      if (isDocDraft) {
        setStreamPhase("review");
        const parsed = await tryApplyDocumentFromContent(content);
        if (parsed) {
          chatContent = draftCompletionSummary(docMeta().title || "法律文书");
        } else {
          clearDocumentState();
          setDraftWorkflowActive(false);
          chatContent =
            "**起草未完成：** 模型返回了工具调用残留或非法务正文，右侧预览已跳过。请重试发送，或检查模型是否支持工具调用。";
        }
      } else if (isEvidence) {
        const cleaned = sanitizeLlmDocumentContent(content);
        if (!cleaned || containsToolLeakage(cleaned)) {
          chatContent =
            "**分析未完成：** 模型返回了工具调用残留，未能生成可读报告。请重试，或检查模型是否支持标准工具调用。";
          setDocumentMarkdown("");
        } else {
          chatContent = cleaned;
          setDocumentMarkdown(chatContent);
        }
      } else {
        await tryApplyDocumentFromContent(content);
      }

      addMessage({
        id: messageId,
        conversation_id: activeConversationId() || "",
        role: "assistant",
        content: chatContent,
        created_at: new Date().toISOString(),
      });
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
    if (status === "tool" || status === "thinking") {
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
  }

  function clearContextRefs() {
    setPendingContextRefs([]);
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

  function sendChatMessage(text: string): Promise<void> {
    const convId = activeConversationId();
    const trimmed = text.trim();
    const refs = mergeDirectoryRefs(trimmed, pendingContextRefs());
    if (!convId || isStreaming()) return Promise.resolve();
    if (!trimmed && refs.length === 0) return Promise.resolve();
    clearContextRefs();

    for (const ref of refs) {
      if (ref.kind === "directory") {
        void bindWorkspace(ref.path, convId ?? undefined).catch((e) => {
          console.error("绑定 workspace 失败:", e);
        });
      }
    }

    addMessage({
      id: `pending-user-${Date.now()}`,
      conversation_id: convId,
      role: "user",
      content: trimmed || (refs.length > 0 ? `[已附加 ${refs.length} 项本地资料]` : ""),
      created_at: new Date().toISOString(),
    });

    return resolveAgentMode(trimmed || "分析附加的本地资料", refs)
      .then((classification) => {
        const isDocDraft = classification.mode === "draft";
        const isEvidenceFlow = classification.mode === "evidence";
        setActiveDraftResponse(isDocDraft);
        setActiveEvidenceResponse(isEvidenceFlow);
        if (isDocDraft) {
          setDraftWorkflowActive(true);
        } else if (isEvidenceFlow) {
          setDraftWorkflowActive(false);
          setStreamPhase("indexing");
        } else {
          setDraftWorkflowActive(false);
        }
        startStreaming();

        return sendMessage({
          conversation_id: convId,
          content: trimmed,
          context_refs: refs.length > 0 ? refs : undefined,
        }).then((messageId) => {
          setTimeout(() => {
            if (isStreaming()) {
              void finishStreaming(messageId);
            }
          }, 250);
        });
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
    workspaceIndexByPath,
    addContextRef,
    removeContextRef,
    clearContextRefs,
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
  };
}
