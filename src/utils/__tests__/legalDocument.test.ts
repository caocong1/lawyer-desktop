import { describe, expect, it } from "vitest";
import {
  extractDraftOutputEnvelope,
  isPublishableDocument,
  markdownToLegalDocument,
  markdownReportTitle,
  modelToArticles,
  modelToParties,
  splitMarkdownBlocks,
  stripReportPreamble,
} from "../legalDocument";

describe("draft output envelope", () => {
  it("splits assistant_notes from document in the envelope contract", () => {
    const envelope = extractDraftOutputEnvelope(`
{
  "assistant_notes": "## 检索结论\\n\\n依据《示例法规》第3条。",
  "document": {
    "title": "房屋租赁合同",
    "sections": [
      { "heading": "租赁期限", "content": "自 2026 年 7 月 1 日起至 2027 年 6 月 30 日止。" }
    ]
  }
}
`);

    expect(envelope.hasEnvelope).toBe(true);
    expect(envelope.assistantMarkdown).toContain("检索结论");
    expect(envelope.assistantMarkdown).toContain("示例法规");
    expect(envelope.documentJson).toContain("房屋租赁合同");
    expect(envelope.documentMarkdown).toBe("");
    expect(isPublishableDocument(`{"assistant_notes":"x","document":${envelope.documentJson}}`)).toBe(true);
  });

  it("supports non-legal document titles without domain-specific matchers", () => {
    const envelope = extractDraftOutputEnvelope(`
{
  "assistant_notes": "已整理需求边界与约束。",
  "document": {
    "title": "产品需求文档",
    "sections": [
      { "heading": "背景", "content": "用户希望在桌面端完成文档起草。" },
      { "heading": "目标", "content": "左侧展示说明，右侧展示最终文档。" }
    ]
  }
}
`);

    expect(envelope.hasEnvelope).toBe(true);
    expect(envelope.assistantMarkdown).toContain("需求边界");
    const doc = JSON.parse(envelope.documentJson!) as { title: string };
    expect(doc.title).toBe("产品需求文档");
  });

  it("falls back to legacy plain markdown when no envelope is present", () => {
    const legacy = extractDraftOutputEnvelope(`
# 民事起诉状

原告：张三，男，住 XX 省 XX 市。
被告：李四，男，住 XX 省 XX 市。

## 诉讼请求

一、判令被告向原告支付拖欠货款人民币 500000 元；
二、判令被告承担本案诉讼费用。

## 事实与理由

原被告之间存在买卖合同关系。
被告逾期付款，已构成违约。

## 证据与附件目录

1. 合同；
2. 对账单。
`);

    expect(legacy.hasEnvelope).toBe(false);
    expect(legacy.assistantMarkdown).toBe("");
    expect(legacy.documentMarkdown).toContain("民事起诉状");
    expect(isPublishableDocument(legacy.documentMarkdown)).toBe(true);
  });
});

describe("legal document markdown fallback", () => {
  it("splits litigation markdown into parties, sections, and paragraphs", () => {
    const model = markdownToLegalDocument(`
# 民事起诉状

---

> **使用说明**：本起诉状为框架模板。

原告：张三，男，住 XX 省 XX 市。
被告：李四，男，住 XX 省 XX 市。

## 诉讼请求

一、判令被告向原告支付拖欠货款人民币 500000 元；
二、判令被告承担本案诉讼费用。

## 事实与理由

原被告之间存在买卖合同关系。
被告逾期付款，已构成违约。

## 证据与附件目录

1. 合同；
2. 对账单。
`);

    expect(model?.title).toBe("民事起诉状");
    expect(modelToParties(model!).map((p) => p.lbl)).toEqual(["原告：", "被告："]);

    const articles = modelToArticles(model!);
    expect(articles.map((a) => a.title)).toEqual([
      "使用说明",
      "诉讼请求",
      "事实与理由",
      "证据与附件目录",
    ]);
    expect(articles[1].paras).toHaveLength(2);
    expect(articles[2].paras).toHaveLength(1);
    expect(JSON.stringify(articles)).not.toContain("---");
    expect(JSON.stringify(articles)).not.toContain(">");
  });

  it("preserves GFM tables as renderable blocks between prose sections", () => {
    const model = markdownToLegalDocument(`
# 民事起诉状

原告：张三，男，住 XX 省 XX 市。
被告：李四，男，住 XX 省 XX 市。

## 证据清单

| 序号 | 证据名称 | 证明目的 |
| --- | --- | --- |
| 1 | 买卖合同 | 双方存在买卖关系 |
| 2 | 对账单 | 被告欠款金额 |

以上证据原件均备。
`);

    const articles = modelToArticles(model!);
    const evidence = articles.find((a) => a.title === "证据清单");
    expect(evidence?.blocks?.some((b) => b.kind === "table")).toBe(true);
    const table = evidence?.blocks?.find((b) => b.kind === "table");
    expect(table && table.kind === "table" ? table.markdown : "").toContain("| 1 | 买卖合同 |");
    expect(evidence?.blocks?.some((b) => b.kind === "para")).toBe(true);
  });
});

describe("splitMarkdownBlocks", () => {
  it("splits prose and table regions", () => {
    const blocks = splitMarkdownBlocks(`引言段落。

| A | B |
| --- | --- |
| 1 | 2 |

结尾段落。`);
    expect(blocks).toEqual([
      { kind: "prose", text: "引言段落。" },
      { kind: "table", markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
      { kind: "prose", text: "结尾段落。" },
    ]);
  });
});

describe("evidence report markdown helpers", () => {
  const report = `现在进入 **Write** 阶段。基于以上全部材料，生成完整的诉讼方案。

---

# 重庆市双业融资担保有限公司投标保函索赔案诉讼方案

> **基于本案卷材料形成**

## 核心结论

建议以中国国际航空股份有限公司重庆分公司为原告。
`;

  it("strips process narration before the first H1 heading", () => {
    const stripped = stripReportPreamble(report);
    expect(stripped.startsWith("# 重庆市双业融资担保有限公司投标保函索赔案诉讼方案")).toBe(true);
    expect(stripped).not.toContain("现在进入");
    expect(stripped).toContain("## 核心结论");
  });

  it("returns the input unchanged when no H1 heading exists", () => {
    const noHeading = "本案卷分析如下。\n\n被告存在违约行为。";
    expect(stripReportPreamble(noHeading)).toBe(noHeading);
  });

  it("returns the input unchanged when the H1 is already first", () => {
    const headed = "# 案情分析报告\n\n正文内容。";
    expect(stripReportPreamble(headed)).toBe(headed);
  });

  it("derives the report title from the first H1", () => {
    expect(markdownReportTitle(stripReportPreamble(report))).toBe(
      "重庆市双业融资担保有限公司投标保函索赔案诉讼方案",
    );
  });

  it("removes bold markers from the heading title", () => {
    expect(markdownReportTitle("# **案情分析**报告\n\n正文")).toBe("案情分析报告");
  });

  it("falls back to the provided label, then a generic title", () => {
    expect(markdownReportTitle("无标题正文", "案情分析")).toBe("案情分析");
    expect(markdownReportTitle("无标题正文")).toBe("案卷分析报告");
  });
});
