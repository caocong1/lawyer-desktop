import type {
  Article,
  ArticleBlock,
  ArticleNote,
  CitationCard,
  CitationGroups,
  DocMeta,
  DocParty,
  LegalCitation,
  LegalDocumentModel,
  TextSegment,
} from "../types/legal";

const CASE_PATTERN = /判例|案例|裁定|判决|案号|人民法院|最高法|高院/;

/** 中文数字（条序） */
export function cnNum(n: number): string {
  return "一二三四五六七八九十".charAt(n - 1) || String(n);
}

export function extractLegalDocumentJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const candidate = fenceMatch[1].trim();
    if (looksLikeLegalDocument(candidate)) return candidate;
  }

  const start = trimmed.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        if (looksLikeLegalDocument(slice)) return slice;
      }
    }
  }

  return null;
}

function looksLikeLegalDocument(json: string): boolean {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return typeof obj.title === "string" && Array.isArray(obj.sections);
  } catch {
    return false;
  }
}

function isCaseCitation(c: LegalCitation): boolean {
  return CASE_PATTERN.test(`${c.source}${c.reference}`);
}

function riskNote(level: string | undefined): ArticleNote | undefined {
  if (!level || level === "low" || level === "none") return undefined;
  const label =
    level === "high" ? "高风险条款" : level === "medium" ? "需关注条款" : "风险提示";
  return {
    title: label,
    body: [{ t: `该条款风险等级为「${level}」，建议审阅并补充保障措施。` }],
  };
}

function stripMarkdownLineNoise(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function stripMarkdownInlineNoise(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[*-]\s+/, "")
    .trim();
}

function textToSegments(text: string): TextSegment[] {
  const t = stripMarkdownInlineNoise(text.trim());
  if (!t) return [];

  const segments: TextSegment[] = [];
  const boldRe = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of t.matchAll(boldRe)) {
    const index = match.index ?? 0;
    const plain = t.slice(last, index);
    if (plain) segments.push({ t: plain });
    if (match[1]) segments.push({ b: match[1].trim() });
    last = index + match[0].length;
  }
  const tail = t.slice(last);
  if (tail) segments.push({ t: tail });
  return segments.length > 0 ? segments : [{ t }];
}

function isHorizontalRule(line: string): boolean {
  return /^-{3,}$|^\*{3,}$|^_{3,}$/.test(line.trim());
}

const MARKDOWN_TABLE_LINE_RE = /^\s*\|.+\|\s*$/;
const MARKDOWN_TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return MARKDOWN_TABLE_LINE_RE.test(trimmed) || MARKDOWN_TABLE_SEP_RE.test(trimmed);
}

/** Split section body into prose runs and GFM table blocks. */
export function splitMarkdownBlocks(
  content: string,
): Array<{ kind: "prose"; text: string } | { kind: "table"; markdown: string }> {
  const blocks: Array<
    { kind: "prose"; text: string } | { kind: "table"; markdown: string }
  > = [];
  let proseBuf: string[] = [];
  let tableBuf: string[] = [];

  const flushProse = () => {
    const text = proseBuf.join("\n").trim();
    if (text) blocks.push({ kind: "prose", text });
    proseBuf = [];
  };
  const flushTable = () => {
    const markdown = tableBuf.join("\n").trim();
    if (markdown) blocks.push({ kind: "table", markdown });
    tableBuf = [];
  };

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) {
      if (tableBuf.length) flushTable();
      else if (proseBuf.length) proseBuf.push("");
      continue;
    }
    if (isMarkdownTableLine(raw)) {
      if (proseBuf.length) flushProse();
      tableBuf.push(raw.trimEnd());
    } else {
      if (tableBuf.length) flushTable();
      proseBuf.push(raw);
    }
  }
  flushTable();
  flushProse();
  return blocks;
}

function articleBlocksFromContent(content: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  for (const block of splitMarkdownBlocks(content)) {
    if (block.kind === "table") {
      blocks.push({ kind: "table", markdown: block.markdown });
      continue;
    }
    for (const para of textToParagraphs(block.text)) {
      if (para.length) blocks.push({ kind: "para", segments: para });
    }
  }
  return blocks;
}

