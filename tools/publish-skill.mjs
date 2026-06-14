#!/usr/bin/env node
/**
 * 打包 ai-for-china-legal 并写入 sync-service manifest。
 *
 * Usage:
 *   node tools/publish-skill.mjs --root ../ai-for-china-legal --version 2026.06.15.1
 *   node tools/publish-skill.mjs --root vendor/ai-for-china-legal --version 2026.06.15.1 --channel stable --notes "fix guohang"
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.includes("=")) {
      const [k, ...rest] = a.slice(2).split("=");
      out[k] = rest.join("=");
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function zipDirectory(sourceDir, zipPath) {
  rmSync(zipPath, { force: true });
  if (process.platform === "win32") {
    const ps = [
      "Compress-Archive",
      `-Path "${sourceDir}\\*"`,
      `-DestinationPath "${zipPath}"`,
      "-Force",
    ].join(" ");
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
    return;
  }
  const r = spawnSync("zip", ["-r", zipPath, "."], { cwd: sourceDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("zip failed; install zip or use Windows PowerShell");
    process.exit(r.status ?? 1);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? join(REPO_ROOT, "vendor/ai-for-china-legal"));
const version = args.version;
const channel = args.channel ?? "stable";
const notes = args.notes ?? "";
const syncData = resolve(args["sync-data"] ?? join(REPO_ROOT, "tools/sync-service/data"));

if (!version) {
  console.error("Required: --version YYYY.MM.DD.N");
  process.exit(1);
}
if (!existsSync(root)) {
  console.error(`Skills root not found: ${root}`);
  process.exit(1);
}

const marketplace = join(root, ".claude-plugin/marketplace.json");
if (!existsSync(marketplace)) {
  console.error(`Missing ${marketplace}`);
  process.exit(1);
}

const skillsDir = join(syncData, "skills");
mkdirSync(skillsDir, { recursive: true });

const zipPath = join(skillsDir, `${version}.zip`);
console.log(`Zipping ${root} → ${zipPath}`);
zipDirectory(root, zipPath);

const sha256 = sha256File(zipPath);
const manifest = {
  name: "ai-for-china-legal",
  version,
  channel,
  sha256,
  download_url: `/api/skills/download/${version}`,
  notes: notes || undefined,
};

const manifestPath = join(skillsDir, `manifest-${channel}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

console.log("\nPublished skill package:");
console.log(`  zip:      ${zipPath}`);
console.log(`  sha256:   ${sha256}`);
console.log(`  manifest: ${manifestPath}`);
console.log("\nClients on channel", channel, "will pick this up on next skills check.");
