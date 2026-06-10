import { For } from "solid-js";
import "./DocDraftingLoader.css";

const SK_WIDTHS = ["92%", "78%", "85%", "64%", "88%", "72%", "80%", "55%"];

/** Right panel skeleton only — no fake step animation. */
export function DocDraftingLoader() {
  return (
    <div class="doc-drafting">
      <div class="sheet doc-drafting-sheet">
        <div class="doc-head doc-drafting-head">
          <div class="sk-line sk-title" />
          <div class="sk-line sk-subtitle" />
        </div>
        <div class="doc-rule sym" />
        <div class="skeleton doc-drafting-body">
          <For each={SK_WIDTHS}>
            {(w) => <div class="sk-line" style={{ width: w }} />}
          </For>
        </div>
      </div>
    </div>
  );
}