function isParagraphStart(line: string): boolean {
  return (
    /^(?:[一二三四五六七八九十百零\d]+[、.．]|[（(][一二三四五六七八九十百零\d]+[）)]|第[一二三四五六七八九十百零\d]+[章节条款])/.test(line) ||
    /^(原告|被告|甲方|乙方|上诉人|被上诉人|申请人|被申请人|委托人|受托人|代理人|具状人|此致)[：:\s]/.test(line)
  );
}

function textToParagraphs(text: string): TextSegment[][] {
  const paras: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const para = current.join(" ").replace(/\s+/g, " ").trim();
    if (para) paras.push(para);
    current = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarkdownLineNoise(raw);
    if (!line || isHorizontalRule(line)) {
      flush();
      continue;
    }
    if (current.length > 0 && isParagraphStart(line)) {
      flush();
    }
    current.push(line);
  }
  flush();

  const segments = paras.map(textToSegments).filter((para) => para.length > 0);
  return segments.length > 0 ? segments : [textToSegments(text)].filter((para) => para.length > 0);
}

export function modelToParties(model: LegalDocumentModel): DocParty[] {
  return (model.parties ?? []).map((p) => ({
    lbl: `${p.role ?? "当事人"}：`,
    name: p.name,
    extra: p.details,
  }));
}

export function modelToRecital(model: LegalDocumentModel): TextSegment[] {
  const recitalSection = model.sections.find(
    (s) =>
      s.heading?.includes("鉴于") ||
      s.heading?.includes("前言") ||
      s.id === "recital",
  );
  if (recitalSection?.content) {
    return textToSegments(recitalSection.content);
  }

  return [];
}

export function modelToArticles(model: LegalDocumentModel): Article[] {
  const articles: Article[] = [];

  for (const section of model.sections) {
    if (section.clauses?.length) {
      for (const clause of section.clauses) {
        const blocks = articleBlocksFromContent(clause.text);
        articles.push({
          id: clause.id,
          title: normalizedArticleTitle(clause.title ?? section.heading ?? clause.id),
          paras: blocks
            .filter((b): b is { kind: "para"; segments: TextSegment[] } => b.kind === "para")
            .map((b) => b.segments),
          blocks: blocks.length > 0 ? blocks : undefined,
          note: riskNote(clause.risk_level),
        });
      }
    } else if (section.content.trim()) {
      const skipRecital =
        section.heading?.includes("鉴于") || section.heading?.includes("前言");
      if (!skipRecital) {
        const blocks = articleBlocksFromContent(section.content);
        articles.push({
          id: section.id ?? `section-${articles.length + 1}`,
          title: normalizedArticleTitle(section.heading ?? `第${cnNum(articles.length + 1)}条`),
          paras: blocks
            .filter((b): b is { kind: "para"; segments: TextSegment[] } => b.kind === "para")
            .map((b) => b.segments),
          blocks: blocks.length > 0 ? blocks : undefined,
        });
      }
    }
  }

  return articles;
}

function citationToCard(
  c: LegalCitation,
  key: string,
  clauseId?: string,
): CitationCard {
  return {
    key,
    tag: c.source,
    title: c.reference,
    src: c.url ?? c.source,
    text: c.excerpt ?? c.reference,
    rel: textToSegments(c.excerpt ?? c.reference),
    clauseId,
  };
}

export function modelToCitationGroups(model: LegalDocumentModel): CitationGroups {
  const law: CitationCard[] = [];
  const caseList: CitationCard[] = [];
  let idx = 0;

  const push = (c: LegalCitation, clauseId?: string) => {
    const key = isCaseCitation(c) ? `case${++idx}` : `law${++idx}`;
    const card = citationToCard(c, key, clauseId);
    if (isCaseCitation(c)) caseList.push(card);
    else law.push(card);
  };

  for (const c of model.citations ?? []) {
    push(c);
  }

  for (const section of model.sections) {
    for (const clause of section.clauses ?? []) {
      for (const c of clause.citations ?? []) {
        push(c, clause.id);
      }
    }
  }

  return { law, case: caseList };
}

