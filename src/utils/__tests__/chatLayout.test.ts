import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_MIN,
  PREVIEW_WIDTH_MIN,
  clampChatWidth,
  loadChatWidth,
  saveChatWidth,
  shouldShowPreview,
} from "../chatLayout";

afterEach(() => {
  localStorage.clear();
});

describe("clampChatWidth", () => {
  it("keeps a comfortable width unchanged", () => {
    expect(clampChatWidth(500, 1400)).toBe(500);
  });

  it("clamps below the chat minimum up to CHAT_WIDTH_MIN", () => {
    expect(clampChatWidth(100, 1400)).toBe(CHAT_WIDTH_MIN);
  });

  it("reserves PREVIEW_WIDTH_MIN for the preview pane", () => {
    expect(clampChatWidth(900, 1000)).toBe(1000 - PREVIEW_WIDTH_MIN);
  });

  it("never returns below CHAT_WIDTH_MIN even in a tiny window", () => {
    expect(clampChatWidth(500, 500)).toBe(CHAT_WIDTH_MIN);
  });
});

describe("loadChatWidth / saveChatWidth", () => {
  it("returns the default when nothing is stored", () => {
    expect(loadChatWidth()).toBe(CHAT_WIDTH_DEFAULT);
  });

  it("round-trips a saved width", () => {
    saveChatWidth(640);
    expect(loadChatWidth()).toBe(640);
  });

  it("falls back to default on a garbage value", () => {
    localStorage.setItem("molv.chatWidth", "not-a-number");
    expect(loadChatWidth()).toBe(CHAT_WIDTH_DEFAULT);
  });
});

describe("shouldShowPreview", () => {
  const base = {
    committedMode: null as "chat" | "draft" | "evidence" | null,
    workspaceMode: "idle" as "chat" | "draft" | "evidence" | "idle",
    hasLegalDocument: false,
    hasMarkdownDoc: false,
    draftWorkflowActive: false,
    activeEvidenceResponse: false,
  };

  it("hides for a pure chat conversation", () => {
    expect(shouldShowPreview(base)).toBe(false);
    expect(shouldShowPreview({ ...base, committedMode: "chat", workspaceMode: "chat" })).toBe(false);
  });

  it("shows once a draft task is committed", () => {
    expect(shouldShowPreview({ ...base, committedMode: "draft" })).toBe(true);
  });

  it("shows once an evidence task is committed", () => {
    expect(shouldShowPreview({ ...base, committedMode: "evidence" })).toBe(true);
  });

  it("shows while a draft/evidence turn is live before commit", () => {
    expect(shouldShowPreview({ ...base, workspaceMode: "draft" })).toBe(true);
    expect(shouldShowPreview({ ...base, draftWorkflowActive: true })).toBe(true);
    expect(shouldShowPreview({ ...base, activeEvidenceResponse: true })).toBe(true);
  });

  it("shows whenever a document already exists", () => {
    expect(shouldShowPreview({ ...base, hasLegalDocument: true })).toBe(true);
    expect(shouldShowPreview({ ...base, hasMarkdownDoc: true })).toBe(true);
  });
});
