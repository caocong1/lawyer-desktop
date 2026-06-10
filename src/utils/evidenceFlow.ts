import type { ContextRefPayload } from "../types/contextRefs";

/** Windows absolute path (allows CJK segments). */
const WIN_PATH_RE = /[A-Za-z]:[\\/](?:[^\s\n<>:"|?*，。；]+[\\/])*[^\s\n<>:"|?*，。；]+/g;

export function extractDirectoryPaths(text: string): string[] {
  const raw = text.match(WIN_PATH_RE) ?? [];
  const cleaned = raw.map((p) => p.replace(/[，。；,.]+$/u, "").trim());
  return [...new Set(cleaned.filter((p) => p.length >= 3))];
}

export function pathToRefAlias(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segment = normalized.split("/").filter(Boolean).pop() ?? path;
  return segment;
}

/** Merge @ chips with directory paths pasted inline in the user message. */
export function mergeDirectoryRefs(
  text: string,
  existing: ContextRefPayload[],
): ContextRefPayload[] {
  const seen = new Set(existing.map((r) => r.path.replace(/\\/g, "/").toLowerCase()));
  const merged = [...existing];

  for (const path of extractDirectoryPaths(text)) {
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      alias: pathToRefAlias(path),
      path,
      kind: "directory",
    });
  }

  return merged;
}
