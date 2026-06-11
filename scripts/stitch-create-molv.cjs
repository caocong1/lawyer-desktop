/**
 * Create 墨律 Inkstatute project in Google Stitch (API Key).
 * Usage: node scripts/stitch-create-molv.cjs [--project-only]
 */
const { spawnSync } = require("child_process");
const path = require("path");

const PROJECT_ONLY = process.argv.includes("--project-only");
const TITLE = "墨律 Inkstatute";

const SCREEN_PROMPTS = [
  {
    name: "home",
    prompt: `Desktop app home screen for "墨律 Inkstatute" legal AI assistant. Warm parchment theme (#f4ede0 background). Custom title bar with seal "墨", app name 墨律, theme switcher A/B/C, settings gear. Greeting "下午好", date, subtitle in Chinese. Starter card with burgundy seal, "新建文书", AI pill, text input. Grid of 8 document type cards (股权转让协议, 民事起诉状, 法律意见书…). Recent conversations. Noto Serif SC, professional Chinese law firm. 1280x800 desktop.`,
  },
  {
    name: "workspace",
    prompt: `Desktop workspace for "墨律 Inkstatute". Split: left chat (#efe7d7), right legal document preview on parchment sheet with burgundy accent bar — "股权转让协议", numbered clauses, yellow risk highlight, gold citations. Title bar with export DOCX. Burgundy #74302d accents. 1280x800.`,
  },
  {
    name: "settings",
    prompt: `Settings modal for "墨律 Inkstatute". LLM provider, API key, test button, MCP law-database status, theme A/B/C previews. Chinese labels, warm parchment styling. 1280x800 desktop.`,
  },
];

function runApi(args) {
  const script = path.join(__dirname, "stitch-api.cjs");
  const r = spawnSync("node", [script, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim());
}

function extractProjectId(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const m = text.match(/projects\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (data?.name) return String(data.name).replace(/^projects\//, "");
  if (data?.projectId) return data.projectId;
  throw new Error(`No project id in: ${text.slice(0, 400)}`);
}

async function main() {
  console.log("Listing projects…");
  const existing = runApi(["list"]);
  const existingText = JSON.stringify(existing);

  let projectId;
  if (existingText.includes(TITLE)) {
    projectId = extractProjectId(existing);
    console.log(`Reusing existing project: ${projectId}`);
  } else {
    console.log(`Creating "${TITLE}"…`);
    const created = runApi(["create", TITLE]);
    console.log(JSON.stringify(created, null, 2));
    projectId = extractProjectId(created);
  }

  console.log(`Project ID: ${projectId}`);
  if (PROJECT_ONLY) {
    console.log(`https://stitch.withgoogle.com/project/${projectId}`);
    return;
  }

  for (const screen of SCREEN_PROMPTS) {
    console.log(`\nGenerating "${screen.name}"… (1-3 min)`);
    const result = runApi(["generate", projectId, screen.prompt, "DESKTOP"]);
    console.log(JSON.stringify(result, null, 2));
  }

  console.log(`\nDone: https://stitch.withgoogle.com/project/${projectId}`);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
