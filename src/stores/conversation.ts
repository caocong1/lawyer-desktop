import { createSignal } from "solid-js";
import type {
  Article,
  CitationGroups,
  DocMeta,
  LegalDocumentModel,
} from "../types/legal";
import {
  extractLegalDocumentJson,
  modelToArticles,
  modelToCitationGroups,
  modelToDocMeta,
} from "../utils/legalDocument";
import {
  getConversations,
  getMessages,
  deleteConversation as deleteConversationApi,
  setActiveConversation,
  sendMessage,
  parseLegalDocument,
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

const [workspacePrompt, setWorkspacePrompt] = createSignal<string>("");
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

async function restoreDocumentFromMessages() {
  const msgs = [...messages()].reverse();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    const json = extractLegalDocumentJson(m.content);
    if (json) {
      await applyParsedDocument(json);
      return;
    }
  }
  clearDocumentState();
}

async function tryParseFromContent(content: string) {
  const json = extractLegalDocumentJson(content);
  if (json) {
    await applyParsedDocument(json);
  }
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
    setStreamingContent("");
    setIsStreaming(false);
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
    setStreamingContent("");
    setIsStreaming(false);
    clearDocumentState();
  }

  function addMessage(msg: Message) {
    setMessages((prev) => [...prev, msg]);
  }

  function startStreaming() {
    setIsStreaming(true);
    setStreamingContent("");
  }

  function appendStreamChunk(chunk: string) {
    setStreamingContent((prev) => prev + chunk);
  }

  function finishStreaming(messageId: string) {
    const content = streamingContent();
    if (content) {
      addMessage({
        id: messageId,
        conversation_id: activeConversationId() || "",
        role: "assistant",
        content,
        created_at: new Date().toISOString(),
      });
      void tryParseFromContent(content);
    }
    setIsStreaming(false);
    setStreamingContent("");
  }

  async function initWorkspace(prompt: string, conversationId: string) {
    setWorkspacePrompt(prompt);
    setDocMode("preview");
    setJustAddedId(null);
    setCiteState({ open: false, tab: "law", key: null });
    setStreamingContent("");
    setIsStreaming(false);
    clearDocumentState();
    await loadMessages(conversationId);
    await restoreDocumentFromMessages();
  }

  async function sendChatMessage(text: string): Promise<void> {
    const convId = activeConversationId();
    const trimmed = text.trim();
    if (!convId || !trimmed || isStreaming()) return;

    addMessage({
      id: `pending-user-${Date.now()}`,
      conversation_id: convId,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    });
    startStreaming();

    try {
      await sendMessage({
        conversation_id: convId,
        content: trimmed,
      });
    } catch (e) {
      setIsStreaming(false);
      setStreamingContent("");
      throw e;
    }
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
    workspacePrompt,
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
