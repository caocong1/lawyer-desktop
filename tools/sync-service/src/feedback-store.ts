import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export type TriageStatus = "open" | "triaged" | "handled" | "wontfix";
export type TargetRepo = "ai-for-china-legal" | "lawyer-desktop" | "unknown";

export interface FeedbackPayload {
  feedback_id?: string;
  message_id?: string;
  conversation_id?: string;
  skill_name?: string | null;
  plugin_name?: string | null;
  rating?: string;
  comment?: string | null;
  dimensions?: string[] | null;
  answer?: string;
  upload_full_answer?: boolean;
  message_metadata?: unknown;
  app_version?: string;
  device_id?: string;
  skills_version?: string | null;
  created_at?: string;
}

export interface FeedbackRecord {
  remote_id: string;
  outbox_id: string;
  device_id: string;
  app_version: string;
  skills_version: string | null;
  payload: FeedbackPayload;
  received_at: string;
}

export interface TriageEntry {
  status: TriageStatus;
  target_repo?: TargetRepo;
  notes?: string;
  linked_issue?: string;
  updated_at: string;
}

export interface FeedbackWithTriage extends FeedbackRecord {
  triage: TriageEntry;
}

export async function appendFeedback(
  logPath: string,
  record: FeedbackRecord,
): Promise<void> {
  await appendFile(logPath, JSON.stringify(record) + "\n", "utf8");
}

export async function loadAllFeedback(logPath: string): Promise<FeedbackRecord[]> {
  if (!existsSync(logPath)) return [];
  const raw = await readFile(logPath, "utf8");
  const rows: FeedbackRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as FeedbackRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return rows;
}

export async function loadTriage(triagePath: string): Promise<Record<string, TriageEntry>> {
  if (!existsSync(triagePath)) return {};
  try {
    return JSON.parse(await readFile(triagePath, "utf8")) as Record<string, TriageEntry>;
  } catch {
    return {};
  }
}

export async function saveTriage(
  triagePath: string,
  triage: Record<string, TriageEntry>,
): Promise<void> {
  await writeFile(triagePath, JSON.stringify(triage, null, 2), "utf8");
}

export function defaultTriage(): TriageEntry {
  return { status: "open", updated_at: new Date().toISOString() };
}

export function mergeTriage(
  records: FeedbackRecord[],
  triageMap: Record<string, TriageEntry>,
): FeedbackWithTriage[] {
  return records.map((r) => ({
    ...r,
    triage: triageMap[r.remote_id] ?? defaultTriage(),
  }));
}
