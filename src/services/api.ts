import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import type { FileAttachment, Conversation, Message } from "../stores/conversation";
import type { ContextRefPayload } from "../types/contextRefs";
import type { AgentMode, ClassifyAgentModeResult } from "../types/agentMode";
import type { ParseLegalDocumentResponse } from "../types/legal";
import type { AgentTraceEvent } from "../types/trace";
import type { MessageMetadata } from "../types/workflow";

export type { ContextRefPayload };
export type { ClassifyAgentModeResult };
export type { AgentMode } from "../types/agentMode";

export interface SendMessageRequest {
  conversation_id: string;
  content: string;
  attachments?: FileAttachment[];
  ui_hidden?: boolean;
  /**
   * Local paths the agent may read as context for this message.
   * Each ref must lie under an allowed directory and is resolved server-side.
   */
  context_refs?: ContextRefPayload[];
  /** Mode resolved by the client's per-turn pre-flight; backend honors it and
   *  skips its own classification. */
  forced_mode?: AgentMode;
  forced_label?: string;
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

export interface GenerateFollowupPromptsRequest {
  conversation_id: string;
  message_id: string;
  mode?: string;
  user_prompt?: string;
  summary?: string;
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
  current_mode?: AgentMode;
  current_task_label?: string;
  has_active_document?: boolean;
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

export async function updateMessageMetadata(
  messageId: string,
  metadata: MessageMetadata,
): Promise<void> {
  return invoke("update_message_metadata", {
    messageId,
    metadataJson: JSON.stringify(metadata),
  });
}

export async function generateFollowupPrompts(
  req: GenerateFollowupPromptsRequest,
): Promise<string[]> {
  return invoke("generate_followup_prompts", { req });
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

export interface McpServerHealth {
  name: string;
  online: boolean;
  tool_count: number;
  error?: string | null;
}

export async function getMcpHealth(): Promise<McpServerHealth[]> {
  return invoke("get_mcp_health");
}

export interface LawLibraryEntry {
  file: string;
  name: string;
  aliases: string[];
  doc_type?: string | null;
  doc_number?: string | null;
  status?: string | null;
  article_count?: number | null;
  source_url?: string | null;
  text_verification?: string | null;
  retrieved_at?: string | null;
}

export interface LawLibraryStatus {
  root_path: string;
  law_count: number;
  article_count: number;
  index_status?: {
    root_id: string;
    root_path: string;
    status: string;
    file_count: number;
    chunk_count: number;
  } | null;
  laws: LawLibraryEntry[];
}

export async function getLawLibraryStatus(): Promise<LawLibraryStatus> {
  return invoke("get_law_library_status");
}

export async function reindexLawLibrary(): Promise<{ file_count: number; chunk_count: number }> {
  return invoke("reindex_law_library");
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

export interface DroppedPathKind {
  path: string;
  is_dir: boolean;
  exists: boolean;
}

/** Classify OS-dropped paths into file vs. directory so the composer can attach them. */
export async function classifyDroppedPaths(
  paths: string[],
): Promise<DroppedPathKind[]> {
  return invoke("classify_dropped_paths", { paths });
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

export interface LawUpdateAlert {
  changes: Array<{ name: string; old_status: string; new_status: string }>;
  affected_documents: Array<{ id: string; title: string; law_name: string }>;
  checked: number;
}

/** Regulation monitor: a library statute's 时效状态 changed online. */
export function onLawUpdateAlert(
  callback: (alert: LawUpdateAlert) => void,
): Promise<() => void> {
  return listen<LawUpdateAlert>("law-update-alert", (event) => {
    callback(event.payload);
  });
}

// Stream listener
export function onChatStream(callback: (chunk: StreamChunk) => void): Promise<() => void> {
  return listen<StreamChunk>("chat-stream", (event) => {
    callback(event.payload);
  });
}

// Developer agent-trace listener (structured backend agent-loop events)
export function onAgentTrace(
  callback: (event: AgentTraceEvent) => void,
): Promise<() => void> {
  return listen<AgentTraceEvent>("agent-trace", (event) => {
    callback(event.payload);
  });
}

// ---------------------------------------------------------------------------
// SkillOpt / skill refinement (admin + lawyer feedback)
// ---------------------------------------------------------------------------

export interface SkillOptWeights {
  human: number;
  rubric: number;
  cite: number;
}

export interface SkillOptSettings {
  enabled: boolean;
  gate: string;
  auto_adopt: string;
  weights: SkillOptWeights;
  budget_tokens: number;
  eval_data_roots: string[];
  optimizer_provider?: unknown;
}

export interface SkillFeedbackRow {
  id: string;
  message_id: string;
  conversation_id: string;
  skill_name?: string | null;
  plugin_name?: string | null;
  rating: string;
  comment?: string | null;
  dimensions_json?: string | null;
  created_at: string;
}

export interface EvalCaseRow {
  id: string;
  name: string;
  target_skill?: string | null;
  target_plugin?: string | null;
  prompt: string;
  materials_path?: string | null;
  rubric?: string | null;
  gold_reference_path?: string | null;
  split: string;
  origin: string;
  active: boolean;
  created_at: string;
}

export interface EvalRunRow {
  id: string;
  case_id: string;
  skill_hash?: string | null;
  score: number;
  rubric_json?: string | null;
  citation_json?: string | null;
  tokens?: number | null;
  latency_ms?: number | null;
  created_at: string;
}

export interface SkillProposalRow {
  id: string;
  target_path: string;
  base_hash?: string | null;
  diff: string;
  rationale?: string | null;
  val_before?: number | null;
  val_after?: number | null;
  status: string;
  created_at: string;
  adopted_at?: string | null;
}

export interface SkillOptOverview {
  feedback_count: number;
  eval_case_count: number;
  staged_proposals: number;
  settings: SkillOptSettings;
}

export interface SkillOptProgressEvent {
  stage: string;
  message: string;
  progress?: number | null;
  detail?: unknown;
}

export interface SubmitFeedbackRequest {
  message_id: string;
  conversation_id: string;
  skill_name?: string;
  plugin_name?: string;
  rating: "up" | "down";
  comment?: string;
  dimensions?: string[];
  app_version?: string;
  skills_version?: string | null;
}

export async function getAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "unknown";
  }
}

export async function getSkilloptSettings(): Promise<SkillOptSettings> {
  return invoke("get_skillopt_settings");
}

export async function setSkilloptSettings(settings: SkillOptSettings): Promise<void> {
  return invoke("set_skillopt_settings", { settings });
}

export async function submitMessageFeedback(req: SubmitFeedbackRequest): Promise<SkillFeedbackRow> {
  return invoke("submit_message_feedback", { req });
}

export async function getMessageFeedback(conversationId: string): Promise<SkillFeedbackRow[]> {
  return invoke("get_message_feedback", { conversationId });
}

export async function listAllFeedback(limit?: number): Promise<SkillFeedbackRow[]> {
  return invoke("list_all_feedback", { limit });
}

export async function listEvalCases(): Promise<EvalCaseRow[]> {
  return invoke("list_eval_cases");
}

export async function setEvalCaseActive(caseId: string, active: boolean): Promise<void> {
  return invoke("set_eval_case_active", { caseId, active });
}

export async function runEvalCase(caseId: string): Promise<{ run: EvalRunRow; answer_preview: string }> {
  return invoke("run_eval_case", { caseId });
}

export async function listEvalRuns(caseId: string, limit?: number): Promise<EvalRunRow[]> {
  return invoke("list_eval_runs", { caseId, limit });
}

export async function listProposals(status?: string): Promise<SkillProposalRow[]> {
  return invoke("list_proposals", { status });
}

export async function adoptProposal(proposalId: string): Promise<string> {
  return invoke("adopt_proposal", { proposalId });
}

export async function rejectProposal(proposalId: string): Promise<void> {
  return invoke("reject_proposal", { proposalId });
}

export async function runSkillRefinement(options?: {
  targetSkill?: string;
  dryRun?: boolean;
  rolloutsK?: number;
  nights?: number;
}): Promise<string[]> {
  return invoke("run_skill_refinement", {
    targetSkill: options?.targetSkill,
    dryRun: options?.dryRun,
    rolloutsK: options?.rolloutsK,
    nights: options?.nights,
  });
}

export async function mineEvalCases(): Promise<number> {
  return invoke("mine_eval_cases");
}

export async function getSkilloptOverview(): Promise<SkillOptOverview> {
  return invoke("get_skillopt_overview");
}

export function onSkillOptProgress(
  callback: (event: SkillOptProgressEvent) => void,
): Promise<() => void> {
  return listen<SkillOptProgressEvent>("skillopt-progress", (event) => {
    callback(event.payload);
  });
}

// ---------------------------------------------------------------------------
// Sync service (feedback outbox + skill/app updates)
// ---------------------------------------------------------------------------

export interface SyncSettings {
  sync_base_url?: string | null;
  has_api_key: boolean;
  device_id: string;
  feedback_upload_enabled: boolean;
  upload_full_answer: boolean;
  skills_channel: string;
  app_update_channel: string;
  skills_version?: string | null;
}

export interface SyncSettingsUpdate {
  sync_base_url?: string | null;
  sync_api_key?: string | null;
  feedback_upload_enabled: boolean;
  upload_full_answer: boolean;
  skills_channel: string;
  app_update_channel: string;
}

export interface SyncStatus {
  settings: SyncSettings;
  pending_outbox: number;
}

export async function getSyncSettings(): Promise<SyncSettings> {
  return invoke("get_sync_settings");
}

export async function setSyncSettings(update: SyncSettingsUpdate): Promise<void> {
  return invoke("set_sync_settings", { update });
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return invoke("get_sync_status_cmd");
}

export async function flushFeedbackOutbox(): Promise<number> {
  return invoke("flush_feedback_outbox");
}

export async function testSyncConnection(): Promise<void> {
  return invoke("test_sync_connection");
}

export function onSkillsUpdated(
  callback: (payload: { version: string }) => void,
): Promise<() => void> {
  return listen<{ version: string }>("skills-updated", (event) => {
    callback(event.payload);
  });
}

export interface AppUpdateInfo {
  available: boolean;
  version?: string;
  body?: string;
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { available: false };
    return {
      available: true,
      version: update.version,
      body: update.body ?? undefined,
    };
  } catch {
    return { available: false };
  }
}

export async function installAppUpdate(): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  const update = await check();
  if (!update) return;
  await update.downloadAndInstall();
  await relaunch();
}
