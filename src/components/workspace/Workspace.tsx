import { createEffect, createSignal, onCleanup } from "solid-js";
import { useConversation } from "../../stores/conversation";
import { ChatPanel } from "./ChatPanel";
import { DocPreview } from "./DocPreview";
import { CitationPanel } from "./CitationPanel";
import { AgentTracePanel } from "./AgentTracePanel";
import { Icon } from "../icons/Icons";
import "./Workspace.css";

export interface WorkspaceProps {
  draftKey: number;
  prompt: string;
  toast: string;
  onToast: (msg: string) => void;
}

export function Workspace(props: WorkspaceProps) {
  const {
    initWorkspace,
    sendChatMessage,
    activeConversationId,
    messages,
    pendingContextRefs,
    citationGroups,
    setCiteState,
    citeState,
  } = useConversation();

  const [sending, setSending] = createSignal(false);
  let docScrollRef: HTMLDivElement | undefined;
  let initGeneration = 0;

  createEffect(() => {
    props.draftKey;
    const prompt = props.prompt;
    const convId = activeConversationId();
    if (!convId) return;

    const generation = ++initGeneration;
    let cancelled = false;

    (async () => {
      setSending(true);
      try {
        await initWorkspace(prompt, convId);
        if (cancelled || generation !== initGeneration) return;

        const trimmed = prompt.trim();
        const hasRefs = pendingContextRefs().length > 0;
        if (trimmed || hasRefs) {
          const alreadySent = messages().some(
            (m) =>
              m.role === "user" &&
              (trimmed ? m.content.trim() === trimmed : m.content.includes("已附加")),
          );
          if (!alreadySent) {
            void sendChatMessage(trimmed).catch((e) => {
              if (!cancelled) props.onToast(`发送失败: ${String(e)}`);
            });
          }
        }
      } catch (e) {
        if (!cancelled) {
          props.onToast(`发送失败: ${String(e)}`);
          console.error("工作区初始化失败:", e);
        }
      } finally {
        if (!cancelled && generation === initGeneration) {
          setSending(false);
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  function scrollDocTo(anchor?: string) {
    requestAnimationFrame(() => {
      const sc = docScrollRef;
      if (!sc) return;
      const el = anchor ? sc.querySelector(anchor) : null;
      sc.scrollTo({ top: el ? (el as HTMLElement).offsetTop - 24 : 0, behavior: "smooth" });
    });
  }

  function openCite(key: string) {
    const tab = key.startsWith("case") ? "case" : "law";
    setCiteState({ open: true, tab, key });
    setTimeout(() => {
      const body = document.querySelector(".cp-body");
      const card = document.getElementById(`cc-${key}`);
      if (body && card) body.scrollTo({ top: card.offsetTop - 12, behavior: "smooth" });
    }, 360);
  }

  function onSend(text: string) {
    setSending(true);
    void sendChatMessage(text)
      .catch((e) => props.onToast(`发送失败: ${String(e)}`))
      .finally(() => setSending(false));
  }

  function onLocate(c: { key: string; clauseId?: string }) {
    const anchor = c.clauseId ? `#art-${c.clauseId}` : undefined;
    scrollDocTo(anchor);
    props.onToast(anchor ? "已定位到相关条款" : "未找到对应条款");
  }

  const cite = () => citeState();

  return (
    <div class="ws">
      <ChatPanel onSend={onSend} sending={sending} />
      <DocPreview
        onCite={openCite}
        onRisk={() => {
          const law = citationGroups().law[0];
          if (law) openCite(law.key);
        }}
        onFix={() => onSend("请根据风险提示补充或修改相关条款。")}
        onToggleCite={(force) =>
          setCiteState((c) => ({ ...c, open: force === true ? true : !c.open }))
        }
        onToast={props.onToast}
        docScrollRef={(el) => {
          docScrollRef = el;
        }}
        sheetRef={() => {}}
      />
      <CitationPanel
        open={cite().open}
        tab={cite().tab}
        activeKey={cite().key}
        onClose={() => setCiteState((c) => ({ ...c, open: false }))}
        onTab={(t) => setCiteState((c) => ({ ...c, tab: t }))}
        onInsert={(c) => props.onToast(`已插入引用：${c.title}`)}
        onLocate={onLocate}
      />
      <AgentTracePanel />
      <div class={`toast${props.toast ? " show" : ""}`}>
        <Icon name="check" />
        {props.toast}
      </div>
    </div>
  );
}
