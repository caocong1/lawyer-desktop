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

export interface Article {
  id: string;
  title: string;
  added?: boolean;
  paras: TextSegment[][];
  note?: ArticleNote;
}

export interface CitationCard {
  key: string;
  tag: string;
  title: string;
  src: string;
  text: string;
  rel: TextSegment[];
  clauseId?: string;
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
