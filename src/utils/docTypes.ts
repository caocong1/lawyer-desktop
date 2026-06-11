import type { IconName } from "../components/icons/Icons";

export interface DocType {
  id: string;
  icon: IconName;
  name: string;
  desc: string;
  prompt: string;
}

/** 全部文书类型：首页起草示例卡片与会话列表类型图标共用。 */
export const DOC_TYPES: readonly DocType[] = [
  {
    id: "equity",
    icon: "handshake",
    name: "股权转让协议",
    desc: "公司股权交易 · 对价与交割",
    prompt:
      "帮我起草一份股权转让协议：转让方张三将其持有的杭州某科技有限公司 60% 股权转让给受让方李四，转让价款人民币 1,000 万元，分两期支付。",
  },
  {
    id: "loan",
    icon: "yuan",
    name: "借款合同",
    desc: "融资 · 本息与担保",
    prompt:
      "帮我起草一份借款合同：出借人张三向杭州某科技有限公司出借人民币 200 万元，年利率 8%，借款期限一年，按月付息到期还本。",
  },
  {
    id: "lease",
    icon: "home",
    name: "房屋租赁合同",
    desc: "租赁 · 租金与权责",
    prompt:
      "帮我起草一份房屋租赁合同：出租人张三将位于杭州市西湖区文三路 100 号的 120 平米写字楼出租给杭州某科技有限公司，月租金人民币 30,000 元，租期五年。",
  },
  {
    id: "labor",
    icon: "briefcase",
    name: "劳动合同",
    desc: "用工 · 岗位薪酬与期限",
    prompt:
      "帮我起草一份劳动合同：甲方杭州某科技有限公司招聘乙方王五担任高级软件工程师，月薪人民币 25,000 元，合同期限三年。",
  },
  {
    id: "sale",
    icon: "cart",
    name: "买卖合同",
    desc: "交易 · 交付与验收",
    prompt:
      "帮我起草一份买卖合同：出卖人杭州某科技有限公司向买受人上海某贸易有限公司出售服务器设备 50 台，总价款人民币 150 万元，分两批交付并验收。",
  },
  {
    id: "nda",
    icon: "eyeOff",
    name: "保密协议",
    desc: "商业秘密 · 保密义务",
    prompt:
      "帮我起草一份保密协议：甲方杭州某科技有限公司与乙方王五就新产品研发合作签署保密协议，保密期限五年，并约定违约金。",
  },
  {
    id: "coop",
    icon: "users",
    name: "合作协议",
    desc: "联合经营 · 权责与分成",
    prompt:
      "帮我起草一份合作协议：甲方杭州某科技有限公司与乙方杭州某文化传媒有限公司就短视频内容制作开展合作，约定双方分工，收益按 6:4 分成。",
  },
  {
    id: "agency",
    icon: "edit",
    name: "委托代理合同",
    desc: "委托 · 授权范围与报酬",
    prompt:
      "帮我起草一份委托代理合同：委托人张三委托杭州某律师事务所李律师，代理其与某公司买卖合同纠纷一案的一审诉讼，并约定代理费。",
  },
  {
    id: "complaint",
    icon: "gavel",
    name: "民事起诉状",
    desc: "诉讼文书 · 诉请与事实理由",
    prompt:
      "帮我起草一份民事起诉状：原告张三与被告李四因买卖合同纠纷，请求法院判令被告支付货款人民币 50 万元及逾期利息。",
  },
  {
    id: "defense",
    icon: "shield",
    name: "答辩状",
    desc: "应诉 · 抗辩意见",
    prompt:
      "帮我起草一份民事答辩状：针对原告李四诉被告张三买卖合同纠纷一案，提出答辩意见。",
  },
  {
    id: "appeal",
    icon: "up",
    name: "上诉状",
    desc: "二审 · 上诉请求与理由",
    prompt:
      "帮我起草一份民事上诉状：上诉人张三不服杭州市西湖区人民法院一审判决，就买卖合同纠纷一案提起上诉，请求撤销原判、依法改判。",
  },
  {
    id: "preserve",
    icon: "lock",
    name: "财产保全申请书",
    desc: "保全 · 查封冻结申请",
    prompt:
      "帮我起草一份财产保全申请书：申请人张三请求法院冻结被申请人李四名下银行存款人民币 80 万元，申请人愿提供相应担保。",
  },
  {
    id: "enforce",
    icon: "bolt",
    name: "强制执行申请书",
    desc: "执行 · 生效文书履行",
    prompt:
      "帮我起草一份强制执行申请书：申请执行人张三依据已生效的民事判决书，请求法院强制被执行人李四支付货款人民币 50 万元及利息。",
  },
  {
    id: "opinion",
    icon: "scale",
    name: "法律意见书",
    desc: "非诉 · 合规与风险论证",
    prompt:
      "帮我起草一份法律意见书：就杭州某科技有限公司本次增资扩股的合法合规性出具法律意见书，重点分析股东会决议效力、优先认购权、外资准入与信息披露风险。",
  },
  {
    id: "dd",
    icon: "book",
    name: "尽职调查报告",
    desc: "投融资 · 法律尽调",
    prompt:
      "帮我起草一份法律尽职调查报告：对杭州某科技有限公司进行全面法律尽职调查，涵盖公司治理、知识产权、重大合同、劳动用工、诉讼仲裁等方面。",
  },
  {
    id: "letter",
    icon: "mail",
    name: "律师函",
    desc: "催告 · 权利主张与警示",
    prompt:
      "帮我起草一份律师函：受张三委托，就李四拖欠借款本金人民币 200 万元及利息事宜发函催告，要求其十五日内清偿全部款项。",
  },
];

