/**
 * Local fallback when the LLM follow-up generator fails or returns nothing —
 * the suggestion row must always appear after a completed turn.
 */
export function fallbackFollowupSuggestions(mode?: string): string[] {
  if (mode === "evidence") {
    return ["补充关键证据材料", "调整诉讼策略与请求", "导出方案为 Word"];
  }
  if (mode === "draft") {
    return ["调整条款与措辞", "补充当事人信息", "导出文书为 Word"];
  }
  return ["继续深入分析", "整理成书面意见", "列出风险与待办"];
}
