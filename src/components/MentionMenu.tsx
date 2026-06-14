import { For, Show } from "solid-js";
import type { ContextRefPayload } from "../types/contextRefs";
import { Icon } from "./icons/Icons";
import "./MentionMenu.css";

export interface MentionMenuProps {
  candidates: ContextRefPayload[];
  selectedIndex: number;
  onSelect: (ref: ContextRefPayload) => void;
  onDismiss: () => void;
}

export function MentionMenu(props: MentionMenuProps) {
  return (
    <div class="mention-menu" role="listbox">
      <Show
        when={props.candidates.length > 0}
        fallback={<div class="mention-empty">无可引用资料</div>}
      >
        <For each={props.candidates}>
          {(ref, index) => (
            <button
              type="button"
              class={`mention-item${index() === props.selectedIndex ? " active" : ""}`}
              role="option"
              aria-selected={index() === props.selectedIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onSelect(ref);
              }}
            >
              <span class="mention-item-icon">
                <Icon name={ref.kind === "directory" ? "folder" : "file2"} />
              </span>
              <span class="mention-item-name">@{ref.alias}</span>
              <span class="mention-item-kind">
                {ref.kind === "directory" ? "文件夹" : "文件"}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  );
}
