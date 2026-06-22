import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  ClarificationCard,
  ModeSwitchCard,
  WorkflowNotice,
} from "../WorkflowProgressSteps";
import type { WorkflowState } from "../../../types/workflow";

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    message_id: "m1",
    conversation_id: "c1",
    mode: "draft",
    mode_label: "法律文书起草",
    status: "complete",
    steps: [
      { id: "intent", kind: "intent", label: "判断事项类型", state: "done" },
      { id: "complete", kind: "complete", label: "处理完成", state: "done" },
    ],
    ...overrides,
  };
}

describe("WorkflowNotice", () => {
  it("renders as a system notice and collapses completed steps by default", async () => {
    const { container } = render(() => <WorkflowNotice workflow={() => workflow()} />);

    expect(container.querySelector(".workflow-notice")).not.toBeNull();
    expect(container.querySelector(".msg-agent")).toBeNull();
    expect(screen.getByText("处理完成")).toBeTruthy();
    expect(screen.queryByText("判断事项类型")).toBeNull();

    fireEvent.click(screen.getByText("详情"));
    expect(await screen.findByText("判断事项类型")).toBeTruthy();
  });
});

describe("WorkflowNotice title", () => {
  it("labels a chat workflow as 法律问答 when no mode_label is set", () => {
    render(() => (
      <WorkflowNotice
        workflow={() => workflow({ mode: "chat", mode_label: undefined, status: "running" })}
      />
    ));
    expect(screen.getByText("法律问答")).toBeTruthy();
  });
});

describe("ModeSwitchCard", () => {
  it("offers switch / continue / custom and routes each action", () => {
    const onSwitch = vi.fn();
    const onContinue = vi.fn();
    const onCustom = vi.fn();
    render(() => (
      <ModeSwitchCard
        curLabel="股权转让协议起草"
        newLabel="房屋租赁合同起草"
        onSwitch={onSwitch}
        onContinue={onContinue}
        onCustom={onCustom}
      />
    ));

    fireEvent.click(screen.getByText("切换到「房屋租赁合同起草」"));
    expect(onSwitch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("继续完善「股权转让协议起草」"));
    expect(onContinue).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("都不是，我再说明…"));
    expect(onCustom).toHaveBeenCalledTimes(1);
  });
});

describe("ClarificationCard", () => {
  it("submits internal values but keeps the Chinese display label", () => {
    const onSubmit = vi.fn();
    render(() => (
      <ClarificationCard
        workflow={() =>
          workflow({
            status: "waiting",
            clarification: {
              id: "clarify",
              status: "pending",
              questions: [
                {
                  id: "amount",
                  question: "本次融资金额是否超过 5000 万元？",
                  allow_free_text: true,
                  options: [
                    { id: "above", label: "5000 万元以上", value: "above_50m" },
                  ],
                },
              ],
            },
          })
        }
        onClarificationSubmit={onSubmit}
      />
    ));

    fireEvent.click(screen.getByText("5000 万元以上"));
    fireEvent.click(screen.getByText("提交补充信息"));

    expect(onSubmit).toHaveBeenCalledWith("m1", [
      {
        question_id: "amount",
        question: "本次融资金额是否超过 5000 万元？",
        answer: "above_50m",
        display_answer: "5000 万元以上",
      },
    ]);
  });

  it("allows multiple selections when allow_multiple is true", () => {
    const onSubmit = vi.fn();
    render(() => (
      <ClarificationCard
        workflow={() =>
          workflow({
            status: "waiting",
            clarification: {
              id: "clarify",
              status: "pending",
              questions: [
                {
                  id: "types",
                  question: "涉及哪类业务？",
                  allow_multiple: true,
                  options: [
                    { id: "lease", label: "租赁", value: "lease" },
                    { id: "sale", label: "买卖", value: "sale" },
                  ],
                },
              ],
            },
          })
        }
        onClarificationSubmit={onSubmit}
      />
    ));

    expect(screen.getByText("（可多选）")).toBeTruthy();
    fireEvent.click(screen.getByText("租赁"));
    fireEvent.click(screen.getByText("买卖"));
    fireEvent.click(screen.getByText("提交补充信息"));

    expect(onSubmit).toHaveBeenCalledWith("m1", [
      {
        question_id: "types",
        question: "涉及哪类业务？",
        answer: "lease|sale",
        display_answer: "租赁、买卖",
      },
    ]);
  });

  it("maps old stored internal values back to Chinese labels", () => {
    render(() => (
      <ClarificationCard
        workflow={() =>
          workflow({
            clarification: {
              id: "clarify",
              status: "answered",
              answers: [
                {
                  question_id: "amount",
                  question: "本次融资金额是否超过 5000 万元？",
                  answer: "above_50m",
                },
              ],
              questions: [
                {
                  id: "amount",
                  question: "本次融资金额是否超过 5000 万元？",
                  options: [
                    { id: "above", label: "5000 万元以上", value: "above_50m" },
                  ],
                },
              ],
            },
          })
        }
      />
    ));

    expect(screen.getByText("已选：5000 万元以上")).toBeTruthy();
  });

  it("maps pipe-separated multi-select answers back to Chinese labels", () => {
    render(() => (
      <ClarificationCard
        workflow={() =>
          workflow({
            clarification: {
              id: "clarify",
              status: "answered",
              answers: [
                {
                  question_id: "types",
                  question: "涉及哪类业务？",
                  answer: "lease|sale",
                },
              ],
              questions: [
                {
                  id: "types",
                  question: "涉及哪类业务？",
                  allow_multiple: true,
                  options: [
                    { id: "lease", label: "租赁", value: "lease" },
                    { id: "sale", label: "买卖", value: "sale" },
                  ],
                },
              ],
            },
          })
        }
      />
    ));

    expect(screen.getByText("已选：租赁、买卖")).toBeTruthy();
  });
});