/** 文书/程序类型标记优先匹配，避免“买卖合同纠纷上诉状”被标的合同抢走图标。 */
const GENRE_KEYWORDS: ReadonlyArray<readonly [readonly string[], IconName]> = [
  [["民事起诉状", "起诉状", "起诉"], "gavel"],
  [["答辩状", "答辩书", "答辩"], "shield"],
  [["上诉状", "上诉"], "up"],
  [["财产保全申请书", "财产保全申请", "保全申请", "保全"], "lock"],
  [["强制执行申请书", "强制执行申请", "执行申请"], "bolt"],
  [["法律意见书", "意见书", "法律意见"], "scale"],
  [["尽职调查报告", "尽调报告", "尽职调查", "尽调"], "book"],
  [["律师函", "催告函", "催告"], "mail"],
];

/** 标的/合同主题关键词，仅在未识别到明确文书类型时使用。 */
const SUBJECT_KEYWORDS: ReadonlyArray<readonly [readonly string[], IconName]> = [
  [["股权转让", "股权"], "handshake"],
  [["借款", "借贷", "贷款", "民间借贷"], "yuan"],
  [["租赁", "租房", "承租"], "home"],
  [["劳动", "用工", "雇佣", "入职", "离职", "竞业"], "briefcase"],
  [["买卖", "采购", "购销"], "cart"],
  [["保密"], "eyeOff"],
  [["合作", "合伙", "联营"], "users"],
  [["委托代理", "授权委托", "委托书", "代理合同", "代理协议"], "edit"],
];

/**
 * 在文本中找出现位置最靠前的词（同位置取更长的词）。
 * 同一优先级内取最靠前的命中，兼容“民事起诉状：买卖合同纠纷”和“买卖合同纠纷上诉状”。
 */
function earliestMatch(
  text: string,
  entries: ReadonlyArray<readonly [string, IconName]>,
): IconName | null {
  let icon: IconName | null = null;
  let bestPos = Number.POSITIVE_INFINITY;
  let bestLen = 0;
  for (const [word, candidate] of entries) {
    const pos = text.indexOf(word);
    if (pos < 0) continue;
    if (pos < bestPos || (pos === bestPos && word.length > bestLen)) {
      icon = candidate;
      bestPos = pos;
      bestLen = word.length;
    }
  }
  return icon;
}

const proceduralIds = new Set([
  "complaint",
  "defense",
  "appeal",
  "preserve",
  "enforce",
  "opinion",
  "dd",
  "letter",
]);

const GENRE_ENTRIES: ReadonlyArray<readonly [string, IconName]> = [
  ...DOC_TYPES.filter((t) => proceduralIds.has(t.id)).map((t) => [t.name, t.icon] as const),
  ...GENRE_KEYWORDS.flatMap(
    ([keywords, icon]) => keywords.map((keyword) => [keyword, icon] as const),
  ),
];

const SUBJECT_ENTRIES: ReadonlyArray<readonly [string, IconName]> = [
  ...DOC_TYPES.filter((t) => !proceduralIds.has(t.id)).map((t) => [t.name, t.icon] as const),
  ...SUBJECT_KEYWORDS.flatMap(
    ([keywords, icon]) => keywords.map((keyword) => [keyword, icon] as const),
  ),
];

/** 根据会话标题推断文书类型图标；匹配不到时退回通用文档图标。 */
export function iconForConversationTitle(title: string | null | undefined): IconName {
  const text = (title ?? "").trim();
  if (!text) return "doc";
  return earliestMatch(text, GENRE_ENTRIES) ?? earliestMatch(text, SUBJECT_ENTRIES) ?? "doc";
}
