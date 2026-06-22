import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/api", () => ({
  updateConversationTitle: vi.fn(),
}));

import * as api from "../../services/api";
import { useConversation } from "../conversation";

const mockedUpdateTitle = vi.mocked(api.updateConversationTitle);

describe("conversation store renameConversation", () => {
  beforeEach(() => {
    mockedUpdateTitle.mockReset();
    mockedUpdateTitle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists via updateConversationTitle and patches local state", async () => {
    const conv = {
      id: "rename-1",
      title: "新会话",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const { addConversation, renameConversation, conversations } = useConversation();
    addConversation(conv);

    await renameConversation(conv.id, "  股权转让协议起草  ");

    expect(mockedUpdateTitle).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTitle).toHaveBeenCalledWith("rename-1", "股权转让协议起草");
    const after = conversations().find((c) => c.id === conv.id);
    expect(after?.title).toBe("股权转让协议起草");
  });

  it("surfaces an error toast when the backend call fails", async () => {
    const conv = {
      id: "rename-2",
      title: "新会话",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const { addConversation, renameConversation, conversations } = useConversation();
    addConversation(conv);
    mockedUpdateTitle.mockRejectedValueOnce(new Error("network down"));

    await expect(renameConversation(conv.id, "新标题")).rejects.toThrow("network down");

    // Local title must not be patched when persistence fails.
    const after = conversations().find((c) => c.id === conv.id);
    expect(after?.title).toBe("新会话");
  });
});