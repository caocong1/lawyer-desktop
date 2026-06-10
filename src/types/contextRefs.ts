/** Local file or directory attached as LLM context for the next message. */
export interface ContextRefPayload {
  /** Short label shown in chat (e.g. filename or folder name). */
  alias: string;
  /** Absolute path within an allowed sandbox directory. */
  path: string;
  kind: "file" | "directory";
}
