import type { ContextRefPayload } from "../types/contextRefs";

const MENTION_END_RE = /[\s,，。;；:：!?！？)\]）】》>"'`]/u;

export function detectAtTrigger(
  text: string,
  cursorPos: number,
  opts: { requireBoundary?: boolean } = {},
) {
  const requireBoundary = opts.requireBoundary !== false;
  const pos = Math.min(cursorPos, text.length);
  let i = pos - 1;

  while (i >= 0) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      return { active: false, query: "", atPos: -1 };
    }
    if (ch === "@") {
      const atPos = i;
      if (!requireBoundary || atPos === 0 || /\s/.test(text[atPos - 1]!)) {
        const query = text.slice(atPos + 1, pos);
        return { active: true, query, atPos };
      }
      return { active: false, query: "", atPos: -1 };
    }
    i--;
  }

  return { active: false, query: "", atPos: -1 };
}

export function filterMentionCandidates(
  refs: ContextRefPayload[],
  query: string,
): ContextRefPayload[] {
  if (!query) return refs;
  const lower = query.toLowerCase();
  return refs.filter((r) => r.alias.toLowerCase().includes(lower));
}

export function buildMentionInsert(
  ref: ContextRefPayload,
  atPos: number,
  cursorPos: number,
  fullText: string,
): { newText: string; cursorAfter: number } {
  const replacement = `@${ref.alias} `;
  const newText = fullText.slice(0, atPos) + replacement + fullText.slice(cursorPos);
  const cursorAfter = atPos + replacement.length;
  return { newText, cursorAfter };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function hasMentionStartBoundary(text: string, atPos: number): boolean {
  return atPos === 0 || /\s/.test(text[atPos - 1]!);
}

function hasMentionEndBoundary(text: string, afterAliasPos: number): boolean {
  return afterAliasPos >= text.length || MENTION_END_RE.test(text[afterAliasPos]!);
}

function findMentionIndex(text: string, ref: ContextRefPayload): number {
  const label = `@${ref.alias}`;
  let atPos = text.indexOf(label);

  while (atPos !== -1) {
    if (
      hasMentionStartBoundary(text, atPos) &&
      hasMentionEndBoundary(text, atPos + label.length)
    ) {
      return atPos;
    }
    atPos = text.indexOf(label, atPos + 1);
  }

  return -1;
}

function matchMentionAt(
  text: string,
  atPos: number,
  refs: ContextRefPayload[],
): ContextRefPayload | null {
  if (!hasMentionStartBoundary(text, atPos)) return null;
  const body = text.slice(atPos + 1);
  let best: ContextRefPayload | null = null;

  for (const ref of refs) {
    if (!ref.alias || !body.startsWith(ref.alias)) continue;
    const afterAliasPos = atPos + 1 + ref.alias.length;
    if (!hasMentionEndBoundary(text, afterAliasPos)) continue;
    if (!best || ref.alias.length > best.alias.length) {
      best = ref;
    }
  }

  return best;
}

export function isRefMentioned(text: string, ref: ContextRefPayload): boolean {
  return findMentionIndex(text, ref) !== -1;
}

export function resolveInlineMentions(
  text: string,
  refs: ContextRefPayload[],
  mentionPaths: string[] = [],
): ContextRefPayload[] {
  const byPath = new Map(refs.map((r) => [normalizePath(r.path), r] as const));
  const matches: Array<{ index: number; ref: ContextRefPayload }> = [];
  const seen = new Set<string>();
  const selectedMentionStarts = new Set<number>();

  for (const path of mentionPaths) {
    const ref = byPath.get(normalizePath(path));
    if (!ref) continue;
    const index = findMentionIndex(text, ref);
    const key = normalizePath(ref.path);
    if (index !== -1 && !seen.has(key)) {
      seen.add(key);
      selectedMentionStarts.add(index);
      matches.push({ index, ref });
    }
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (selectedMentionStarts.has(i)) continue;
    const ref = matchMentionAt(text, i, refs);
    if (!ref) continue;
    const key = normalizePath(ref.path);
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ index: i, ref });
  }

  return matches.sort((a, b) => a.index - b.index).map((m) => m.ref);
}

export function validateMentionPaths(
  text: string,
  refs: ContextRefPayload[],
  mentionPaths: string[],
): string[] {
  const refMap = new Map(refs.map((r) => [r.path, r] as const));

  return mentionPaths.filter((path) => {
    const ref = refMap.get(path);
    if (!ref) return false;
    return isRefMentioned(text, ref);
  });
}

/** Walk a contenteditable root into the plain-text @alias string the send
 *  pipeline (resolveInlineMentions) consumes. Chips contribute their full
 *  data-alias, not their (CSS-truncated) visible label. */
export function serializeEditor(root: Node): string {
  let out = "";
  for (const node of Array.from(root.childNodes)) {
    out += serializeNode(node);
  }
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const el = node as HTMLElement;
  if (el.tagName === "BR") {
    return "\n";
  }
  if (el.classList.contains("mc-chip")) {
    return `@${el.getAttribute("data-alias") ?? ""}`;
  }
  let inner = "";
  for (const child of Array.from(el.childNodes)) {
    inner += serializeNode(child);
  }
  return inner;
}
