import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";

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
  updated_at?: string;
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

function recordRecency(r: FeedbackRecord): number {
  const t = r.received_at || r.payload?.updated_at || r.payload?.created_at || "";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

function isNonDefaultTriage(t: TriageEntry | undefined): boolean {
  if (!t) return false;
  return (
    t.status !== "open" ||
    Boolean(t.notes) ||
    Boolean(t.linked_issue) ||
    Boolean(t.target_repo)
  );
}

/**
 * Collapse the append-only feedback log to one record per feedback_id (the one
 * with the newest received_at). Records without a feedback_id are keyed by their
 * remote_id so legacy uploads are never merged. The kept record inherits the most
 * recently updated non-default triage from anywhere in its group, so editing a
 * feedback never drops an existing triage decision.
 */
export function dedupeWithTriage(
  records: FeedbackRecord[],
  triageMap: Record<string, TriageEntry>,
): FeedbackWithTriage[] {
  const groups = new Map<string, FeedbackRecord[]>();
  for (const r of records) {
    const key = r.payload?.feedback_id ?? `__no_fb__:${r.remote_id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: FeedbackWithTriage[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => recordRecency(b) - recordRecency(a));
    const kept = list[0];

    let triage = triageMap[kept.remote_id];
    if (!isNonDefaultTriage(triage)) {
      const inherited = list
        .map((r) => triageMap[r.remote_id])
        .filter((t): t is TriageEntry => isNonDefaultTriage(t))
        .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];
      if (inherited) triage = inherited;
    }

    out.push({ ...kept, triage: triage ?? defaultTriage() });
  }
  return out;
}

/** 提交时写入 payload 的版本优先，其次为同步批次级版本 */
export function effectiveAppVersion(item: FeedbackWithTriage): string {
  return item.payload.app_version?.trim() || item.app_version || "—";
}

export function effectiveSkillsVersion(item: FeedbackWithTriage): string {
  const fromPayload = item.payload.skills_version?.trim();
  if (fromPayload) return fromPayload;
  return item.skills_version?.trim() || "—";
}
