import { For, Show } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import type { Article } from "../../types/legal";
import { cnNum } from "../../utils/legalDocument";
import { useConversation } from "../../stores/conversation";
import { generateDocx } from "../../services/api";
import { renderSegs } from "../../utils/renderSegs";
import { Icon } from "../icons/Icons";
import { DocDraftingLoader } from "./DocDraftingLoader";
import "./DocPreview.css";

export interface DocPreviewProps {
  onCite: (key: string) => void;
  onRisk: () => void;
  onFix: () => void;
  onToggleCite: (force?: boolean) => void;
  onToast: (msg: string) => void;
  docScrollRef?: (el: HTMLDivElement) => void;
  sheetRef?: (el: HTMLDivElement) => void;
}

export function DocPreview(props: DocPreviewProps) {
  const {
    articles,
    docMeta,
    docMode,
    setDocMode,
    justAddedId,
    legalDocument,
    documentMarkdown,
    documentVersion,
    activeConversationId,
    isStreaming,
  } = useConversation();

  const hasDocument = () => legalDocument() !== null && articles().length > 0;
  const isDrafting = () => isStreaming() && !hasDocument();
  const meta = () => docMeta();

  function exec(cmd: string, val: string | null = null) {
    document.execCommand(cmd, false, val ?? undefined);
  }

  async function exportDocx() {
    const doc = legalDocument();
    const markdown = documentMarkdown();
    if (!doc || !markdown) {
      props.onToast("暂无可导出的文书，请先完成起草");
      return;
    }

    const defaultName = `${doc.title || "法律文书"}.docx`;
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
    });
    if (!path) return;

    try {
      await generateDocx({
        title: doc.title,
        content_markdown: markdown,
        output_path: path,
        conversation_id: activeConversationId() ?? undefined,
      });
      props.onToast(`已导出 ${defaultName}`);
    } catch (e) {
      props.onToast(`导出失败: ${String(e)}`);
    }
  }

  function compareVersions() {
    const ver = documentVersion();
    if (ver < 2) {
      props.onToast("暂无上一稿可对比");
      return;
    }
    props.onToast(`当前为第 ${ver} 稿`);
  }

  return (
    <div class="doc">
      <div class="doc-tb">
        <span class="doc-title">{meta().title || "法律文书"}</span>
        <Show when={documentVersion() > 0}>
          <span class="ver-pill">第 {documentVersion()} 稿</span>
        </Show>
        <span class="grow" />
        <div class="seg">
          <button
            type="button"
            class={docMode() === "preview" ? "on" : ""}
            onClick={() => setDocMode("preview")}
          >
            预览
          </button>
          <button
            type="button"
            class={docMode() === "edit" ? "on" : ""}
            onClick={() => setDocMode("edit")}
            disabled={!hasDocument()}
          >
            编辑
          </button>
        </div>
        <button type="button" class="dbtn" onClick={() => props.onToggleCite()}>
          <Icon name="book" />
          引用
        </button>
        <button type="button" class="dbtn" onClick={compareVersions}>
          <Icon name="diff" />
          对比
        </button>
        <button
          type="button"
          class="dbtn prim"
          onClick={() => void exportDocx()}
          disabled={!hasDocument()}
        >
          <Icon name="download" />
          导出
        </button>
      </div>

      <div class="doc-scroll scroll" ref={props.docScrollRef}>
        <Show
          when={hasDocument()}
          fallback={
            <Show
              when={isDrafting()}
              fallback={
                <div class="doc-empty">
                  <Icon name="doc" />
                  <p>文书预览将在 AI 生成结构化内容后显示</p>
                  <p class="sub">请描述起草需求，或等待当前回复完成</p>
                </div>
              }
            >
              <DocDraftingLoader />
            </Show>
          }
        >
          <Show when={docMode() === "edit"}>
            <div class="edit-toolbar">
              <button type="button" onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}>
                <Icon name="bold" />
              </button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}>
                <Icon name="italic" />
              </button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); exec("underline"); }}>
                <Icon name="underline" />
              </button>
              <span class="tb-sep" />
              <button type="button" onMouseDown={(e) => { e.preventDefault(); exec("formatBlock", "h3"); }}>
                <Icon name="heading" />
              </button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); exec("insertUnorderedList"); }}>
                <Icon name="list" />
              </button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); exec("formatBlock", "blockquote"); }}>
                <Icon name="quote" />
              </button>
              <span class="tb-sep" />
              <button
                type="button"
                class="insert-cite"
                onMouseDown={(e) => {
                  e.preventDefault();
                  props.onToggleCite(true);
                }}
              >
                <Icon name="book" />
                插入引用
              </button>
            </div>
          </Show>
          <div class={`sheet${docMode() === "edit" ? " editing" : ""}`} ref={props.sheetRef}>
            <div class="doc-head">
              <h1>{meta().title}</h1>
              <Show when={meta().en}>
                <div class="en">{meta().en}</div>
              </Show>
            </div>
            <div class="doc-rule sym" />

            <div contentEditable={docMode() === "edit"} spellcheck={false}>
              <Show when={meta().parties.length > 0}>
                <div class="parties">
                  <For each={meta().parties}>
                    {(p) => (
                      <div>
                        <span class="lbl">{p.lbl}</span>
                        <span class="ul">{p.name}</span>
                        {p.extra && <>　　{p.extra}</>}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={meta().recital.length > 0}>
                <div class="recital">{renderSegs(meta().recital, { sheet: true })}</div>
              </Show>

              <For each={articles()}>
                {(a: Article, i) => (
                  <div
                    class={`article${a.id === justAddedId() ? " justadded" : ""}`}
                    id={`art-${a.id}`}
                  >
                    <h3>
                      <span class="num">第{cnNum(i() + 1)}条</span>
                      {a.title}
                    </h3>
                    <For each={a.paras}>
                      {(para) => (
                        <p>
                          {renderSegs(para, {
                            sheet: true,
                            onCite: props.onCite,
                            onRisk: props.onRisk,
                          })}
                        </p>
                      )}
                    </For>
                    <Show when={a.note}>
                      <div class="doc-note" contentEditable={false}>
                        <div class="nh">
                          <Icon name="warn" />
                          {a.note!.title}
                        </div>
                        <div class="nb">{renderSegs(a.note!.body, { sheet: true })}</div>
                        <div class="nactions">
                          <button type="button" class="nbtn fix" onClick={props.onFix}>
                            采纳建议 · 补充条款
                          </button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
