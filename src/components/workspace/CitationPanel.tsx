import { For } from "solid-js";
import { seed } from "../../data/seed";
import type { Citation } from "../../data/seed";
import { renderSegs } from "../../utils/renderSegs";
import { Icon } from "../icons/Icons";
import "./CitationPanel.css";

export interface CitationPanelProps {
  open: boolean;
  tab: "law" | "case";
  activeKey: string | null;
  onClose: () => void;
  onTab: (tab: "law" | "case") => void;
  onInsert: (c: Citation) => void;
  onLocate: (c: Citation) => void;
}

export function CitationPanel(props: CitationPanelProps) {
  const list = () => (props.tab === "case" ? seed.citations.case : seed.citations.law);

  return (
    <div class={`cite-panel${props.open ? " open" : ""}`}>
      <div class="cp-h">
        <Icon name="book" style={{ width: "18px", height: "18px", color: "var(--accent)" }} />
        <span class="t">引用来源</span>
        <span class="grow" />
        <button type="button" class="cp-close" onClick={props.onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div class="cp-tabs">
        <div
          class={`cp-tab${props.tab === "law" ? " on" : ""}`}
          onClick={() => props.onTab("law")}
        >
          法条（{seed.citations.law.length}）
        </div>
        <div
          class={`cp-tab${props.tab === "case" ? " on" : ""}`}
          onClick={() => props.onTab("case")}
        >
          判例 · 类案（{seed.citations.case.length}）
        </div>
      </div>
      <div class="cp-body scroll">
        <For each={list()}>
          {(c) => (
            <div
              class={`cite-card${c.key === props.activeKey ? " active" : ""}`}
              id={`cc-${c.key}`}
            >
              <div class="cc-tag">
                <Icon
                  name={props.tab === "case" ? "gavel" : "scale"}
                  style={{ width: "12px", height: "12px" }}
                />
                {c.tag}
              </div>
              <div class="cc-title">{c.title}</div>
              <div class="cc-src">{c.src}</div>
              <div class="cc-text">{c.text}</div>
              <div class="cc-rel">{renderSegs(c.rel, {})}</div>
              <div class="cc-actions">
                <button type="button" class="cc-btn prim" onClick={() => props.onInsert(c)}>
                  <Icon name="plus" />
                  插入引用
                </button>
                <button type="button" class="cc-btn" onClick={() => props.onLocate(c)}>
                  <Icon name="locate" />
                  在文中定位
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
