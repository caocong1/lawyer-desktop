import {
  effectiveAppVersion,
  effectiveSkillsVersion,
  type FeedbackPayload,
  type FeedbackRecord,
  type FeedbackWithTriage,
  type TargetRepo,
  type TriageStatus,
} from "./feedback-store.ts";

export interface FeedbackFilters {
  skill?: string | null;
  plugin?: string | null;
  rating?: string | null;
  status?: TriageStatus | null;
  target_repo?: TargetRepo | null;
  since?: string | null;
  until?: string | null;
  device_id?: string | null;
  limit?: number;
  offset?: number;
}

export interface FeedbackSummary {
  total: number;
  by_rating: Record<string, number>;
  by_skill: Record<string, number>;
  by_plugin: Record<string, number>;
  by_status: Record<string, number>;
  by_dimension: Record<string, number>;
  by_app_version: Record<string, number>;
  by_skills_version: Record<string, number>;
  down_with_comment: number;
  date_range: { earliest: string | null; latest: string | null };
}

function recordTime(r: FeedbackRecord): string {
  return r.payload.created_at ?? r.received_at;
}

function matchesFilters(item: FeedbackWithTriage, f: FeedbackFilters): boolean {
  const p = item.payload;
  if (f.skill) {
    const needle = f.skill.toLowerCase();
    const sn = (p.skill_name ?? "").toLowerCase();
    const pn = (p.plugin_name ?? "").toLowerCase();
    if (!sn.includes(needle) && !pn.includes(needle)) return false;
  }
  if (f.plugin && !(p.plugin_name ?? "").toLowerCase().includes(f.plugin.toLowerCase())) {
    return false;
  }
  if (f.rating && p.rating !== f.rating) return false;
  if (f.status && item.triage.status !== f.status) return false;
  if (f.target_repo && item.triage.target_repo !== f.target_repo) return false;
  if (f.device_id && item.device_id !== f.device_id) return false;
  const t = recordTime(item);
  if (f.since && t < f.since) return false;
  if (f.until && t > f.until) return false;
  return true;
}

export function filterFeedback(
  items: FeedbackWithTriage[],
  f: FeedbackFilters,
): FeedbackWithTriage[] {
  let out = items.filter((i) => matchesFilters(i, f));
  out.sort((a, b) => recordTime(b).localeCompare(recordTime(a)));
  const offset = f.offset ?? 0;
  const limit = f.limit ?? 100;
  return out.slice(offset, offset + limit);
}

export function summarizeFeedback(items: FeedbackWithTriage[]): FeedbackSummary {
  const summary: FeedbackSummary = {
    total: items.length,
    by_rating: {},
    by_skill: {},
    by_plugin: {},
    by_status: {},
    by_dimension: {},
    by_app_version: {},
    by_skills_version: {},
    down_with_comment: 0,
    date_range: { earliest: null, latest: null },
  };

  for (const item of items) {
    const p = item.payload;
    const rating = p.rating ?? "unknown";
    summary.by_rating[rating] = (summary.by_rating[rating] ?? 0) + 1;

    const skill = p.skill_name ?? "(none)";
    summary.by_skill[skill] = (summary.by_skill[skill] ?? 0) + 1;

    const plugin = p.plugin_name ?? "(none)";
    summary.by_plugin[plugin] = (summary.by_plugin[plugin] ?? 0) + 1;

    const appVer = effectiveAppVersion(item);
    summary.by_app_version[appVer] = (summary.by_app_version[appVer] ?? 0) + 1;

    const skillsVer = effectiveSkillsVersion(item);
    summary.by_skills_version[skillsVer] = (summary.by_skills_version[skillsVer] ?? 0) + 1;

    const st = item.triage.status;
    summary.by_status[st] = (summary.by_status[st] ?? 0) + 1;

    if (rating === "down" && p.comment?.trim()) summary.down_with_comment += 1;

    for (const d of p.dimensions ?? []) {
      summary.by_dimension[d] = (summary.by_dimension[d] ?? 0) + 1;
    }

    const t = recordTime(item);
    if (!summary.date_range.earliest || t < summary.date_range.earliest) {
      summary.date_range.earliest = t;
    }
    if (!summary.date_range.latest || t > summary.date_range.latest) {
      summary.date_range.latest = t;
    }
  }

  return summary;
}

