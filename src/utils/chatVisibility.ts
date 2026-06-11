export interface ChatVisibilityMessage {
  role: string;
  metadata?: { content_hidden?: boolean };
  metadata_json?: string | null;
}

export function messageContentHidden(message: ChatVisibilityMessage): boolean {
  if (message.metadata?.content_hidden) return true;
  if (!message.metadata_json) return false;
  try {
    return JSON.parse(message.metadata_json)?.content_hidden === true;
  } catch {
    return false;
  }
}

export function isVisibleChatMessage(message: ChatVisibilityMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  return !(message.role === "user" && messageContentHidden(message));
}
