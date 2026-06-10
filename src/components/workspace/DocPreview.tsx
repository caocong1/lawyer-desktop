import { For, Show } from "solid-js";
import { seed, cnNum } from "../../data/seed";
import type { Article } from "../../data/seed";
import { useConversation } from "../../stores/conversation";
import { renderSegs } from "../../utils/renderSegs";
import { Icon } from "../icons/Icons";
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
  const { articles, docMode, setDocMode, justAddedId } = useConversation();
  const doc = seed.doc;

  function exec(cmd: string, val: string | null = null) {
    document.execCommand(cmd, false, val ?? undefined);
  }

  return (
    <div class="doc">
      <div class="doc-tb">
        <span class="doc-title">{doc.title}</span>
        <span class="ver-pill">第 {3 + (articles().length - 5)} 稿</span>
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
          >
            编辑
          </button>
        </div>
        <button type="button" class="dbtn" onClick={() => props.onToggleCite()}>
          <Icon name="book" />
          引用
        </button>
        <button
          type="button"
          class="dbtn"
          onClick={() => props.onToast("已对比上一稿：新增 1 条、修改 2 处")}
        >
          <Icon name="diff" />
          对比
        </button>
        <button
          type="button"
          class="dbtn prim"
          onClick={() => props.onToast("已导出 股权转让协议.docx")}
        >
          <Icon name="download" />
          导出
        </button>
      </div>

      <div class="doc-scroll scroll" ref={props.docScrollRef}>
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
            <h1>{doc.title}</h1>
            <div class="en">{doc.en}</div>
          </div>
          <div class="doc-rule sym" />

          <div contentEditable={docMode() === "edit"} spellcheck={false}>
              <div class="parties">
                <For each={doc.parties}>
                  {(p) => (
                    <div>
                      <span class="lbl">{p.lbl}</span>
                      <span class="ul">{p.name}</span>
                      {p.extra && <>　　{p.extra}</>}
                    </div>
                  )}
                </For>
              </div>
              <div class="recital">{renderSegs(doc.recital, { sheet: true })}</div>

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
                          <button type="button" class="nbtn" onClick={() => props.onCite("case1")}>
                            查看判例
                          </button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
        </div>
      </div>
    </div>
  );
}
