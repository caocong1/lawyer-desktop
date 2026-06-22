import type { ContextRefPayload } from "../types/contextRefs";
import { resolveInlineMentions } from "./mentions";

export interface UserAttachmentCard {
  alias: string;
  kind: ContextRefPayload["kind"];
  path?: string;
  typeLabel: string;
  tone: "pdf" | "doc" | "folder" | "file";
}

export interface UserMessageParts {
  text: string;
  attachments: UserAttachmentCard[];
}

export function selectContextRefsForSend(
  text: string,
  refs: ContextRefPayload[],
  mentionPaths: string[] = [],
): ContextRefPayload[] {
  const inlineRefs = resolveInlineMentions(text.trim(), refs, mentionPaths);
  return inlineRefs.length > 0 ? inlineRefs : refs;
}

export function canSendWithContext(
  text: string,
  refs: readonly ContextRefPayload[],
  sending: boolean,
): boolean {
  return !sending && (text.trim().length > 0 || refs.length > 0);
}

function contextRefKindLabel(kind: ContextRefPayload["kind"] | string): string {
  return kind === "directory" || kind === "目录" ? "目录" : "文件";
}

function formatContextRefToken(ref: Pick<ContextRefPayload, "alias" | "kind">): string {
  return `@${ref.alias}（${contextRefKindLabel(ref.kind)}）`;
}

function contextRefSummary(refs: readonly Pick<ContextRefPayload, "alias" | "kind">[]): string {
  if (refs.length === 0) return "";
  return `已附加 ${refs.length} 项本地资料：${refs.map(formatContextRefToken).join("、")}`;
}

const CONTEXT_MARKER_RE = /(?:^|\n)---\s*上下文引用\s*---\s*(?:\n|$)/;

function parsePersistedContextRefs(
  block: string,
): Array<Pick<ContextRefPayload, "alias" | "kind" | "path">> {
  const refs: Array<Pick<ContextRefPayload, "alias" | "kind" | "path">> = [];
  const re = /^@(.+?)\s+\((文件|目录|未知类型):\s*([^)]+)\)/gm;
  for (const match of block.matchAll(re)) {
    const alias = match[1]?.trim();
    if (!alias) continue;
    refs.push({
      alias,
      kind: match[2] === "目录" ? "directory" : "file",
      path: match[3]?.trim() ?? "",
    });
  }
  return refs;
}

function splitPersistedContextBlock(content: string): {
  text: string;
  refs: Array<Pick<ContextRefPayload, "alias" | "kind" | "path">>;
} {
  const body = content.trim();
  const marker = body.match(CONTEXT_MARKER_RE);
  if (!marker || marker.index === undefined) return { text: body, refs: [] };

  const before = body.slice(0, marker.index).trim();
  const after = body.slice(marker.index + marker[0].length);
  return { text: before, refs: parsePersistedContextRefs(after) };
}

function fileExtension(value: string | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  const match = v.match(/\.([a-z0-9]+)(?:$|[?#])/);
  return match?.[1] ?? "";
}

function attachmentCardFromRef(
  ref: Pick<ContextRefPayload, "alias" | "kind"> & Partial<Pick<ContextRefPayload, "path">>,
): UserAttachmentCard {
  if (ref.kind === "directory") {
    return {
      alias: ref.alias,
      kind: "directory",
      path: ref.path,
      typeLabel: "文件夹",
      tone: "folder",
    };
  }

  const ext = fileExtension(ref.path) || fileExtension(ref.alias);
  if (ext === "pdf") {
    return { ...ref, kind: "file", typeLabel: "PDF", tone: "pdf" };
  }
  if (ext === "doc" || ext === "docx") {
    return { ...ref, kind: "file", typeLabel: "Word", tone: "doc" };
  }
  return { ...ref, kind: "file", typeLabel: "文档", tone: "file" };
}

export function userMessageParts(
  content: string,
  refs?: readonly ContextRefPayload[],
): UserMessageParts {
  const text = content.trim();
  if (refs && refs.length > 0) {
    return {
      text,
      attachments: refs.map(attachmentCardFromRef),
    };
  }

  const parsed = splitPersistedContextBlock(text);
  return {
    text: parsed.text,
    attachments: parsed.refs.map(attachmentCardFromRef),
  };
}

export function formatUserMessageContentForStorage(
  content: string,
  refs: readonly ContextRefPayload[],
): string {
  const body = content.trim();
  if (refs.length === 0) return body;

  const lines = refs.map(
    (ref) => `@${ref.alias} (${contextRefKindLabel(ref.kind)}: ${ref.path})`,
  );
  return [body, "--- 上下文引用 ---", ...lines].filter(Boolean).join("\n\n");
}

export function formatUserVisibleContent(
  content: string,
  refs?: readonly ContextRefPayload[],
): string {
  const body = content.trim();
  if (refs && refs.length > 0) {
    const summary = contextRefSummary(refs);
    return body ? `${body}\n\n${summary}` : summary;
  }

  const parsed = splitPersistedContextBlock(body);
  const summary = contextRefSummary(parsed.refs);
  if (!summary) return parsed.text;
  return parsed.text ? `${parsed.text}\n\n${summary}` : summary;
}
