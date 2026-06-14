import { describe, expect, it } from "vitest";
import {
  auditToCitationGroups,
  mergeAuditIntoGroups,
  auditSummaryLine,
  auditChecklistMarkdown,
} from "../citationAudit";
import type { CitationAudit, CitationGroups } from "../../types/legal";

const sampleAudit: CitationAudit = {
  total: 3,
  verified: 1,
  retrieved: 1,
  unverified: 1,
  items: [
    {
      kind: "law",
      source: "中华人民共和国民法典",
      reference: "第五百八十五条",
      status: "verified",
      tier: "L1-法规（本地库）",
      excerpt: "第五百八十五条 当事人可以约定违约金……",
      url: "https://flk.npc.gov.cn/",
    },
    {
      kind: "interpretation",
      source: "",
      reference: "法释〔2020〕28号",
      status: "retrieved",
      tier: "L1-法规",
    },
    {
      kind: "case",
      source: "",
      reference: "（2024）渝01民初1234号",
      status: "unverified",
      note: "本轮检索结果中未出现该案号 — 待律师复核",
    },
  ],
};

describe("auditToCitationGroups", () => {
  it("splits law/interpretation into law tab and cases into case tab", () => {
    const groups = auditToCitationGroups(sampleAudit);
    expect(groups.law).toHaveLength(2);
    expect(groups.case).toHaveLength(1);
    expect(groups.law[0].title).toBe("《中华人民共和国民法典》第五百八十五条");
    expect(groups.law[0].verified).toBe("verified");
    expect(groups.law[0].text).toContain("违约金");
    expect(groups.case[0].verified).toBe("unverified");
    expect(groups.case[0].text).toContain("待律师复核");
  });
});

describe("mergeAuditIntoGroups", () => {
  it("annotates matching cards and appends unmatched audit items", () => {
    const groups: CitationGroups = {
      law: [
        {
          key: "law1",
          tag: "中华人民共和国民法典",
          title: "第五百八十五条",
          src: "民法典",
          text: "违约金条款",
          rel: [{ t: "违约金条款" }],
        },
      ],
      case: [],
    };
    const merged = mergeAuditIntoGroups(groups, sampleAudit);
    expect(merged.law[0].verified).toBe("verified");
    expect(merged.law[0].tier).toContain("L1");
    // 法释 appended as new card; case appended to case tab
    expect(merged.law).toHaveLength(2);
    expect(merged.case).toHaveLength(1);
  });
});

describe("auditChecklistMarkdown", () => {
  it("renders a checklist for verified-marked cards only", () => {
    const md = auditChecklistMarkdown(auditToCitationGroups(sampleAudit));
    expect(md).toContain("## 引用核验清单");
    expect(md).toContain("✓ 已核验 《中华人民共和国民法典》第五百八十五条");
    expect(md).toContain("⚠ 待律师复核 （2024）渝01民初1234号");
  });

  it("returns empty for groups without verification info", () => {
    expect(auditChecklistMarkdown({ law: [], case: [] })).toBe("");
  });
});

describe("auditSummaryLine", () => {
  it("formats stats and omits zero buckets", () => {
    expect(auditSummaryLine(sampleAudit)).toBe(
      "引用核验：共 3 条，✓已核验 1，✓已检索 1，⚠待律师复核 1。",
    );
    expect(
      auditSummaryLine({ items: [], total: 0, verified: 0, retrieved: 0, unverified: 0 }),
    ).toBe("");
    expect(auditSummaryLine(undefined)).toBe("");
  });
});
