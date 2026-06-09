import { createSignal } from "solid-js";

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
  tool_calls?: any[];
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

// 全部使用 signal，确保 () 调用正确
const [conversations, setConversations] = createSignal<Conversation[]>([]);
const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<Message[]>([]);
const [isStreaming, setIsStreaming] = createSignal(false);
const [streamingContent, setStreamingContent] = createSignal("");

export function useConversation() {
  function addConversation(conv: Conversation) {
    setConversations((prev) => [conv, ...prev]);
  }

  function removeConversation(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId() === id) {
      const remaining = conversations().filter((c) => c.id !== id);
      setActiveConversationId(remaining.length > 0 ? remaining[0].id : null);
    }
  }

  function selectConversation(id: string) {
    setActiveConversationId(id);
    setMessages([]);
    setStreamingContent("");
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
    addMessage({
      id: messageId,
      conversation_id: activeConversationId() || "",
      role: "assistant",
      content,
      created_at: new Date().toISOString(),
    });
    setIsStreaming(false);
    setStreamingContent("");
  }

  return {
    // signals — 需要用 () 调用
    conversations,
    activeConversationId,
    messages,
    isStreaming,
    streamingContent,
    // actions
    addConversation,
    removeConversation,
    selectConversation,
    setActiveConversationId,
    addMessage,
    startStreaming,
    appendStreamChunk,
    finishStreaming,
    setIsStreaming,
    setStreamingContent,
  };
}
