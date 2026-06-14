#!/usr/bin/env bun
/**
 * 本地反馈 CLI（无需启动 HTTP 服务）
 *
 * bun run scripts/feedback-cli.ts summary
 * bun run scripts/feedback-cli.ts export --rating=down --status=open -o feedback.md
 * bun run scripts/feedback-cli.ts triage --remote-id=xxx --status=handled
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadAllFeedback,
  loadTriage,
  mergeTriage,
  saveTriage,
  type TargetRepo,
  type TriageStatus,
} from "../src/feedback-store.ts";
import {
  exportFeedbackMarkdown,
  filterFeedback,
  summarizeFeedback,
  type FeedbackFilters,
} from "../src/feedback-query.ts";

const DATA_DIR = resolve(process.env.SYNC_DATA_DIR ?? join(import.meta.dir, "..", "data"));
const FEEDBACK_LOG = join(DATA_DIR, "feedback.jsonl");
const TRIAGE_PATH = join(DATA_DIR, "feedback-triage.json");

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const [k, ...rest] = arg.slice(2).split("=");
      out[k] = rest.join("=");
    } else if (arg.startsWith("-o") && !arg.includes("=")) {
      const idx = argv.indexOf(arg);
      out.o = argv[idx + 1] ?? "feedback-export.md";
    }
  }
  return out;
}

function filtersFromArgs(args: Record<string, string>): FeedbackFilters {
  return {
    skill: args.skill ?? null,
    plugin: args.plugin ?? null,
    rating: args.rating ?? null,
    status: (args.status as TriageStatus) ?? null,
    target_repo: (args["target-repo"] as TargetRepo) ?? null,
    since: args.since ?? null,
    until: args.until ?? null,
    limit: args.limit ? Number(args.limit) : 200,
  };
}

async function main() {
  const cmd = process.argv[2] ?? "summary";
  const args = parseArgs(process.argv.slice(3));
  const all = mergeTriage(await loadAllFeedback(FEEDBACK_LOG), await loadTriage(TRIAGE_PATH));

  if (cmd === "summary") {
    const f = filtersFromArgs(args);
    const items = filterFeedback(all, f);
    console.log(JSON.stringify(summarizeFeedback(items), null, 2));
    return;
  }

  if (cmd === "export") {
    const f = filtersFromArgs(args);
    const items = filterFeedback(all, f);
    const md = exportFeedbackMarkdown(items, { filters: f });
    const outPath = args.o ?? "feedback-export.md";
    await writeFile(outPath, md, "utf8");
    console.log(`Wrote ${items.length} items → ${outPath}`);
    return;
  }

  if (cmd === "triage") {
    const remoteId = args["remote-id"];
    if (!remoteId) {
      console.error("Usage: triage --remote-id=<uuid> [--status=handled] [--target-repo=ai-for-china-legal]");
      process.exit(1);
    }
    const triage = await loadTriage(TRIAGE_PATH);
    triage[remoteId] = {
      status: (args.status as TriageStatus) ?? "triaged",
      target_repo: args["target-repo"] as TargetRepo | undefined,
      notes: args.notes,
      updated_at: new Date().toISOString(),
    };
    await saveTriage(TRIAGE_PATH, triage);
    console.log(JSON.stringify(triage[remoteId], null, 2));
    return;
  }

  console.log(`Commands: summary | export | triage
Examples:
  bun run scripts/feedback-cli.ts summary --rating=down
  bun run scripts/feedback-cli.ts export --rating=down --status=open -o feedback.md
  bun run scripts/feedback-cli.ts triage --remote-id=abc --status=handled`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
