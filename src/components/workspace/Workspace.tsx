import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useConversation } from "../../stores/conversation";
import { onLawUpdateAlert, onSkillsUpdated } from "../../services/api";
import {
  CHAT_WIDTH_DEFAULT,
  clampChatWidth,
  loadChatWidth,
  saveChatWidth,
  shouldShowPreview,
} from "../../utils/chatLayout";
import { ChatPanel } from "./ChatPanel";
import { DocPreview } from "./DocPreview";
import { CitationPanel } from "./CitationPanel";
import { AgentTracePanel } from "./AgentTracePanel";
import { SkillRefinementPanel } from "./SkillRefinementPanel";
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
    committedMode,
    workspaceMode,
    legalDocument,
    documentMarkdown,
    draftWorkflowActive,
    activeEvidenceResponse,
  } = useConversation();

  const [sending, setSending] = createSignal(false);
  const [refinementOpen, setRefinementOpen] = createSignal(false);
  const [chatWidth, setChatWidth] = createSignal(loadChatWidth());
  const isDevAdmin = import.meta.env.DEV;
  let docScrollRef: HTMLDivElement | undefined;
  let wsRef: HTMLDivElement | undefined;
  let initGeneration = 0;

  const showPreview = createMemo(() =>
    shouldShowPreview({
      committedMode: committedMode(),
      workspaceMode: workspaceMode(),
      hasLegalDocument: legalDocument() !== null,
      hasMarkdownDoc: documentMarkdown().trim().length > 0,
      draftWorkflowActive: draftWorkflowActive(),
      activeEvidenceResponse: activeEvidenceResponse(),
    }),
  );

  function beginResize(e: PointerEvent) {
    if (!wsRef) return;
    e.preventDefault();
    const rect = wsRef.getBoundingClientRect();
    wsRef.classList.add("ws-resizing");

    const onMove = (ev: PointerEvent) => {
      setChatWidth(clampChatWidth(ev.clientX - rect.left, rect.width));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      wsRef?.classList.remove("ws-resizing");
      saveChatWidth(chatWidth());
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resetWidth() {
    const width = wsRef
      ? clampChatWidth(CHAT_WIDTH_DEFAULT, wsRef.getBoundingClientRect().width)
      : CHAT_WIDTH_DEFAULT;
    setChatWidth(width);
    saveChatWidth(width);
  }

  onMount(() => {
    let disposed = false;
    let unlistenLaw: (() => void) | undefined;
    let unlistenSkills: (() => void) | undefined;

    void onLawUpdateAlert((alert) => {
      const names = alert.changes
        .map((c) => `《${c.name}》${c.old_status}→${c.new_status}`)
        .join("；");
      const affected =
        alert.affected_documents.length > 0
          ? `，${alert.affected_documents.length} 份历史文书引用了相关法规，请复核`
          : "";
      props.onToast(`法规时效状态变化：${names}${affected}`);
    }).then((u) => {
      if (disposed) u();
      else unlistenLaw = u;
    });

    void onSkillsUpdated((p) => {
      props.onToast(`法律技能已更新到 v${p.version}`);
    }).then((u) => {
      if (disposed) u();
      else unlistenSkills = u;
    });

    onCleanup(() => {
      disposed = true;
      unlistenLaw?.();
      unlistenSkills?.();
    });

    if (isDevAdmin) {
      const onKey = (ev: KeyboardEvent) => {
        if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyO") {
          ev.preventDefault();
          setRefinementOpen((v) => !v);
        }
      };
      window.addEventListener("keydown", onKey);
      onCleanup(() => window.removeEventListener("keydown", onKey));
    }

    if (wsRef && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (wsRef) setChatWidth((w) => clampChatWidth(w, wsRef!.clientWidth));
      });
      ro.observe(wsRef);
      onCleanup(() => ro.disconnect());
    }
  });

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
    <div
      class="ws"
      classList={{ solo: !showPreview() }}
      ref={(el) => (wsRef = el)}
      style={{ "--chat-w": `${chatWidth()}px` }}
    >
      <ChatPanel onSend={onSend} sending={sending} />
      <Show when={showPreview()}>
        <div
          class="ws-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整聊天与文书预览宽度"
          onPointerDown={beginResize}
          onDblClick={resetWidth}
        />
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
      </Show>
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
      <Show when={isDevAdmin}>
        <SkillRefinementPanel open={refinementOpen()} onClose={() => setRefinementOpen(false)} />
      </Show>
      <div class={`toast${props.toast ? " show" : ""}`}>
        <Icon name="check" />
        {props.toast}
      </div>
    </div>
  );
}
