import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameConversationMock = vi.fn();
const removeConversationMock = vi.fn();
const loadConversationsMock = vi.fn();

vi.mock("../../../stores/conversation", () => ({
  useConversation: () => ({
    conversations: () => [
      {
        id: "c1",
        title: "原标题",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "c2",
        title: "新会话",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    activeConversationId: () => "c1",
    loadConversations: loadConversationsMock,
    removeConversation: removeConversationMock,
    renameConversation: renameConversationMock,
  }),
}));

vi.mock("../../../utils/conversationTitle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/conversationTitle")>();
  return actual;
});

import { ConversationDrawer } from "../ConversationDrawer";

describe("ConversationDrawer rename interactions", () => {
  let toastMock: ReturnType<typeof vi.fn<(msg: string) => void>>;

  beforeEach(() => {
    renameConversationMock.mockReset();
    removeConversationMock.mockReset();
    loadConversationsMock.mockReset();
    renameConversationMock.mockResolvedValue(undefined);
    toastMock = vi.fn<(msg: string) => void>();
    // Avoid the native confirm() blocking the delete path during interactions.
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderDrawer() {
    return render(() => (
      <ConversationDrawer
        open
        onClose={() => undefined}
        onOpenConversation={(_id: string) => undefined}
        onToast={(msg: string) => toastMock(msg)}
      />
    ));
  }

  it("shows an edit button per row but keeps it hidden until hover/focus", () => {
    const { container } = renderDrawer();
    const editButtons = container.querySelectorAll(".conversation-icon-action");
    expect(editButtons.length).toBe(2);
  });

  it("clicking edit reveals an input pre-filled with the current title", () => {
    renderDrawer();
    const editButtons = screen.getAllByLabelText(/重命名/);
    fireEvent.click(editButtons[0]);
    const input = screen.getByLabelText("重命名会话") as HTMLInputElement;
    expect(input.value).toBe("原标题");
    expect(input.maxLength).toBe(30);
  });

  it("pressing Enter saves the trimmed title via renameConversation", async () => {
    renderDrawer();
    const editButtons = screen.getAllByLabelText(/重命名/);
    fireEvent.click(editButtons[0]);
    const input = screen.getByLabelText("重命名会话") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "  新合同审查  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(renameConversationMock).toHaveBeenCalledTimes(1);
    expect(renameConversationMock).toHaveBeenCalledWith("c1", "新合同审查");
  });

  it("pressing Escape cancels without calling renameConversation", () => {
    renderDrawer();
    const editButtons = screen.getAllByLabelText(/重命名/);
    fireEvent.click(editButtons[0]);
    const input = screen.getByLabelText("重命名会话") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "不会保存" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(renameConversationMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("重命名会话")).toBeNull();
  });

  it("rejects an empty input with a toast and keeps the row unedited", () => {
    renderDrawer();
    const editButtons = screen.getAllByLabelText(/重命名/);
    fireEvent.click(editButtons[0]);
    const input = screen.getByLabelText("重命名会话") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(renameConversationMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls[0][0]).toMatch(/不能为空/);
  });

  it("delete button still works while another row is being edited", () => {
    renderDrawer();
    // Open the editor on c1.
    fireEvent.click(screen.getAllByLabelText(/重命名/)[0]);
    expect(screen.getByLabelText("重命名会话")).toBeTruthy();
    // c1's actions are swapped out for the spinner while editing, so only
    // c2's delete button remains. Click it — confirm() returns true from the spy.
    const deleteButtons = screen.getAllByLabelText(/删除/);
    expect(deleteButtons).toHaveLength(1);
    fireEvent.click(deleteButtons[0]);
    expect(removeConversationMock).toHaveBeenCalledWith("c2");
  });

  it("surfaces an error toast when renameConversation fails", async () => {
    renameConversationMock.mockRejectedValueOnce(new Error("网络错误"));
    renderDrawer();
    fireEvent.click(screen.getAllByLabelText(/重命名/)[0]);
    const input = screen.getByLabelText("重命名会话") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "试试看" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls.at(-1)?.[0]).toMatch(/重命名失败/);
  });
});