/** Hard caps for conversation titles shared by the drawer and the store. */
export const CONVERSATION_TITLE_MIN = 1;
export const CONVERSATION_TITLE_MAX = 30;

/**
 * Normalize a user-typed title before persisting it. Mirrors the backend
 * `clean_title` truncation cap (30 chars) so neither side surprises the user
 * with a silently shorter title.
 */
export function validateConversationTitle(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length < CONVERSATION_TITLE_MIN) {
    return { ok: false, error: "标题不能为空" };
  }
  if (trimmed.length > CONVERSATION_TITLE_MAX) {
    return {
      ok: false,
      error: `标题长度不能超过 ${CONVERSATION_TITLE_MAX} 个字符`,
    };
  }
  return { ok: true, value: trimmed };
}