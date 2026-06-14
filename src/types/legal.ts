/** UI text segments for inline formatting in document preview */

export interface TextSegment {
  t?: string;
  b?: string;
  cite?: string;
  risk?: boolean;
  accent?: boolean;
}

export interface DocParty {
  lbl: string;
  name: string;
  extra?: string;
}

export interface ArticleNote {
  title: string;
  body: TextSegment[];
}

export type ArticleBlock =
  | { kind: "para"; segments: TextSegment[] }
  | { kind: "table"; markdown: string };

export interface Article {
  id: string;
  title: string;
  added?: boolean;
  paras: TextSegment[][];
  /** Mixed prose + GFM tables — preferred for preview when present. */
  blocks?: ArticleBlock[];
  note?: ArticleNote;
}

export type CitationVerification = "verified" | "retrieved" | "unverified";

export interface CitationCard {
  key: string;
  tag: string;
  title: string;
  src: string;
  text: string;
  rel: TextSegment[];
  clauseId?: string;
  /** 核验状态：verified=本地库逐字核验 retrieved=本轮检索命中 unverified=待律师复核 */
  verified?: CitationVerification;
  /** 来源层级标签，如 L1-法规（本地库）/ L2-入库 */
  tier?: string;
  /** 核验备注（时效警示、未命中原因等） */
  note?: string;
}

/** Mirrors the backend citations::CitationAuditItem. */
export interface CitationAuditItem {
  kind: "law" | "interpretation" | "case";
  source: string;
  reference: string;
  status: CitationVerification;
  tier?: string;
  excerpt?: string;
  url?: string;
  note?: string;
}

/** Mirrors the backend citations::CitationAudit (trace event + metadata). */
export interface CitationAudit {
  items: CitationAuditItem[];
  total: number;
  verified: number;
  retrieved: number;
  unverified: number;
}

export interface DocMeta {
  title: string;
  en: string;
  parties: DocParty[];
  recital: TextSegment[];
}

/** Mirrors backend LegalDocumentModel (src-tauri/src/documents/types.rs) */

export interface LegalCitation {
  source: string;
  reference: string;
  excerpt?: string;
  url?: string;
}

export interface LegalParty {
  name: string;
  role?: string;
  details?: string;
}

export interface LegalClause {
  id: string;
  title?: string;
  text: string;
  risk_level?: string;
  citations?: LegalCitation[];
}

export interface LegalSection {
  id?: string;
  heading?: string;
  content: string;
  clauses?: LegalClause[];
}

export interface LegalDocumentModel {
  title: string;
  document_type?: string;
  parties?: LegalParty[];
  sections: LegalSection[];
  citations?: LegalCitation[];
  disclaimers?: string[];
  metadata?: unknown;
}

export interface ParseLegalDocumentResponse {
  document: LegalDocumentModel;
  markdown: string;
  document_id: string | null;
}

export interface CitationGroups {
  law: CitationCard[];
  case: CitationCard[];
}
