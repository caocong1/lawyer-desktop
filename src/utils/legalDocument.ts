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
