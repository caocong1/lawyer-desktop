import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileAttachment } from "../stores/conversation";

export interface SendMessageRequest {
  conversation_id: string;
  content: string;
  attachments?: FileAttachment[];
}

export interface StreamChunk {
  conversation_id: string;
  message_id: string;
  chunk: string;
  done: boolean;
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
}

// Chat
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

export async function setSkillsRoot(path: string): Promise<number> {
  return invoke("set_skills_root", { path });
}

export async function reloadSkills(): Promise<number> {
  return invoke("reload_skills");
}

export async function listSkills(): Promise<SkillMetadata[]> {
  return invoke("list_skills");
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

// Documents
export async function generateDocx(req: GenerateDocxRequest): Promise<string> {
  return invoke("generate_docx", { req });
}

// Feedback
export async function submitFeedback(req: {
  message_id?: string;
  conversation_id: string;
  rating: number;
  comment?: string;
  context_json?: string;
}): Promise<string> {
  return invoke("submit_feedback", { req });
}

// Stream listener
export function onChatStream(callback: (chunk: StreamChunk) => void): Promise<() => void> {
  return listen<StreamChunk>("chat-stream", (event) => {
    callback(event.payload);
  });
}
