import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileAttachment, Conversation, Message } from "../stores/conversation";
import type { ContextRefPayload } from "../types/contextRefs";
import type { ClassifyAgentModeResult } from "../types/agentMode";
import type { ParseLegalDocumentResponse } from "../types/legal";

export type { ContextRefPayload };
export type { ClassifyAgentModeResult };
export type { AgentMode } from "../types/agentMode";

export interface SendMessageRequest {
  conversation_id: string;
  content: string;
  attachments?: FileAttachment[];
  /**
   * Local paths the agent may read as context for this message.
   * Each ref must lie under an allowed directory and is resolved server-side.
   */
  context_refs?: ContextRefPayload[];
}

export interface StreamChunk {
  conversation_id: string;
  message_id: string;
  chunk: string;
  done: boolean;
  status?: string | null;
}

export interface ProviderSetupRequest {
  name: string;
  display_name: string;
  api_base_url: string;
  api_key?: string;
  model_name: string;
}

export interface ProviderPreset {
  name: string;
  display_name: string;
  api_base_url: string;
  default_model: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  argument_hint?: string;
  plugin_name: string;
  skill_md_path: string;
  full_content: string;
}

export interface WorkspaceIndexProgress {
  root_id: string;
  root_path: string;
  conversation_id?: string | null;
  processed: number;
  total: number;
  current_file?: string | null;
  done: boolean;
  stats?: { file_count: number; chunk_count: number } | null;
}

export interface BindWorkspaceResult {
  root_id: string;
  root_path: string;
  status: string;
  file_count: number;
  chunk_count: number;
}

export interface WorkspaceIndexStatus {
  root_id: string;
  root_path: string;
  status: string;
  file_count: number;
  chunk_count: number;
}

export interface FileInfo {
  path: string;
  name: string;
  file_type: string;
  size: number;
  is_dir: boolean;
}

export interface GenerateDocxRequest {
  title: string;
  content_markdown: string;
  template?: string;
  output_path: string;
  conversation_id?: string;
}

export interface ParseLegalDocumentRequest {
  json_content: string;
  conversation_id?: string;
}

export interface LlmProvider {
  id: string;
  name: string;
  display_name: string;
  api_base_url: string;
  api_key?: string;
  model_name: string;
  is_active: boolean;
  config_json?: string;
  created_at: string;
}

// Chat
export async function classifyAgentMode(req: {
  content: string;
  context_refs?: ContextRefPayload[];
}): Promise<ClassifyAgentModeResult> {
  return invoke("classify_agent_mode", { req });
}

export async function sendMessage(req: SendMessageRequest): Promise<string> {
  return invoke("send_message", { req });
}

export async function createConversation(): Promise<{
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}> {
  return invoke("create_conversation");
}

export async function getConversations(): Promise<Conversation[]> {
  return invoke("get_conversations");
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  return invoke("get_messages", { conversationId });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  return invoke("delete_conversation", { conversationId });
}

export async function getActiveProvider(): Promise<LlmProvider | null> {
  return invoke("get_active_provider");
}

export interface FastProviderResponse {
  enabled: boolean;
  name: string;
  display_name: string;
  api_base_url: string;
  model_name: string;
  has_api_key: boolean;
}

export async function getFastModelPresets(): Promise<ProviderPreset[]> {
  return invoke("get_fast_model_presets");
}

export async function getFastProvider(): Promise<FastProviderResponse | null> {
  return invoke("get_fast_provider");
}

export async function setupFastProvider(req: {
  enabled: boolean;
  name: string;
  display_name: string;
  api_base_url: string;
  api_key?: string;
  model_name: string;
}): Promise<void> {
  return invoke("setup_fast_provider", { req });
}

export async function testFastProvider(req: {
  enabled: boolean;
  name: string;
  display_name: string;
  api_base_url: string;
  api_key?: string;
  model_name: string;
}): Promise<string> {
  return invoke("test_fast_provider", { req });
}

export async function setActiveConversation(conversationId: string): Promise<void> {
  return invoke("set_active_conversation", { conversationId });
}

export async function updateConversationTitle(conversationId: string, title: string): Promise<void> {
  return invoke("update_conversation_title", { conversationId, title });
}

// Settings
export async function getProviderPresets(): Promise<ProviderPreset[]> {
  return invoke("get_provider_presets");
}

export async function setupProvider(req: ProviderSetupRequest): Promise<void> {
  return invoke("setup_provider", { req });
}

export async function testProvider(req: ProviderSetupRequest): Promise<string> {
  return invoke("test_provider", { req });
}

export async function getSkillsRoot(): Promise<string | null> {
  return invoke("get_skills_root");
}

export async function setSkillsRoot(path: string): Promise<number> {
  return invoke("set_skills_root", { path });
}

export async function reloadSkills(): Promise<number> {
  return invoke("reload_skills");
}

export async function listSkills(): Promise<SkillMetadata[]> {
  return invoke("list_skills");
}

export async function getMcpHealth(): Promise<Record<string, boolean>> {
  return invoke("get_mcp_health");
}

export async function parseLegalDocument(
  req: ParseLegalDocumentRequest,
): Promise<ParseLegalDocumentResponse> {
  return invoke("parse_legal_document", { req });
}

// Files
export async function readFileContent(path: string): Promise<string> {
  return invoke("read_file_content", { path });
}

export async function listDirectory(path: string, recursive?: boolean): Promise<FileInfo[]> {
  return invoke("list_directory", { path, recursive });
}

export async function prepareAttachment(path: string): Promise<FileAttachment> {
  return invoke("prepare_attachment", { path });
}

/** Grant one-time read access to a path outside the current allowlist. */
export async function grantPathAccess(path: string): Promise<void> {
  return invoke("grant_path_access", { path });
}

export async function getAllowedFileDirs(): Promise<string[]> {
  return invoke("get_allowed_file_dirs");
}

export async function setAllowedFileDirs(dirs: string[]): Promise<void> {
  return invoke("set_allowed_file_dirs", { dirs });
}

/** Grant access and start background FTS indexing for a case-materials directory. */
export async function bindWorkspace(
  path: string,
  conversationId?: string,
): Promise<BindWorkspaceResult> {
  return invoke("bind_workspace", { path, conversationId });
}

export async function getWorkspaceIndexStatus(
  path: string,
): Promise<WorkspaceIndexStatus | null> {
  return invoke("get_workspace_index_status", { path });
}

export async function searchWorkspace(
  path: string,
  query: string,
  k?: number,
): Promise<
  Array<{ chunk_id: string; relative_path: string; text: string; score: number }>
> {
  return invoke("search_workspace", { path, query, k });
}

export function onWorkspaceIndexProgress(
  callback: (event: WorkspaceIndexProgress) => void,
): Promise<() => void> {
  return listen<WorkspaceIndexProgress>("workspace-index-progress", (event) => {
    callback(event.payload);
  });
}

// Documents
export async function generateDocx(req: GenerateDocxRequest): Promise<string> {
  return invoke("generate_docx", { req });
}

// Stream listener
export function onChatStream(callback: (chunk: StreamChunk) => void): Promise<() => void> {
  return listen<StreamChunk>("chat-stream", (event) => {
    callback(event.payload);
  });
}
