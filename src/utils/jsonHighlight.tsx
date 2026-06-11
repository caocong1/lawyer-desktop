import type { JSX } from "solid-js";

/**
 * Lexical (not parse-based) JSON syntax highlighting, so partially
 * streamed / truncated JSON still gets colors.
 */

const TOKEN_RE =
  /("(?:\\.|[^"\\])*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|([^"\-\d{}[\],:\s]+|-)/g;

/** True when the trimmed text plausibly is (the start of) a JSON document. */
export function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[") || t.startsWith("```json");
}

/** Pretty-print if it parses; otherwise return the input untouched. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function highlightJson(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const [tok, str, num, kw, punc, ws] = m;
    if (str !== undefined) {
      // A string followed (after whitespace) by ':' is an object key.
      const rest = text.slice(TOKEN_RE.lastIndex);
      const isKey = /^\s*:/.test(rest);
      out.push(<span class={isKey ? "jh-key" : "jh-str"}>{tok}</span>);
    } else if (num !== undefined) {
      out.push(<span class="jh-num">{tok}</span>);
    } else if (kw !== undefined) {
      out.push(<span class={kw === "null" ? "jh-null" : "jh-bool"}>{tok}</span>);
    } else if (punc !== undefined) {
      out.push(<span class="jh-punc">{tok}</span>);
    } else if (ws !== undefined) {
      out.push(<span>{tok}</span>);
    } else {
      out.push(<span class="jh-plain">{tok}</span>);
    }
  }
  return out;
}
