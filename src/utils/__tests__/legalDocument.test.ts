import { describe, expect, it } from "vitest";
import { markdownToLegalDocument, modelToArticles, modelToParties } from "../legalDocument";

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
});
