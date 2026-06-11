import { For } from "solid-js";
import type { JSX } from "solid-js";
import type { TextSegment } from "../types/legal";

export interface RenderSegsOptions {
  onCite?: (key: string) => void;
  onRisk?: () => void;
  sheet?: boolean;
}

export function renderSegs(segs: readonly TextSegment[], opts: RenderSegsOptions = {}): JSX.Element {
  return (
    <For each={[...segs]}>
      {(s) => {
        if (s.b) return <b>{s.b}</b>;
        if (s.cite) {
          return (
            <span
              class={opts.sheet ? "cite-tag" : "cite-ref"}
              onClick={(e) => {
                e.stopPropagation();
                opts.onCite?.(s.cite!);
              }}
            >
              {s.t}
            </span>
          );
        }
        if (s.risk) {
          return (
            <span
              class="hl-risk"
              onClick={(e) => {
                e.stopPropagation();
                opts.onRisk?.();
              }}
            >
              {s.t}
            </span>
          );
        }
        if (s.accent) return <span class="accent">{s.t}</span>;
        return <>{s.t}</>;
      }}
    </For>
  ) as unknown as JSX.Element;
}
