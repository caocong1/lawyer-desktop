import { describe, expect, test } from "bun:test";
import {
  dedupeWithTriage,
  type FeedbackRecord,
  type TriageEntry,
} from "./feedback-store";

function rec(
  remote_id: string,
  feedback_id: string | undefined,
  rating: string,
  received_at: string,
): FeedbackRecord {
  return {
    remote_id,
    outbox_id: "o-" + remote_id,
    device_id: "d1",
    app_version: "1",
    skills_version: null,
    payload: { feedback_id, message_id: "m1", rating },
    received_at,
  };
}

describe("dedupeWithTriage", () => {
  test("collapses same feedback_id to latest received_at", () => {
    const out = dedupeWithTriage(
      [
        rec("r1", "fb1", "up", "2026-06-18T10:00:00Z"),
        rec("r2", "fb1", "down", "2026-06-18T11:00:00Z"),
      ],
      {},
    );
    expect(out.length).toBe(1);
    expect(out[0].remote_id).toBe("r2");
    expect(out[0].payload.rating).toBe("down");
  });

  test("inherits non-default triage from an older remote_id", () => {
    const triage: Record<string, TriageEntry> = {
      r1: { status: "triaged", notes: "important", updated_at: "2026-06-18T10:30:00Z" },
    };
    const out = dedupeWithTriage(
      [
        rec("r1", "fb1", "up", "2026-06-18T10:00:00Z"),
        rec("r2", "fb1", "down", "2026-06-18T11:00:00Z"),
      ],
      triage,
    );
    expect(out[0].triage.status).toBe("triaged");
    expect(out[0].triage.notes).toBe("important");
  });

  test("records without feedback_id are not collapsed", () => {
    const out = dedupeWithTriage(
      [
        rec("r1", undefined, "up", "2026-06-18T10:00:00Z"),
        rec("r2", undefined, "up", "2026-06-18T11:00:00Z"),
      ],
      {},
    );
    expect(out.length).toBe(2);
  });
});
