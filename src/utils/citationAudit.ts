import type {
  CitationAudit,
  CitationAuditItem,
  CitationCard,
  CitationGroups,
} from "../types/legal";

function itemTitle(item: CitationAuditItem): string {
  if (item.kind === "case") return item.reference;
  if (!item.source) return item.reference;
  return `《${item.source}》${item.reference}`;
}

function itemTag(item: CitationAuditItem): string {
  if (item.kind === "case") return "案例";
  if (item.kind === "interpretation") return item.source || "司法解释/法规文号";
  return item.source || "法条";
}

function itemToCard(item: CitationAuditItem, key: string): CitationCard {
  const text =
    item.excerpt ??
    item.note ??
    (item.status === "unverified" ? "未核验，引用前请人工复核条文原文。" : "");
  return {
    key,
    tag: itemTag(item),
    title: itemTitle(item),
    src: item.url || (item.status === "verified" ? "本地法规库" : "未核验来源"),
    text,
    rel: text ? [{ t: text }] : [],
    verified: item.status,
    tier: item.tier,
    note: item.note,
  };
}

/** Build CitationGroups for markdown evidence reports (no structured model). */
export function auditToCitationGroups(audit: CitationAudit): CitationGroups {
  const law: CitationCard[] = [];
  const caseList: CitationCard[] = [];
  for (const item of audit.items) {
    if (item.kind === "case") {
      caseList.push(itemToCard(item, `case${caseList.length + 1}`));
    } else {
      law.push(itemToCard(item, `law${law.length + 1}`));
    }
  }
  return { law, case: caseList };
}

function normalizeRef(s: string): string {
  return s.replace(/[《》\s（）()]/g, "");
}

/** Attach verification badges to existing structured-document citation cards
 *  by (source, reference) match; audit items with no matching card are appended. */
export function mergeAuditIntoGroups(
  groups: CitationGroups,
  audit: CitationAudit,
): CitationGroups {
  const items = [...audit.items];

  const annotate = (card: CitationCard): CitationCard => {
    const cardKey = normalizeRef(`${card.tag}${card.title}`);
    const idx = items.findIndex((item) => {
      const ref = normalizeRef(item.reference);
      const src = normalizeRef(item.source);
      return (
        cardKey.includes(ref) && (src === "" || cardKey.includes(src))
      );
    });
    if (idx < 0) return card;
    const [item] = items.splice(idx, 1);
    return {
      ...card,
      verified: item.status,
      tier: item.tier,
      note: item.note,
    };
  };

  const law = groups.law.map(annotate);
  const caseList = groups.case.map(annotate);

  for (const item of items) {
    if (item.kind === "case") {
      caseList.push(itemToCard(item, `case-audit-${caseList.length + 1}`));
    } else {
      law.push(itemToCard(item, `law-audit-${law.length + 1}`));
    }
  }

  return { law, case: caseList };
}

/** One-line verification stats for the chat completion summary. */
export function auditSummaryLine(audit: CitationAudit | undefined): string {
  if (!audit || audit.total === 0) return "";
  const parts = [`共 ${audit.total} 条`];
  if (audit.verified > 0) parts.push(`✓已核验 ${audit.verified}`);
  if (audit.retrieved > 0) parts.push(`✓已检索 ${audit.retrieved}`);
  if (audit.unverified > 0) parts.push(`⚠待律师复核 ${audit.unverified}`);
  return `引用核验：${parts.join("，")}。`;
}

const VERIFY_MARK: Record<string, string> = {
  verified: "✓ 已核验",
  retrieved: "✓ 已检索",
  unverified: "⚠ 待律师复核",
};

/** Markdown appendix (引用核验清单) for DOCX export. */
export function auditChecklistMarkdown(groups: CitationGroups): string {
  const cards = [...groups.law, ...groups.case].filter((c) => c.verified);
  if (cards.length === 0) return "";
  const lines = cards.map((c) => {
    const mark = VERIFY_MARK[c.verified ?? ""] ?? "";
    const tier = c.tier ? `（${c.tier}）` : "";
    const note = c.note ? ` — ${c.note}` : "";
    return `- ${mark} ${c.title}${tier}${note}`;
  });
  return `\n\n## 引用核验清单\n\n${lines.join("\n")}\n`;
}
