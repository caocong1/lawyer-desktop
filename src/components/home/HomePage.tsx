import { For, onMount, onCleanup, createSignal, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "../icons/Icons";
import "./HomePage.css";
import { useConversation } from "../../stores/conversation";
import type { ContextRefPayload } from "../../types/contextRefs";
import { pathToRefAlias } from "../../utils/evidenceFlow";
import { DOC_TYPES } from "../../utils/docTypes";

export interface HomePageProps {
  onStart: (prompt: string) => void;
  onOpenConversations: () => void;
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
  } = useConversation();
  const [input, setInput] = createSignal("");
  const [attachOpen, setAttachOpen] = createSignal(false);
  let attachRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (attachOpen() && attachRef && !attachRef.contains(e.target as Node)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    onCleanup(() => document.removeEventListener("click", onDocClick));
  });

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
    const next = input().trim()
      ? `${input().trimEnd()}\n\n${prompt}`
      : prompt;
    setInput(next);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.setSelectionRange(next.length, next.length);
    });
  }

  const canSend = () => input().trim().length > 0 || pendingContextRefs().length > 0;

  return (
    <div class="home scroll">
      <div class="home-inner">
        <div class="home-hi">
          <h1>{greetingByTime()}</h1>
          <span class="date">{formatToday()}</span>
          <button
            type="button"
            class="home-history-btn"
            onClick={props.onOpenConversations}
          >
            <Icon name="clock" />
            会话列表
          </button>
        </div>
        <p class="home-sub">
          描述你的需求，墨律将为你起草、检索法条判例并标注条款风险。也可以从下方示例快速填入。
        </p>

        <div class="starter">
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
            <textarea
              ref={inputRef}
              class="starter-input"
              placeholder="描述你的法律需求，例如：起草一份股权转让协议，或附加本地资料后生成诉讼方案…"
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              rows={3}
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
            <span class="grow" />
            <button
              type="button"
              class="btn-accent"
              onClick={() => props.onStart(input().trim())}
              disabled={!canSend()}
            >
              开始
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