function suggestTargetRepo(p: FeedbackPayload): TargetRepo {
  const dims = (p.dimensions ?? []).join(" ");
  const comment = p.comment ?? "";
  const blob = `${dims} ${comment}`.toLowerCase();
  const appHints = ["同步", "上传", "崩溃", "界面", "设置", "outbox", "更新失败"];
  if (appHints.some((h) => blob.includes(h))) return "lawyer-desktop";
  return "ai-for-china-legal";
}

function formatItem(item: FeedbackWithTriage, index: number): string {
  const p = item.payload;
  const dims = p.dimensions?.length ? p.dimensions.join("、") : "—";
  const target = item.triage.target_repo ?? suggestTargetRepo(p);
  const lines = [
    `### ${index + 1}. [${p.rating ?? "?"}] ${p.skill_name ?? "unknown"} (${p.plugin_name ?? "—"})`,
    "",
    `- **remote_id**: \`${item.remote_id}\``,
    `- **时间**: ${recordTime(item)}`,
    `- **App 版本**: ${effectiveAppVersion(item)}`,
    `- **Skill 包版本**: ${effectiveSkillsVersion(item)}`,
    `- **状态**: ${item.triage.status}${item.triage.notes ? ` — ${item.triage.notes}` : ""}`,
    `- **建议改仓库**: \`${target}\``,
    `- **维度**: ${dims}`,
  ];
  if (p.comment?.trim()) lines.push(`- **评论**: ${p.comment.trim()}`);
  if (p.answer?.trim()) {
    const preview =
      p.answer.length > 800 ? p.answer.slice(0, 800) + "\n\n…[已截断]" : p.answer;
    lines.push("", "**AI 回答摘要/全文**:", "", "```", preview, "```");
  }
  lines.push("");
  return lines.join("\n");
}

export function exportFeedbackMarkdown(
  items: FeedbackWithTriage[],
  opts: { title?: string; filters?: FeedbackFilters } = {},
): string {
  const summary = summarizeFeedback(items);
  const title = opts.title ?? "墨律律师反馈导出";
  const filterDesc = opts.filters
    ? Object.entries(opts.filters)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "全部";

  const header = [
    `# ${title}`,
    "",
    `> 生成时间: ${new Date().toISOString()}`,
    `> 筛选: ${filterDesc || "无"}`,
    `> 条数: ${items.length}`,
    "",
    "## 汇总",
    "",
    "| 指标 | 值 |",
    "|------|-----|",
    `| 总计 | ${summary.total} |`,
    `| 👍 | ${summary.by_rating.up ?? 0} |`,
    `| 👎 | ${summary.by_rating.down ?? 0} |`,
    `| 有评论的 👎 | ${summary.down_with_comment} |`,
    "",
    "### 按 skill",
    "",
    ...Object.entries(summary.by_skill)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "### 按 App 版本",
    "",
    ...Object.entries(summary.by_app_version)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "### 按 Skill 包版本",
    "",
    ...Object.entries(summary.by_skills_version)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "### 按维度（👎/👍 合计）",
    "",
    ...Object.entries(summary.by_dimension)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "## 给 AI 助手的指令模板",
    "",
    "```",
    "请读取本文件，执行 feedback-refinement 工作流：",
    "1. 只处理 status=open 且 rating=down 的条目",
    "2. 按 plugin/skill 聚类问题模式",
    "3. 法律质量问题 → 改 ai-for-china-legal 对应 SKILL.md（有界编辑 REPLACE/APPEND）",
    "4. App/同步/UI 问题 → 改 lawyer-desktop",
    "5. 相关评测用例用 rubric + 律师审定样稿做 val 回放",
    "6. 通过后 git commit，运行 tools/publish-skill 发布 skill 包",
    "```",
    "",
    "## 明细",
    "",
  ];

  const body = items.map((item, i) => formatItem(item, i)).join("\n");
  return header.join("\n") + body;
}

export function parseFiltersFromUrl(url: URL): FeedbackFilters {
  return {
    skill: url.searchParams.get("skill"),
    plugin: url.searchParams.get("plugin"),
    rating: url.searchParams.get("rating"),
    status: url.searchParams.get("status") as TriageStatus | null,
    target_repo: url.searchParams.get("target_repo") as TargetRepo | null,
    since: url.searchParams.get("since"),
    until: url.searchParams.get("until"),
    device_id: url.searchParams.get("device_id"),
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
    offset: url.searchParams.has("offset")
      ? Number(url.searchParams.get("offset"))
      : undefined,
  };
}