export function modelToDocMeta(model: LegalDocumentModel): DocMeta {
  return {
    title: model.title,
    en: model.document_type ?? "",
    parties: modelToParties(model),
    recital: modelToRecital(model),
  };
}

const CHAT_SUMMARY_MARKER = "正文见右侧文书预览";

const TOOL_LEAK_RE =
  /<\/?tool_calls?>|\btool_?c(?:alls?)?\b\s*>?|<\/?_calls?>|<\s*name\s*=|<\/?invoke\b|\binvoke\s*(?:name\s*=|=|>)|\bparameter\s+name(?:\s*=|\s+[^\s=>]+)|toolalls|function_call|<\|[^|]+\|>|\|\s*\|\s*DSML|DSML/i;

const INSTRUCTION_TITLE_RE = /^(写一份|起草|生成|帮我|请)/;

const PARTY_LINE_RE =
  /^(原告|被告|甲方|乙方|上诉人|被上诉人|申请人|被申请人|委托人|受托人|代理人)[^：:\n]*[：:]\s*(.+)$/;

const SECTION_HEADING_RE =
  /^(使用说明|当事人|诉讼请求|事实与理由|事实和理由|证据与附件目录|证据和证据来源|证据目录|附件目录|法律依据|风险提示|律师意见|请求事项|仲裁请求|答辩意见|此致|具状人|落款)$/;

const NUMBERED_ARTICLE_RE = /^第[一二三四五六七八九十百零\d]+[条章节款][、.．：:\s]*(.*)$/;

/** Generic draft output contract — industry-agnostic envelope from the agent. */
export interface DraftOutputEnvelope {
  /** Left chat bubble: process notes, research, citations summary, etc. */
  assistantMarkdown: string;
  /** Structured document JSON when the model followed the envelope contract. */
  documentJson: string | null;
  /** Legacy plain-markdown document body for right-side preview fallback. */
  documentMarkdown: string;
  /** True when the reply contained an explicit assistant_notes + document envelope. */
  hasEnvelope: boolean;
}

function looksLikeDraftEnvelope(obj: Record<string, unknown>): boolean {
  const doc = obj.document;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const d = doc as Record<string, unknown>;
  return typeof d.title === "string" && Array.isArray(d.sections);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenceMatch?.[1] ? [fenceMatch[1].trim(), trimmed] : [trimmed];

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    if (start === -1) continue;

    let depth = 0;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>;
            if (obj && typeof obj === "object") return obj;
          } catch {
            /* try next slice */
          }
        }
      }
    }
  }

  return null;
}

/** Parse the generic draft envelope; legacy plain markdown/JSON falls back gracefully. */
export function extractDraftOutputEnvelope(text: string): DraftOutputEnvelope {
  const cleaned = sanitizeLlmDocumentContent(text);
  if (!cleaned) {
    return {
      assistantMarkdown: "",
      documentJson: null,
      documentMarkdown: "",
      hasEnvelope: false,
    };
  }

  const obj = extractJsonObject(cleaned);
  if (obj && looksLikeDraftEnvelope(obj)) {
    const notes =
      typeof obj.assistant_notes === "string"
        ? obj.assistant_notes.trim()
        : typeof obj.assistantNotes === "string"
          ? obj.assistantNotes.trim()
          : "";
    const documentJson = JSON.stringify(obj.document);
    return {
      assistantMarkdown: notes,
      documentJson,
      documentMarkdown: "",
      hasEnvelope: true,
    };
  }

  const legacyJson = extractLegalDocumentJson(cleaned);
  if (legacyJson) {
    return {
      assistantMarkdown: "",
      documentJson: legacyJson,
      documentMarkdown: "",
      hasEnvelope: false,
    };
  }

  return {
    assistantMarkdown: "",
    documentJson: null,
    documentMarkdown: cleaned,
    hasEnvelope: false,
  };
}

/** Model sometimes leaks tool-call markup into plain text — never show as document body. */
export function containsToolLeakage(text: string): boolean {
  return TOOL_LEAK_RE.test(text);
}

export function isInstructionLikeTitle(title: string): boolean {
  const t = title.trim();
  return !t || INSTRUCTION_TITLE_RE.test(t);
}

