import { describe, expect, it } from "vitest";
import { DOC_TYPES, iconForConversationTitle } from "../docTypes";

describe("DOC_TYPES", () => {
  it("has unique ids and names", () => {
    const ids = DOC_TYPES.map((t) => t.id);
    const names = DOC_TYPES.map((t) => t.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every type carries an icon, description and a draft prompt", () => {
    for (const t of DOC_TYPES) {
      expect(t.icon.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(0);
      expect(t.prompt).toContain(t.name);
    }
  });
});

describe("iconForConversationTitle", () => {
  it("matches full type names from auto-generated titles", () => {
    expect(iconForConversationTitle("房屋租赁合同起草")).toBe("home");
    expect(iconForConversationTitle("借款合同（个人借贷）")).toBe("yuan");
    expect(iconForConversationTitle("民事起诉状：买卖合同纠纷")).toBe("gavel");
  });

  it("falls back to keyword matching for loose titles", () => {
    expect(iconForConversationTitle("公司股权架构调整咨询")).toBe("handshake");
    expect(iconForConversationTitle("员工竞业限制问题")).toBe("briefcase");
    expect(iconForConversationTitle("向法院申请财产保全")).toBe("lock");
  });

  it("prefers 上诉 over 起诉 when both could match", () => {
    expect(iconForConversationTitle("不服一审判决提起上诉")).toBe("up");
  });

  it("prefers the leading document type over a later subject matter", () => {
    expect(iconForConversationTitle("民事答辩状：劳动合同争议")).toBe("shield");
    expect(iconForConversationTitle("劳动合同审查")).toBe("briefcase");
  });

  it("prefers litigation document types even when titles start with the dispute subject", () => {
    expect(iconForConversationTitle("买卖合同纠纷上诉状")).toBe("up");
    expect(iconForConversationTitle("劳动合同纠纷民事起诉状")).toBe("gavel");
    expect(iconForConversationTitle("借款合同纠纷答辩状")).toBe("shield");
    expect(iconForConversationTitle("借款纠纷财产保全申请")).toBe("lock");
    expect(iconForConversationTitle("买卖合同纠纷强制执行申请")).toBe("bolt");
    expect(iconForConversationTitle("保密协议纠纷律师函")).toBe("mail");
  });

  it("does not let a bare 委托 verb hide the actual document subject", () => {
    expect(iconForConversationTitle("委托代理合同")).toBe("edit");
    expect(iconForConversationTitle("授权委托书")).toBe("edit");
    expect(iconForConversationTitle("委托贷款合同")).toBe("yuan");
    expect(iconForConversationTitle("受张三委托起草借款合同")).toBe("yuan");
  });

  it("returns the generic doc icon when nothing matches", () => {
    expect(iconForConversationTitle("新会话")).toBe("doc");
    expect(iconForConversationTitle("")).toBe("doc");
    expect(iconForConversationTitle(undefined)).toBe("doc");
  });
});
