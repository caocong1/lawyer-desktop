import { For, onMount, onCleanup, createSignal, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "../icons/Icons";
import { classifyDroppedPaths } from "../../services/api";
import { MentionComposer } from "../MentionComposer";
import type { MentionComposerApi } from "../MentionComposer";
import "./HomePage.css";
import { useConversation } from "../../stores/conversation";
import type { ContextRefPayload } from "../../types/contextRefs";
import { pathToRefAlias } from "../../utils/evidenceFlow";
import { DOC_TYPES } from "../../utils/docTypes";

export interface HomePageProps {
  onStart: (prompt: string) => void;
  onToast?: (msg: string) => void;
}

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

function toRef(path: string, kind: ContextRefPayload["kind"]): ContextRefPayload {
  return {
    alias: pathToRefAlias(path),
    path,
    kind,
  };
}

export function HomePage(props: HomePageProps) {
  const {
    pendingContextRefs,
    addContextRef,
    removeContextRef,
    addInlineMention,
    removeInlineMention,
  } = useConversation();
  const [input, setInput] = createSignal("");
  const [attachOpen, setAttachOpen] = createSignal(false);
  const [dragActive, setDragActive] = createSignal(false);
  let composer: MentionComposerApi | undefined;
  let attachRef: HTMLDivElement | undefined;

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (attachOpen() && attachRef && !attachRef.contains(e.target as Node)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);

    // OS file/folder drag-and-drop onto the landing composer. The native event
    // is webview-wide, so a drop anywhere on the home screen attaches here.
    // Requires dragDropEnabled=true in tauri.conf.json (set at window creation).
    let disposed = false;
    let unlistenDrop: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
        } else if (payload.type === "drop") {
          setDragActive(false);
          void handleDroppedPaths(payload.paths);
        } else {
          // "leave"
          setDragActive(false);
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlistenDrop = u;
      })
      .catch((e) => console.error("注册拖放监听失败:", e));

    onCleanup(() => {
      disposed = true;
      document.removeEventListener("click", onDocClick);
      unlistenDrop?.();
    });
  });

  // Attach OS-dropped paths the same way the picker does: classify each path
  // (file vs. directory) on the backend, then route through the shared
  // addContextRef so the chips/mentions behave identically to manual attach.
  async function handleDroppedPaths(paths: string[]) {
    const cleaned = paths.filter((p) => typeof p === "string" && p.trim().length > 0);
    if (cleaned.length === 0) return;
    try {
      const kinds = await classifyDroppedPaths(cleaned);
      let added = 0;
      for (const item of kinds) {
        if (!item.exists) continue;
        addContextRef(toRef(item.path, item.is_dir ? "directory" : "file"));
        added += 1;
      }
      if (added > 0) props.onToast?.(`已附加 ${added} 项资料`);
    } catch (e) {
      console.error("处理拖放文件失败:", e);
      props.onToast?.("处理拖放文件失败");
    }
  }

  async function pickDirectory() {
    setAttachOpen(false);
    try {
      const selected = await open({ multiple: false, directory: true });
      if (!selected || Array.isArray(selected)) return;
      addContextRef(toRef(selected, "directory"));
    } catch (e) {
      console.error("选择文件夹失败:", e);
      props.onToast?.("选择文件夹失败");
    }
  }

  async function pickFiles(multiple: boolean) {
    setAttachOpen(false);
    try {
      const selected = await open({ multiple, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        addContextRef(toRef(path, "file"));
      }
    } catch (e) {
      console.error("选择文件失败:", e);
      props.onToast?.("选择文件失败");
    }
  }

  function insertExamplePrompt(prompt: string) {
    const next = input().trim() ? `${input().trimEnd()}\n\n${prompt}` : prompt;
    composer?.clear();
    composer?.insertText(next);
  }

  const canSend = () => input().trim().length > 0 || pendingContextRefs().length > 0;

  return (
    <div class="home scroll">
      <div class="home-inner">
        <div class="home-hi">
          <h1>{greetingByTime()}</h1>
          <span class="date">{formatToday()}</span>
        </div>
        <p class="home-sub">
          描述你的需求，墨律将为你起草、检索法条判例并标注条款风险。也可以从下方示例快速填入。
        </p>

        <div class="starter" classList={{ "drag-active": dragActive() }}>
          <Show when={dragActive()}>
            <div class="drop-overlay">
              <Icon name="attach" />
              <span>拖放文件或文件夹，作为上下文附加</span>
            </div>
          </Show>
          <div class="starter-top">
            <div class="seal">墨</div>
            <div class="t">新建任务</div>
            <div class="pill">
              <Icon name="sparkle" style={{ width: "13px", height: "13px" }} />
              AI 助理
            </div>
          </div>
          <Show when={pendingContextRefs().length > 0}>
            <div class="starter-chips">
              <For each={pendingContextRefs()}>
                {(ref) => (
                  <span class="starter-chip" title={ref.path}>
                    <span class="starter-chip-alias">@{ref.alias}</span>
                    <span class="starter-chip-kind">
                      {ref.kind === "directory" ? "文件夹" : "文件"}
                    </span>
                    <button
                      type="button"
                      class="starter-chip-remove"
                      aria-label={`移除 ${ref.alias}`}
                      onClick={() => removeContextRef(ref.path)}
                    >
                      ×
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="starter-field">
            <MentionComposer
              class="starter-input"
              placeholder="描述你的法律需求，例如：起草一份股权转让协议，或附加本地资料后生成诉讼方案…"
              candidates={pendingContextRefs()}
              onReady={(api) => (composer = api)}
              onInput={(text) => setInput(text)}
              onInsertMention={(ref) => {
                addContextRef(ref);
                addInlineMention(ref.path);
              }}
              onRemoveMention={(path) => removeInlineMention(path)}
              onSend={() => {
                if (canSend()) props.onStart(input().trim());
              }}
            />
          </div>
          <div class="starter-bar">
            <div class="attach-wrap" ref={attachRef}>
              <button
                type="button"
                class="tool tool-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setAttachOpen((v) => !v);
                }}
              >
                <Icon name="attach" />
                附加资料
              </button>
              <Show when={attachOpen()}>
                <div class="attach-menu">
                  <button type="button" onClick={() => void pickDirectory()}>
                    选择文件夹
                  </button>
                  <button type="button" onClick={() => void pickFiles(false)}>
                    选择文件
                  </button>
                  <button type="button" onClick={() => void pickFiles(true)}>
                    选择多个文件
                  </button>
                </div>
              </Show>
            </div>
            <button
              type="button"
              class="tool tool-btn mc-at-btn"
              title="插入文件引用"
              onClick={() => composer?.promptMention()}
            >
              @
            </button>
            <span class="grow" />
            <span class="send-hint">
              <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 发送
            </span>
            <button
              type="button"
              class="btn-accent"
              onClick={() => props.onStart(input().trim())}
              disabled={!canSend()}
            >
              发送
              <Icon name="send" />
            </button>
          </div>
        </div>

        <div class="section-h">
          <h2>起草示例</h2>
          <span class="more">点击填入</span>
        </div>
        <div class="types">
          <For each={DOC_TYPES}>
            {(t) => (
              <button type="button" class="type-card" onClick={() => insertExamplePrompt(t.prompt)}>
                <div class="type-ic">
                  <Icon name={t.icon} />
                </div>
                <h3>{t.name}</h3>
                <p>{t.desc}</p>
                <span class="go">
                  <Icon name="arrow" />
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