/** Strip tool XML, planning steps, and other non-document noise from LLM output. */
export function sanitizeLlmDocumentContent(text: string): string {
  let s = text.trim();
  if (!s) return "";

  s = s.replace(/<\|[^|>]*\|>/g, "");
  s = s.replace(/\|\s*\|\s*DSML\s*\|\s*\|/gi, "");
  s = s.replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, "");
  s = s.replace(/<?tool_?c(?:alls?)?[^>\n]*>[\s\S]*?<\/?_calls?>/gi, "");
  s = s.replace(/<invoke[\s\S]*?<\/invoke>/gi, "");
  s = s.replace(/<invoke[\s\S]*?(?=<invoke|$)/gi, "");
  s = s.replace(/```[\s\S]*?```/g, (block) =>
    TOOL_LEAK_RE.test(block) ? "" : block,
  );
  s = s.replace(/^#{1,3}\s*第[一二三四五六七八九十\d]+步[^\n]*\n?/gm, "");
  s = s.replace(
    /^.*(?:DSML|tool_?c(?:alls?)?|<\/?_calls?>|<\s*name\s*=|toolalls|parameter\s+name(?:\s*=|\s+[^\s=>]+)|invoke\s*(?:name\s*=|=|>)|function_call|<\|)[^\n]*\n?/gim,
    "",
  );
  // Only strip known tool-leak XML tags, not legitimate HTML in legal docs.
  s = s.replace(/<\/?(?:tool_calls?|_calls?|invoke|parameter|function_call|dsml)[^>\n]*>/gi, "");

  return s.replace(/\n{3,}/g, "\n\n").trim();
}

export function looksLikeLegalProse(text: string): boolean {
  const markers = text.match(
    /甲方|乙方|合同|协议|租赁|承租|出租|条款|鉴于|双方|违约责任|起诉状|答辩状|上诉状|申请书|律师函|代理词|原告|被告|诉讼请求|事实与理由|证据|此致|人民法院|仲裁|保全|执行/g,
  );
  if ((markers?.length ?? 0) >= 2) return true;
  const clauses = text.match(/第[一二三四五六七八九十百零\d]+条/g);
  return (clauses?.length ?? 0) >= 2;
}

export function isPublishableDocument(text: string): boolean {
  const envelope = extractDraftOutputEnvelope(text);
  if (envelope.documentJson) return true;
  const cleaned = envelope.documentMarkdown;
  if (cleaned.length < 120) return false;
  if (containsToolLeakage(cleaned)) return false;
  if (extractLegalDocumentJson(cleaned)) return true;
  return looksLikeLegalProse(cleaned);
}

function inferDocumentTitle(md: string, fallbackTitle?: string): string {
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();

  const firstTitle = normalizeMarkdownLines(md)
    .map(cleanHeading)
    .find(
      (line) =>
        line.length >= 2 &&
        line.length <= 40 &&
        /(?:起诉状|答辩状|上诉状|申请书|律师函|代理词|合同|协议|报告)$/.test(line),
    );
  if (firstTitle) return firstTitle;

  const book = md.match(/[《]([^》]+)[》]/);
  if (book) return book[1].trim();

  const contract = md.match(/(.{2,24}(?:合同|协议))/);
  if (contract) return contract[1].trim();

  const fb = fallbackTitle?.trim();
  if (fb && !isInstructionLikeTitle(fb)) return fb;

  return "法律文书";
}

function cleanHeading(raw: string): string {
  return stripMarkdownInlineNoise(stripMarkdownLineNoise(raw))
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^[一二三四五六七八九十百零\d]+[、.．]\s*/, "")
    .trim();
}

function normalizedArticleTitle(title: string): string {
  const clean = cleanHeading(title);
  const numbered = clean.match(NUMBERED_ARTICLE_RE);
  return (numbered?.[1]?.trim() || clean || "正文").replace(/^正文[：:]\s*/, "") || "正文";
}

function normalizeMarkdownLines(md: string): string[] {
  return md
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !isHorizontalRule(stripMarkdownLineNoise(line)));
}

function isDocumentTitleLine(line: string, title: string): boolean {
  const clean = cleanHeading(line);
  return !!clean && clean === title;
}

