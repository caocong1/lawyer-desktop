import type {
  Article,
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

function textToSegments(text: string): TextSegment[] {
  const t = text.trim();
  return t ? [{ t }] : [];
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

  const first = model.sections[0];
  if (first && !first.clauses?.length && first.content) {
    return textToSegments(first.content);
  }

  return [];
}

export function modelToArticles(model: LegalDocumentModel): Article[] {
  const articles: Article[] = [];

  for (const section of model.sections) {
    if (section.clauses?.length) {
      for (const clause of section.clauses) {
        articles.push({
          id: clause.id,
          title: clause.title ?? section.heading ?? clause.id,
          paras: [textToSegments(clause.text)],
          note: riskNote(clause.risk_level),
        });
      }
    } else if (section.content.trim()) {
      const skipRecital =
        section.heading?.includes("鉴于") || section.heading?.includes("前言");
      if (!skipRecital) {
        articles.push({
          id: section.id ?? `section-${articles.length + 1}`,
          title: section.heading ?? `第${cnNum(articles.length + 1)}条`,
          paras: [textToSegments(section.content)],
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
  /<\/?tool_calls?>|<\/?invoke|invoke\s+name\s*=|parameter\s+name\s*=|toolalls|function_call|<\|[^|]+\|>|\|\s*\|\s*DSML|DSML/i;

const INSTRUCTION_TITLE_RE = /^(写一份|起草|生成|帮我|请)/;

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
  s = s.replace(/<invoke[\s\S]*?<\/invoke>/gi, "");
  s = s.replace(/<invoke[\s\S]*?(?=<invoke|$)/gi, "");
  s = s.replace(/```[\s\S]*?```/g, (block) =>
    TOOL_LEAK_RE.test(block) ? "" : block,
  );
  s = s.replace(/^#{1,3}\s*第[一二三四五六七八九十\d]+步[^\n]*\n?/gm, "");
  s = s.replace(/^.*(?:DSML|toolalls|parameter\s+name\s*=|invoke\s+name\s*=|<\|)[^\n]*\n?/gim, "");
  s = s.replace(/<\/?[a-zA-Z_:][^>\n]*>/g, "");
  s = s.replace(/\|\|+/g, "|");

  return s.replace(/\n{3,}/g, "\n\n").trim();
}

export function looksLikeLegalProse(text: string): boolean {
  const markers = text.match(/甲方|乙方|合同|协议|租赁|承租|出租|条款|鉴于|双方|违约责任/g);
  if ((markers?.length ?? 0) >= 2) return true;
  const clauses = text.match(/第[一二三四五六七八九十百零\d]+条/g);
  return (clauses?.length ?? 0) >= 2;
}

export function isPublishableDocument(text: string): boolean {
  const cleaned = sanitizeLlmDocumentContent(text);
  if (cleaned.length < 120) return false;
  if (containsToolLeakage(cleaned)) return false;
  if (extractLegalDocumentJson(cleaned)) return true;
  return looksLikeLegalProse(cleaned);
}

function inferDocumentTitle(md: string, fallbackTitle?: string): string {
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();

  const book = md.match(/[《]([^》]+)[》]/);
  if (book) return book[1].trim();

  const contract = md.match(/(.{2,24}(?:合同|协议))/);
  if (contract) return contract[1].trim();

  const fb = fallbackTitle?.trim();
  if (fb && !isInstructionLikeTitle(fb)) return fb;

  return "法律文书";
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
  for (const line of md.split("\n")) {
    const m = line.match(/^\*?\*?(甲方|乙方)[^*：:\n]*\*?\*?[：:]\s*(.+)/);
    if (m) {
      parties.push({
        role: m[1],
        name: m[2].replace(/\*+/g, "").trim(),
      });
    }
  }

  let body = md;
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) body = md.replace(/^#\s+.+\n*/m, "").trim();

  const clauseParts = body.split(
    /(?=^#{1,3}\s+第|^第[一二三四五六七八九十百零\d]+条)/m,
  );

  const sections: LegalDocumentModel["sections"] = [];

  if (clauseParts.length > 1) {
    const preamble = clauseParts[0].trim();
    if (preamble) {
      sections.push({ id: "recital", heading: "鉴于", content: preamble });
    }
    for (const part of clauseParts.slice(1)) {
      const lines = part.trim().split("\n");
      const heading = lines[0]?.replace(/^#+\s*/, "").trim() || "条款";
      const content = lines.slice(1).join("\n").trim() || part.trim();
      sections.push({
        id: `clause-${sections.length}`,
        heading,
        content,
        clauses: [{ id: `c-${sections.length}`, title: heading, text: content }],
      });
    }
  } else {
    sections.push({
      id: "body",
      heading: "正文",
      content: body,
      clauses: [{ id: "c-1", title: "正文", text: body }],
    });
  }

  return {
    title,
    parties: parties.length > 0 ? parties : undefined,
    sections,
  };
}
