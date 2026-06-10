import { For, onMount, createSignal } from "solid-js";
import { Icon } from "../icons/Icons";
import "./HomePage.css";
import { useConversation } from "../../stores/conversation";

export interface HomePageProps {
  onStart: (prompt: string) => void;
  onPickType: (prompt: string) => void;
  onOpenRecent: (id: string) => void;
}

const DOC_TYPES = [
  { id: "equity", icon: "handshake", name: "股权转让协议", desc: "公司股权交易 · 对价与交割", prompt: "帮我起草一份股权转让协议：转让方张三将其持有的杭州某科技有限公司 60% 股权转让给受让方李四，转让价款人民币 1,000 万元，分两期支付。" },
  { id: "complaint", icon: "gavel", name: "民事起诉状", desc: "诉讼文书 · 诉请与事实理由", prompt: "帮我起草一份民事起诉状：原告张三与被告李四因买卖合同纠纷，请求法院判令被告支付货款人民币 50 万元及逾期利息。" },
  { id: "opinion", icon: "scale", name: "法律意见书", desc: "非诉 · 合规与风险论证", prompt: "帮我起草一份法律意见书：就杭州某科技有限公司 A 轮融资项目进行法律尽职调查并出具合规审查意见。" },
  { id: "labor", icon: "file2", name: "劳动合同", desc: "用工 · 岗位薪酬与期限", prompt: "帮我起草一份劳动合同：甲方杭州某科技有限公司招聘乙方王五担任高级软件工程师，月薪人民币 25,000 元，合同期限三年。" },
  { id: "lease", icon: "folder", name: "房屋租赁合同", desc: "租赁 · 租金与权责", prompt: "帮我起草一份房屋租赁合同：出租人张三将位于杭州市西湖区文三路 100 号的 120 平米写字楼出租给杭州某科技有限公司，月租金人民币 30,000 元，租期五年。" },
  { id: "defense", icon: "shield", name: "答辩状", desc: "应诉 · 抗辩意见", prompt: "帮我起草一份民事答辩状：针对原告李四诉被告张三买卖合同纠纷一案，提出答辩意见。" },
  { id: "loan", icon: "doc", name: "借款合同", desc: "融资 · 本息与担保", prompt: "帮我起草一份借款合同：出借人张三向杭州某科技有限公司出借人民币 200 万元，年利率 8%，借款期限一年，按月付息到期还本。" },
  { id: "dd", icon: "book", name: "尽职调查报告", desc: "投融资 · 法律尽调", prompt: "帮我起草一份法律尽职调查报告：对杭州某科技有限公司进行全面法律尽职调查，涵盖公司治理、知识产权、重大合同、劳动用工、诉讼仲裁等方面。" },
] as const;

function greetingByTime(date = new Date()) {
  const hour = date.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function formatToday() {
  const d = new Date();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${weekday}`;
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function HomePage(props: HomePageProps) {
  const { conversations, loadConversations } = useConversation();
  const [input, setInput] = createSignal("");

  onMount(() => {
    loadConversations();
  });

  return (
    <div class="home scroll">
      <div class="home-inner">
        <div class="home-hi">
          <h1>{greetingByTime()}</h1>
          <span class="date">{formatToday()}</span>
        </div>
        <p class="home-sub">
          描述你的需求，墨律将为你起草、检索法条判例并标注条款风险。也可以从下方文书类型开始。
        </p>

        <div class="starter">
          <div class="starter-top">
            <div class="seal">墨</div>
            <div class="t">新建文书</div>
            <div class="pill">
              <Icon name="sparkle" style={{ width: "13px", height: "13px" }} />
              AI 起草
            </div>
          </div>
          <div class="starter-field">
            <textarea
              class="starter-input"
              placeholder="描述你的法律需求，例如：起草一份股权转让协议..."
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              rows={3}
            />
          </div>
          <div class="starter-bar">
            <div class="tool">
              <Icon name="attach" />
              附卷宗
            </div>
            <div class="tool">
              <Icon name="book" />
              引用法库
            </div>
            <span class="grow" />
            <button
              type="button"
              class="btn-accent"
              onClick={() => props.onStart(input().trim())}
              disabled={!input().trim()}
            >
              起草
              <Icon name="send" />
            </button>
          </div>
        </div>

        <div class="section-h">
          <h2>选择文书类型</h2>
          <span class="more">全部模板 →</span>
        </div>
        <div class="types">
          <For each={DOC_TYPES}>
            {(t) => (
              <div class="type-card" onClick={() => props.onPickType(t.prompt)}>
                <div class="type-ic">
                  <Icon name={t.icon} />
                </div>
                <h3>{t.name}</h3>
                <p>{t.desc}</p>
                <span class="go">
                  <Icon name="arrow" />
                </span>
              </div>
            )}
          </For>
        </div>

        <div class="section-h">
          <h2>最近的项目</h2>
          <span class="more">查看全部 →</span>
        </div>
        <div class="recents">
          {conversations().length === 0 ? (
            <div class="recents-empty">暂无最近项目，开始起草一份新文书吧</div>
          ) : (
            <For each={conversations()}>
              {(c) => (
                <div class="recent" onClick={() => props.onOpenRecent(c.id)}>
                  <div class="ric">
                    <Icon name="doc" />
                  </div>
                  <div>
                    <div class="rt">{c.title || "未命名文书"}</div>
                    <div class="rs">{formatRelativeTime(c.updated_at)}</div>
                  </div>
                  <div class="rmeta">
                    <div class="rtime">{formatRelativeTime(c.updated_at)}</div>
                  </div>
                </div>
              )}
            </For>
          )}
        </div>
      </div>
    </div>
  );
}
