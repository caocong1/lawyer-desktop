/**
 * 墨律同步服务 — feedback ingest/ops, skill/app manifests.
 * Run: bun run dev  (default http://127.0.0.1:8787)
 */
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  appendFeedback,
  loadAllFeedback,
  loadTriage,
  mergeTriage,
  saveTriage,
  type FeedbackRecord,
  type TargetRepo,
  type TriageStatus,
} from "./feedback-store.ts";
import {
  exportFeedbackMarkdown,
  filterFeedback,
  parseFiltersFromUrl,
  summarizeFeedback,
} from "./feedback-query.ts";

const PORT = Number(process.env.SYNC_PORT ?? 8787);
const HOST = process.env.SYNC_HOST ?? "127.0.0.1";
const DATA_DIR = resolve(process.env.SYNC_DATA_DIR ?? join(import.meta.dir, "..", "data"));
const FEEDBACK_LOG = join(DATA_DIR, "feedback.jsonl");
const TRIAGE_PATH = join(DATA_DIR, "feedback-triage.json");
const SKILLS_DIR = join(DATA_DIR, "skills");
const APP_DIR = join(DATA_DIR, "app");

async function ensureDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SKILLS_DIR, { recursive: true });
  await mkdir(APP_DIR, { recursive: true });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function text(data: string, contentType: string, status = 200): Response {
  return new Response(data, { status, headers: { "Content-Type": contentType } });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function checkAuth(req: Request): boolean {
  const expected = process.env.SYNC_API_KEY;
  if (!expected) return true;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

async function readSkillManifest(channel: string): Promise<Record<string, unknown> | null> {
  const path = join(SKILLS_DIR, `manifest-${channel}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function readAppManifest(): Promise<Record<string, unknown> | null> {
  const path = join(APP_DIR, "latest.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadMergedFeedback() {
  const records = await loadAllFeedback(FEEDBACK_LOG);
  const triage = await loadTriage(TRIAGE_PATH);
  return mergeTriage(records, triage);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, service: "inkstatute-sync", version: "0.2.0" });
    }

    if (path.startsWith("/api/") && !checkAuth(req)) {
      return unauthorized();
    }

    // --- Feedback ingest (Phase C) ---
    if (path === "/api/feedback/batch" && req.method === "POST") {
      const body = (await req.json()) as {
        device_id: string;
        app_version: string;
        skills_version?: string;
        items: Array<{ outbox_id: string; payload: unknown }>;
      };
      const accepted: Array<{ outbox_id: string; remote_id: string }> = [];
      for (const item of body.items ?? []) {
        const remote_id = crypto.randomUUID();
        const record: FeedbackRecord = {
          remote_id,
          outbox_id: item.outbox_id,
          device_id: body.device_id,
          app_version: body.app_version,
          skills_version: body.skills_version ?? null,
          payload: item.payload as FeedbackRecord["payload"],
          received_at: new Date().toISOString(),
        };
        await appendFeedback(FEEDBACK_LOG, record);
        accepted.push({ outbox_id: item.outbox_id, remote_id });
      }
      return json({ accepted });
    }

    // --- Feedback ops (Phase C.5) ---
    if (path === "/api/feedback" && req.method === "GET") {
      const filters = parseFiltersFromUrl(url);
      const all = await loadMergedFeedback();
      const items = filterFeedback(all, filters);
      const summary = summarizeFeedback(items);
      return json({ items, summary, count: items.length });
    }

    if (path === "/api/feedback/summary" && req.method === "GET") {
      const filters = parseFiltersFromUrl(url);
      const all = await loadMergedFeedback();
      const items = filterFeedback(all, filters);
      return json(summarizeFeedback(items));
    }

    if (path === "/api/feedback/export.md" && req.method === "GET") {
      const filters = parseFiltersFromUrl(url);
      const all = await loadMergedFeedback();
      const items = filterFeedback(all, filters);
      const md = exportFeedbackMarkdown(items, { filters });
      return text(md, "text/markdown; charset=utf-8");
    }

    if (path === "/api/feedback/export.json" && req.method === "GET") {
      const filters = parseFiltersFromUrl(url);
      const all = await loadMergedFeedback();
      const items = filterFeedback(all, filters);
      return json({ exported_at: new Date().toISOString(), filters, items });
    }

    if (path === "/api/feedback/triage" && req.method === "POST") {
      const body = (await req.json()) as {
        remote_id: string;
        status?: TriageStatus;
        target_repo?: TargetRepo;
        notes?: string;
        linked_issue?: string;
      };
      if (!body.remote_id?.trim()) {
        return json({ error: "remote_id required" }, 400);
      }
      const triage = await loadTriage(TRIAGE_PATH);
      triage[body.remote_id] = {
        status: body.status ?? "triaged",
        target_repo: body.target_repo,
        notes: body.notes,
        linked_issue: body.linked_issue,
        updated_at: new Date().toISOString(),
      };
      await saveTriage(TRIAGE_PATH, triage);
      return json({ ok: true, triage: triage[body.remote_id] });
    }

    if (path === "/api/feedback/triage/batch" && req.method === "POST") {
      const body = (await req.json()) as {
        remote_ids: string[];
        status?: TriageStatus;
        target_repo?: TargetRepo;
        notes?: string;
      };
      const triage = await loadTriage(TRIAGE_PATH);
      const updated: string[] = [];
      for (const id of body.remote_ids ?? []) {
        triage[id] = {
          status: body.status ?? "handled",
          target_repo: body.target_repo,
          notes: body.notes,
          updated_at: new Date().toISOString(),
        };
        updated.push(id);
      }
      await saveTriage(TRIAGE_PATH, triage);
      return json({ ok: true, updated });
    }

    // --- Skill / app distribution (Phase D/E) ---
    if (path === "/api/skills/latest" && req.method === "GET") {
      const channel = url.searchParams.get("channel") ?? "stable";
      const current = url.searchParams.get("current");
      const manifest = await readSkillManifest(channel);
      if (!manifest) return new Response(null, { status: 204 });
      if (current && manifest.version === current) {
        return new Response(null, { status: 204 });
      }
      return json(manifest);
    }

    const skillDownload = path.match(/^\/api\/skills\/download\/(.+)$/);
    if (skillDownload && req.method === "GET") {
      const version = decodeURIComponent(skillDownload[1]!);
      const zipPath = join(SKILLS_DIR, `${version}.zip`);
      if (!existsSync(zipPath)) return json({ error: "not found" }, 404);
      const bytes = await readFile(zipPath);
      return new Response(bytes, {
        headers: { "Content-Type": "application/zip" },
      });
    }

    const appLatest = path.match(/^\/api\/app\/latest\/([^/]+)\/([^/]+)\/(.+)$/);
    if (appLatest && req.method === "GET") {
      const manifest = await readAppManifest();
      if (!manifest) return json({ error: "no app release configured" }, 404);
      return json(manifest);
    }

    if (path === "/api/client/heartbeat" && req.method === "POST") {
      const body = await req.json();
      const logPath = join(DATA_DIR, "heartbeats.jsonl");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(logPath, JSON.stringify({ ...body, at: new Date().toISOString() }) + "\n");
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
});

await ensureDirs();
console.log(`墨律同步服务 listening on http://${HOST}:${server.port}`);
console.log(`Data dir: ${DATA_DIR}`);
console.log(`Feedback ops: GET /api/feedback, /api/feedback/export.md`);

export async function sha256File(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}
