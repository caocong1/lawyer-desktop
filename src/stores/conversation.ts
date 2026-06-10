import { createSignal } from "solid-js";
import type { Article } from "../data/seed";
import { seed } from "../data/seed";
import {
  getConversations,
  getMessages,
  deleteConversation as deleteConversationApi,
  setActiveConversation,
  sendMessage,
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

const [conversations, setConversations] = createSignal<Conversation[]>([]);
const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<Message[]>([]);
const [isStreaming, setIsStreaming] = createSignal(false);
const [streamingContent, setStreamingContent] = createSignal("");

// Doc preview state (seed placeholder until Phase 7-C)
const [workspacePrompt, setWorkspacePrompt] = createSignal<string>("");
const [articles, setArticles] = createSignal<Article[]>([...seed.doc.articles]);
const [docMode, setDocMode] = createSignal<DocMode>("preview");
const [justAddedId, setJustAddedId] = createSignal<string | null>(null);
const [citeState, setCiteState] = createSignal<CiteState>({ open: false, tab: "law", key: null });

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
    }
  }

  async function switchConversation(id: string) {
    setActiveConversationId(id);
    setStreamingContent("");
    setIsStreaming(false);
    await loadMessages(id);
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
    }
    setIsStreaming(false);
    setStreamingContent("");
  }

  async function initWorkspace(prompt: string, conversationId: string) {
    setWorkspacePrompt(prompt);
    setArticles([...seed.doc.articles]);
    setDocMode("preview");
    setJustAddedId(null);
    setCiteState({ open: false, tab: "law", key: null });
    setStreamingContent("");
    setIsStreaming(false);
    await loadMessages(conversationId);
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
    articles,
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