function headingFromLine(line: string, title: string): string | null {
  const clean = cleanHeading(line);
  if (!clean || clean === title) return null;
  if (/^#{1,6}\s+/.test(line.trim())) return normalizedArticleTitle(clean);
  const numbered = clean.match(NUMBERED_ARTICLE_RE);
  if (numbered) return normalizedArticleTitle(clean);
  if (SECTION_HEADING_RE.test(clean)) return clean;
  return null;
}

function inlineHeadingFromLine(
  line: string,
): { heading: string; content: string } | null {
  const clean = stripMarkdownLineNoise(line);
  const match = clean.match(/^\*?\*?(使用说明|风险提示|律师意见|法律依据)\*?\*?[：:]\s*(.+)$/);
  if (!match) return null;
  return {
    heading: match[1],
    content: match[2].trim(),
  };
}

function partyFromLine(
  line: string,
): NonNullable<LegalDocumentModel["parties"]>[number] | null {
  const clean = stripMarkdownLineNoise(line);
  const match = clean.match(PARTY_LINE_RE);
  if (!match) return null;
  const role = match[1];
  const rest = stripMarkdownInlineNoise(match[2]);
  const [nameRaw, ...details] = rest.split(/[，,]/);
  const name = nameRaw.trim();
  if (!name) return null;
  return {
    role,
    name,
    details: details.join("，").trim() || undefined,
  };
}

function sectionsFromMarkdownBody(
  lines: string[],
  title: string,
): LegalDocumentModel["sections"] {
  const sections: LegalDocumentModel["sections"] = [];
  let heading = "正文";
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) {
      sections.push({
        id: `section-${sections.length + 1}`,
        heading: normalizedArticleTitle(heading),
        content,
      });
    }
    buffer = [];
  };

  for (const raw of lines) {
    if (isDocumentTitleLine(raw, title)) continue;
    const clean = stripMarkdownLineNoise(raw);
    if (!clean) {
      buffer.push("");
      continue;
    }
    const nextHeading = headingFromLine(raw, title);
    if (nextHeading) {
      flush();
      heading = nextHeading;
      continue;
    }
    const inlineHeading = inlineHeadingFromLine(raw);
    if (inlineHeading) {
      flush();
      heading = inlineHeading.heading;
      buffer.push(inlineHeading.content);
      continue;
    }
    if (partyFromLine(clean)) continue;
    buffer.push(clean);
  }
  flush();

  return sections.length > 0
    ? sections
    : [
        {
          id: "body",
          heading: "正文",
          content: lines.map(stripMarkdownLineNoise).join("\n").trim(),
        },
      ];
}

/** Drop process narration before the first H1 — evidence reports must start at their title. */
export function stripReportPreamble(markdown: string): string {
  const match = markdown.match(/^#\s+.+$/m);
  if (!match || match.index === undefined || match.index === 0) return markdown;
  return markdown.slice(match.index).trimStart();
}

/** Display title for a markdown evidence report (first H1, else the mode label). */
export function markdownReportTitle(markdown: string, fallbackLabel?: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  if (h1) {
    const title = cleanHeading(h1[1]);
    if (title) return title;
  }
  const fb = fallbackLabel?.trim();
  if (fb && !isInstructionLikeTitle(fb)) return fb;
  return "案卷分析报告";
}

/** Build a preview model from plain-markdown LLM output when JSON is absent. */
export function markdownToLegalDocument(
  text: string,
  fallbackTitle?: string,
): LegalDocumentModel | null {
  const md = sanitizeLlmDocumentContent(text);
  if (md.length < 120 || md.includes(CHAT_SUMMARY_MARKER)) return null;
  if (containsToolLeakage(md) || !looksLikeLegalProse(md)) return null;

  const title = inferDocumentTitle(md, fallbackTitle);

  const parties: LegalDocumentModel["parties"] = [];
  const lines = normalizeMarkdownLines(md);
  for (const line of lines) {
    const party = partyFromLine(line);
    if (party) parties.push(party);
  }

  const sections = sectionsFromMarkdownBody(lines, title);

  return {
    title,
    parties: parties.length > 0 ? parties : undefined,
    sections,
  };
}
