# Editable Message Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit and re-submit feedback after marking 👍/👎, keeping exactly one latest-wins record per message across the local DB, the upload outbox, and the remote sync service.

**Architecture:** Three layers. (1) Frontend: the feedback control stays interactive after marking; rating/comment/dimensions are pre-filled and editable; all submits reuse the existing `submit()` path. (2) Local Rust backend: `skill_feedback` becomes an upsert keyed on `message_id` (stable feedback id); the outbox supersedes still-pending uploads for the same feedback before enqueuing the new one. (3) Remote `tools/sync-service`: the append-only JSONL log is collapsed at read time by `feedback_id` (latest `received_at` wins), with triage inherited across the collapsed group, so admin views and counts never double-count.

**Tech Stack:** SolidJS + TypeScript (frontend, vitest + `@solidjs/testing-library`), Rust + sqlx 0.8 (sqlite, runtime-tokio) in `src-tauri`, Bun + `bun:test` for `tools/sync-service`.

## Global Constraints

- Reference spec: `docs/superpowers/specs/2026-06-18-editable-message-feedback-design.md` — read it before starting.
- Decision is **latest-wins, no revision history**. One record per message everywhere.
- The remote JSONL log stays **append-only**; dedup is read-time only. No remote data migration.
- Schema changes follow the existing idempotent idiom: an `ensure_*_schema()` function that `raw_sql`s a migration file and/or does runtime `pragma_table_info` `ALTER TABLE` checks (see `src-tauri/src/db/queries.rs:497-525`). Do **not** add a numbered `tauri_plugin_sql::Migration` (that path only registers version 1).
- Do not change the upload batch protocol (`POST /api/feedback/batch`) or the triage write protocol (`POST /api/feedback/triage`).
- The frontend submit contract (`submitMessageFeedback` request shape) does **not** change.
- Commit after each task. Follow the repo's existing commit-message style (`feat:` / `test:` / `refactor:` prefixes).
- In-memory sqlite test pools MUST set `.max_connections(1)` (otherwise each pooled connection gets a separate `:memory:` database and the schema/test rows vanish between calls).

---

## File Structure

- `src-tauri/migrations/006_feedback_dedup.sql` — **new**. Dedup historical `skill_feedback` rows + unique index on `message_id`.
- `src-tauri/src/db/queries.rs` — modify `insert_skill_feedback` (→ upsert), extend `ensure_skill_opt_schema` (run 006) and `ensure_sync_schema` (add `feedback_outbox.feedback_id` column + index); add a `#[cfg(test)]` module.
- `src-tauri/src/sync/outbox.rs` — add `feedback_id` to `enqueue_feedback`, add `supersede_pending_feedback`, add a `#[cfg(test)]` module.
- `src-tauri/src/commands/skillopt.rs` — wire submit order: upsert → supersede → enqueue(feedback_id); add `updated_at` to payload.
- `tools/sync-service/src/feedback-store.ts` — add `dedupeWithTriage()` (+ helpers); `feedback-store.test.ts` (new).
- `tools/sync-service/src/server.ts` — `loadMergedFeedback` uses `dedupeWithTriage`.
- `src/components/workspace/messageFeedbackLogic.ts` — **new** pure helpers (`feedbackStatusText`, `ratingClickAction`).
- `src/components/workspace/MessageFeedback.tsx` — unify into one always-visible control using the helpers.
- `src/components/workspace/MessageFeedback.css` — `.msg-feedback-btn.active`, `.msg-feedback-status`.
- `src/components/workspace/__tests__/messageFeedbackLogic.test.ts` — **new**.

---

## Task 1: Local upsert — one `skill_feedback` row per message

**Files:**
- Create: `src-tauri/migrations/006_feedback_dedup.sql`
- Modify: `src-tauri/src/db/queries.rs` (`ensure_skill_opt_schema` ~497-504, `insert_skill_feedback` ~678-717)
- Test: `src-tauri/src/db/queries.rs` (new `#[cfg(test)] mod feedback_tests`)

**Interfaces:**
- Consumes: existing `row_to_skill_feedback(&SqliteRow) -> anyhow::Result<SkillFeedbackRow>` (queries.rs:1051), `SkillFeedbackRow` struct (queries.rs:665).
- Produces: `insert_skill_feedback(...) -> anyhow::Result<SkillFeedbackRow>` now upserts by `message_id` and returns the row with a **stable** `id` across edits.

- [ ] **Step 1: Write the migration file**

Create `src-tauri/migrations/006_feedback_dedup.sql`:

```sql
-- Collapse skill_feedback to one row per message_id (keep the latest), then enforce uniqueness.
-- Idempotent: re-running deletes nothing once unique, and the index create is IF NOT EXISTS.

DELETE FROM skill_feedback
WHERE rowid NOT IN (
    SELECT MIN(s2.rowid) FROM skill_feedback s2
    WHERE s2.created_at = (
        SELECT MAX(s3.created_at) FROM skill_feedback s3 WHERE s3.message_id = s2.message_id
    )
    GROUP BY s2.message_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_feedback_message ON skill_feedback(message_id);
```

- [ ] **Step 2: Wire the migration into `ensure_skill_opt_schema`**

In `src-tauri/src/db/queries.rs`, replace the body of `ensure_skill_opt_schema`:

```rust
pub async fn ensure_skill_opt_schema(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    let sql = include_str!("../../migrations/004_skill_opt.sql");
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .context("failed to apply skill_opt schema")?;

    let dedup_sql = include_str!("../../migrations/006_feedback_dedup.sql");
    sqlx::raw_sql(dedup_sql)
        .execute(pool)
        .await
        .context("failed to apply feedback dedup schema")?;
    Ok(())
}
```

- [ ] **Step 3: Convert `insert_skill_feedback` to an upsert**

Replace the function body (keep the signature identical):

```rust
pub async fn insert_skill_feedback(
    pool: &Pool<Sqlite>,
    message_id: &str,
    conversation_id: &str,
    skill_name: Option<&str>,
    plugin_name: Option<&str>,
    rating: &str,
    comment: Option<&str>,
    dimensions_json: Option<&str>,
) -> anyhow::Result<SkillFeedbackRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO skill_feedback (id, message_id, conversation_id, skill_name, plugin_name, rating, comment, dimensions_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(message_id) DO UPDATE SET \
            conversation_id = excluded.conversation_id, \
            skill_name = excluded.skill_name, \
            plugin_name = excluded.plugin_name, \
            rating = excluded.rating, \
            comment = excluded.comment, \
            dimensions_json = excluded.dimensions_json, \
            created_at = excluded.created_at",
    )
    .bind(&id)
    .bind(message_id)
    .bind(conversation_id)
    .bind(skill_name)
    .bind(plugin_name)
    .bind(rating)
    .bind(comment)
    .bind(dimensions_json)
    .bind(&now)
    .execute(pool)
    .await
    .context("upsert skill_feedback")?;

    let row = sqlx::query(
        "SELECT id, message_id, conversation_id, skill_name, plugin_name, rating, comment, dimensions_json, created_at \
         FROM skill_feedback WHERE message_id = ?",
    )
    .bind(message_id)
    .fetch_one(pool)
    .await
    .context("fetch upserted skill_feedback")?;
    row_to_skill_feedback(&row)
}
```

- [ ] **Step 4: Write the failing test**

Append to the end of `src-tauri/src/db/queries.rs`:

```rust
#[cfg(test)]
mod feedback_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> Pool<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/004_skill_opt.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/006_feedback_dedup.sql"))
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn upsert_keeps_single_row_and_stable_id() {
        let pool = test_pool().await;
        let first =
            insert_skill_feedback(&pool, "m1", "c1", Some("s"), None, "up", None, None)
                .await
                .unwrap();
        let second = insert_skill_feedback(
            &pool,
            "m1",
            "c1",
            Some("s"),
            None,
            "down",
            Some("needs work"),
            Some("[\"法条\"]"),
        )
        .await
        .unwrap();

        assert_eq!(first.id, second.id, "feedback id stays stable across edits");
        assert_eq!(second.rating, "down");
        assert_eq!(second.comment.as_deref(), Some("needs work"));

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM skill_feedback WHERE message_id = ?")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 1, "only one row per message_id");
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test feedback_tests::upsert_keeps_single_row_and_stable_id -- --nocapture`
Expected: PASS (1 passed).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/migrations/006_feedback_dedup.sql src-tauri/src/db/queries.rs
git commit -m "feat(feedback): upsert skill_feedback by message_id (latest wins)"
```

---

## Task 2: Outbox — track `feedback_id` and supersede un-sent uploads

**Files:**
- Modify: `src-tauri/src/db/queries.rs` (`ensure_sync_schema` ~506-525)
- Modify: `src-tauri/src/sync/outbox.rs` (`enqueue_feedback` ~18-43; add `supersede_pending_feedback`)
- Test: `src-tauri/src/sync/outbox.rs` (new `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `feedback_outbox` table (migration 005), `FeedbackOutboxRow` struct (outbox.rs:5).
- Produces:
  - `enqueue_feedback(pool: &Pool<Sqlite>, feedback_id: &str, payload_json: &str) -> anyhow::Result<FeedbackOutboxRow>` (note the **new** `feedback_id` param, inserted before `payload_json`).
  - `supersede_pending_feedback(pool: &Pool<Sqlite>, feedback_id: &str) -> anyhow::Result<u64>` (deletes `status='pending'` rows for that feedback, returns count).

- [ ] **Step 1: Add the `feedback_id` column + index in `ensure_sync_schema`**

In `src-tauri/src/db/queries.rs`, append to `ensure_sync_schema` (after the existing `005` `raw_sql` block, before `Ok(())`):

```rust
    let has_fb_col: Option<(i64,)> = sqlx::query_as(
        "SELECT COUNT(*) FROM pragma_table_info('feedback_outbox') WHERE name = 'feedback_id'",
    )
    .fetch_optional(pool)
    .await?;
    if has_fb_col.map(|(c,)| c).unwrap_or(0) == 0 {
        sqlx::query("ALTER TABLE feedback_outbox ADD COLUMN feedback_id TEXT")
            .execute(pool)
            .await
            .context("failed to add feedback_outbox.feedback_id")?;
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_feedback_outbox_feedback_id ON feedback_outbox(feedback_id)",
    )
    .execute(pool)
    .await
    .context("failed to index feedback_outbox.feedback_id")?;
```

- [ ] **Step 2: Update `enqueue_feedback` and add `supersede_pending_feedback`**

In `src-tauri/src/sync/outbox.rs`, replace `enqueue_feedback` and add the new function right after it:

```rust
pub async fn enqueue_feedback(
    pool: &Pool<Sqlite>,
    feedback_id: &str,
    payload_json: &str,
) -> anyhow::Result<FeedbackOutboxRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO feedback_outbox (id, feedback_id, payload_json, status, attempt_count, next_retry_at, created_at, updated_at) \
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(feedback_id)
    .bind(payload_json)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(FeedbackOutboxRow {
        id,
        payload_json: payload_json.to_string(),
        status: "pending".into(),
        attempt_count: 0,
        next_retry_at: Some(now.clone()),
        last_error: None,
        remote_id: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Drop still-pending (not yet sent) outbox rows for this feedback so an edit
/// made before the upload flushes does not ship a stale version. Rows already
/// `sending`/`sent`/`failed` are left untouched.
pub async fn supersede_pending_feedback(
    pool: &Pool<Sqlite>,
    feedback_id: &str,
) -> anyhow::Result<u64> {
    let res = sqlx::query("DELETE FROM feedback_outbox WHERE feedback_id = ? AND status = 'pending'")
        .bind(feedback_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}
```

- [ ] **Step 3: Write the failing test**

Append to the end of `src-tauri/src/sync/outbox.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> Pool<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/005_sync_skill_update.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE feedback_outbox ADD COLUMN feedback_id TEXT")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn supersede_removes_only_pending_same_feedback() {
        let pool = test_pool().await;
        enqueue_feedback(&pool, "fb1", "{\"v\":1}").await.unwrap();
        enqueue_feedback(&pool, "fb1", "{\"v\":2}").await.unwrap();
        enqueue_feedback(&pool, "fb2", "{\"v\":1}").await.unwrap();

        // fb2 already shipped — must survive supersede.
        sqlx::query("UPDATE feedback_outbox SET status='sent' WHERE feedback_id='fb2'")
            .execute(&pool)
            .await
            .unwrap();

        let removed = supersede_pending_feedback(&pool, "fb1").await.unwrap();
        assert_eq!(removed, 2, "both pending fb1 rows dropped");

        let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM feedback_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total.0, 1, "only the sent fb2 row remains");

        let removed_sent = supersede_pending_feedback(&pool, "fb2").await.unwrap();
        assert_eq!(removed_sent, 0, "sent rows are never superseded");
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib outbox::tests::supersede_removes_only_pending_same_feedback -- --nocapture`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/queries.rs src-tauri/src/sync/outbox.rs
git commit -m "feat(sync): track feedback_id in outbox and supersede pending uploads"
```

---

## Task 3: Wire the submit command (upsert → supersede → enqueue)

**Files:**
- Modify: `src-tauri/src/commands/skillopt.rs` (`submit_message_feedback` ~67-152, payload ~129-149)

**Interfaces:**
- Consumes: `insert_skill_feedback` (Task 1), `supersede_pending_feedback` + new `enqueue_feedback` signature (Task 2).
- Produces: no API change; same returned `SkillFeedbackRow`. Payload now carries `updated_at`.

- [ ] **Step 1: Add `updated_at` to the payload**

In `src-tauri/src/commands/skillopt.rs`, in the `serde_json::json!` payload, add an `updated_at` line right after `"created_at": row.created_at,`:

```rust
        "created_at": row.created_at,
        "updated_at": row.created_at,
    });
```

- [ ] **Step 2: Supersede pending uploads, then enqueue with the feedback id**

Replace the existing enqueue call:

```rust
    crate::sync::outbox::enqueue_feedback(&db, &payload.to_string())
        .await
        .map_err(|e| e.to_string())?;
```

with:

```rust
    crate::sync::outbox::supersede_pending_feedback(&db, &row.id)
        .await
        .map_err(|e| e.to_string())?;
    crate::sync::outbox::enqueue_feedback(&db, &row.id, &payload.to_string())
        .await
        .map_err(|e| e.to_string())?;
```

- [ ] **Step 3: Verify the whole crate compiles and all tests pass**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS — including `feedback_tests::*` and `outbox::tests::*` from Tasks 1–2. No compile errors. (This task is integration glue; its behavior is unit-tested via Tasks 1 and 2. A green `cargo test --lib` plus successful compilation is the gate.)

- [ ] **Step 4: Lint**

Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings`
Expected: no warnings introduced by the changed files.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/skillopt.rs
git commit -m "feat(feedback): resubmit replaces local row and supersedes pending upload"
```

---

## Task 4: Remote — collapse uploads by `feedback_id` with triage inheritance

**Files:**
- Modify: `tools/sync-service/src/feedback-store.ts` (add helpers + `dedupeWithTriage`)
- Modify: `tools/sync-service/src/server.ts` (`loadMergedFeedback` ~136-140)
- Test: `tools/sync-service/src/feedback-store.test.ts` (new)

**Interfaces:**
- Consumes: `FeedbackRecord`, `TriageEntry`, `FeedbackWithTriage`, `defaultTriage()` (feedback-store.ts).
- Produces: `dedupeWithTriage(records: FeedbackRecord[], triageMap: Record<string, TriageEntry>): FeedbackWithTriage[]` — one item per `feedback_id` (latest `received_at`), triage inherited from the newest non-default triage in the group; records lacking `feedback_id` are keyed by `remote_id` and never collapsed.

- [ ] **Step 1: Write the failing test**

Create `tools/sync-service/src/feedback-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/sync-service && bun test src/feedback-store.test.ts`
Expected: FAIL with `dedupeWithTriage is not a function` / export missing.

- [ ] **Step 3: Implement `dedupeWithTriage` + helpers**

In `tools/sync-service/src/feedback-store.ts`, add at the end of the file:

```ts
function recordRecency(r: FeedbackRecord): number {
  const t = r.received_at || r.payload?.updated_at || r.payload?.created_at || "";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

function isNonDefaultTriage(t: TriageEntry | undefined): boolean {
  if (!t) return false;
  return (
    t.status !== "open" ||
    Boolean(t.notes) ||
    Boolean(t.linked_issue) ||
    Boolean(t.target_repo)
  );
}

/**
 * Collapse the append-only feedback log to one record per feedback_id (the one
 * with the newest received_at). Records without a feedback_id are keyed by their
 * remote_id so legacy uploads are never merged. The kept record inherits the most
 * recently updated non-default triage from anywhere in its group, so editing a
 * feedback never drops an existing triage decision.
 */
export function dedupeWithTriage(
  records: FeedbackRecord[],
  triageMap: Record<string, TriageEntry>,
): FeedbackWithTriage[] {
  const groups = new Map<string, FeedbackRecord[]>();
  for (const r of records) {
    const key = r.payload?.feedback_id ?? `__no_fb__:${r.remote_id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: FeedbackWithTriage[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => recordRecency(b) - recordRecency(a));
    const kept = list[0];

    let triage = triageMap[kept.remote_id];
    if (!isNonDefaultTriage(triage)) {
      const inherited = list
        .map((r) => triageMap[r.remote_id])
        .filter((t): t is TriageEntry => isNonDefaultTriage(t))
        .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];
      if (inherited) triage = inherited;
    }

    out.push({ ...kept, triage: triage ?? defaultTriage() });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/sync-service && bun test src/feedback-store.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Use it in `loadMergedFeedback`**

In `tools/sync-service/src/server.ts`, update the import from `./feedback-store` to include `dedupeWithTriage` (and you may drop `mergeTriage` from the import only if unused elsewhere — verify first), then replace `loadMergedFeedback`:

```ts
async function loadMergedFeedback() {
  const records = await loadAllFeedback(FEEDBACK_LOG);
  const triage = await loadTriage(TRIAGE_PATH);
  return dedupeWithTriage(records, triage);
}
```

- [ ] **Step 6: Verify the service typechecks/builds and the full suite passes**

Run: `cd tools/sync-service && bun test && bun build src/server.ts --target bun --outfile /dev/null`
Expected: tests PASS; build completes with no type/import errors. (If `mergeTriage` is now unused, either keep it exported or remove its import to satisfy the build.)

- [ ] **Step 7: Commit**

```bash
git add tools/sync-service/src/feedback-store.ts tools/sync-service/src/feedback-store.test.ts tools/sync-service/src/server.ts
git commit -m "feat(sync-service): dedupe feedback by feedback_id with triage inheritance"
```

---

## Task 5: Frontend — keep feedback editable after marking

**Files:**
- Create: `src/components/workspace/messageFeedbackLogic.ts`
- Create: `src/components/workspace/__tests__/messageFeedbackLogic.test.ts`
- Modify: `src/components/workspace/MessageFeedback.tsx`
- Modify: `src/components/workspace/MessageFeedback.css`

**Interfaces:**
- Consumes: `MessageMetadata["feedback"]` shape `{ rating: "up"|"down"; comment?: string; dimensions?: string[]; at: string }` (types/workflow.ts:73-78); existing `submit(rating)` flow and `submitMessageFeedback` / `persistMessageFeedback`.
- Produces (pure helpers):
  - `feedbackStatusText(fb): string` — caption like `✓ 已标记：有帮助 · 法条、结构` (empty string when no feedback).
  - `ratingClickAction(current: Rating | undefined, clicked: Rating): "submit-up" | "open-form"`.

- [ ] **Step 1: Write the failing test**

Create `src/components/workspace/__tests__/messageFeedbackLogic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  feedbackStatusText,
  ratingClickAction,
} from "../messageFeedbackLogic";

describe("feedbackStatusText", () => {
  it("renders up with dimensions", () => {
    expect(
      feedbackStatusText({ rating: "up", dimensions: ["法条", "结构"], at: "x" }),
    ).toBe("✓ 已标记：有帮助 · 法条、结构");
  });
  it("renders down without dimensions", () => {
    expect(feedbackStatusText({ rating: "down", at: "x" })).toBe("✓ 已标记：需改进");
  });
  it("is empty when no feedback", () => {
    expect(feedbackStatusText(undefined)).toBe("");
  });
});

describe("ratingClickAction", () => {
  it("submits up when not yet up", () => {
    expect(ratingClickAction(undefined, "up")).toBe("submit-up");
    expect(ratingClickAction("down", "up")).toBe("submit-up");
  });
  it("opens the form when re-clicking the active up", () => {
    expect(ratingClickAction("up", "up")).toBe("open-form");
  });
  it("opens the form for down (to capture a reason)", () => {
    expect(ratingClickAction(undefined, "down")).toBe("open-form");
    expect(ratingClickAction("up", "down")).toBe("open-form");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/workspace/__tests__/messageFeedbackLogic.test.ts`
Expected: FAIL — cannot resolve `../messageFeedbackLogic`.

- [ ] **Step 3: Implement the pure helpers**

Create `src/components/workspace/messageFeedbackLogic.ts`:

```ts
export type Rating = "up" | "down";

export interface FeedbackState {
  rating: Rating;
  comment?: string;
  dimensions?: string[];
  at: string;
}

export function feedbackStatusText(fb: FeedbackState | undefined): string {
  if (!fb) return "";
  const base = fb.rating === "up" ? "已标记：有帮助" : "已标记：需改进";
  const dims = fb.dimensions?.length ? ` · ${fb.dimensions.join("、")}` : "";
  return `✓ ${base}${dims}`;
}

/**
 * Decide what a click on a rating button does when feedback may already exist.
 * - Clicking 👎 always opens the form (encourage a reason).
 * - Clicking the already-active 👍 opens the form to edit the note (no dead re-upload).
 * - Otherwise switch to 👍 and submit immediately.
 */
export function ratingClickAction(
  current: Rating | undefined,
  clicked: Rating,
): "submit-up" | "open-form" {
  if (clicked === "down") return "open-form";
  if (current === "up") return "open-form";
  return "submit-up";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/workspace/__tests__/messageFeedbackLogic.test.ts`
Expected: PASS (6 pass).

- [ ] **Step 5: Rewrite `MessageFeedback.tsx` to one always-visible control**

Replace the entire contents of `src/components/workspace/MessageFeedback.tsx`:

```tsx
import { createSignal, Show, For } from "solid-js";
import type { Message } from "../../stores/conversation";
import { submitMessageFeedback, getAppVersion, getSyncSettings } from "../../services/api";
import { useConversation } from "../../stores/conversation";
import type { MessageMetadata } from "../../types/workflow";
import { feedbackStatusText, ratingClickAction } from "./messageFeedbackLogic";
import "./MessageFeedback.css";

const DIMENSIONS = ["案由", "法条", "结构", "检索", "其他"] as const;

export interface MessageFeedbackProps {
  message: Message;
  disabled?: boolean;
}

function skillFromMessage(msg: Message): { name?: string; plugin?: string } {
  const meta = msg.metadata as MessageMetadata | undefined;
  if (meta?.active_skill) {
    return { name: meta.active_skill.name, plugin: meta.active_skill.plugin_name };
  }
  const workflow = meta?.workflow;
  const skillStep = workflow?.steps?.find((s) => s.kind === "skill");
  if (skillStep?.detail) {
    const m = skillStep.detail.match(/「(.+?)」/);
    if (m) return { name: m[1] };
  }
  return {};
}

export function MessageFeedback(props: MessageFeedbackProps) {
  const { activeConversationId, persistMessageFeedback } = useConversation();
  const existing = () => (props.message.metadata as MessageMetadata | undefined)?.feedback;

  const initialDims = existing()?.dimensions;
  const [expanded, setExpanded] = createSignal(false);
  const [comment, setComment] = createSignal(existing()?.comment ?? "");
  const [dims, setDims] = createSignal<string[]>(initialDims ? [...initialDims] : []);
  const [submitting, setSubmitting] = createSignal(false);

  const toggleDim = (d: string) => {
    setDims((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  const submit = async (rating: "up" | "down") => {
    const convId = activeConversationId();
    if (!convId || submitting()) return;
    setSubmitting(true);
    const skill = skillFromMessage(props.message);
    try {
      const [appVersion, syncSettings] = await Promise.all([
        getAppVersion(),
        getSyncSettings(),
      ]);
      await submitMessageFeedback({
        message_id: props.message.id,
        conversation_id: convId,
        skill_name: skill.name,
        plugin_name: skill.plugin,
        rating,
        comment: comment().trim() || undefined,
        dimensions: dims().length ? dims() : undefined,
        app_version: appVersion,
        skills_version: syncSettings.skills_version ?? undefined,
      });
      persistMessageFeedback(props.message.id, {
        rating,
        comment: comment().trim() || undefined,
        dimensions: dims().length ? dims() : undefined,
        at: new Date().toISOString(),
      });
      setExpanded(false);
    } catch (e) {
      console.warn("反馈提交失败:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const onRate = (rating: "up" | "down") => {
    const action = ratingClickAction(existing()?.rating, rating);
    if (action === "open-form") {
      setExpanded(true);
      return;
    }
    void submit("up");
  };

  return (
    <div class="msg-feedback">
      <div class="msg-feedback-actions">
        <button
          type="button"
          class={`msg-feedback-btn${existing()?.rating === "up" ? " active" : ""}`}
          disabled={props.disabled || submitting()}
          title="有帮助"
          onClick={() => onRate("up")}
        >
          👍
        </button>
        <button
          type="button"
          class={`msg-feedback-btn${existing()?.rating === "down" ? " active" : ""}`}
          disabled={props.disabled || submitting()}
          title="需改进"
          onClick={() => onRate("down")}
        >
          👎
        </button>
        <button
          type="button"
          class="msg-feedback-link"
          disabled={props.disabled}
          onClick={() => setExpanded((v) => !v)}
        >
          {existing() ? "修改补充说明" : "补充说明"}
        </button>
      </div>

      <Show when={existing()}>
        <div class="msg-feedback-status" title={existing()?.comment}>
          {feedbackStatusText(existing())}
        </div>
      </Show>

      <Show when={expanded()}>
        <div class="msg-feedback-form">
          <textarea
            class="msg-feedback-input"
            placeholder="可选：一句话说明哪里好/哪里需改"
            rows={2}
            value={comment()}
            onInput={(e) => setComment(e.currentTarget.value)}
          />
          <div class="msg-feedback-chips">
            <For each={[...DIMENSIONS]}>
              {(d) => (
                <button
                  type="button"
                  class={`msg-feedback-chip${dims().includes(d) ? " on" : ""}`}
                  onClick={() => toggleDim(d)}
                >
                  {d}
                </button>
              )}
            </For>
          </div>
          <div class="msg-feedback-form-actions">
            <button
              type="button"
              class="msg-feedback-submit down"
              disabled={submitting()}
              onClick={() => void submit("down")}
            >
              {existing() ? "保存修改（需改进）" : "提交改进意见"}
            </button>
            <button
              type="button"
              class="msg-feedback-submit up"
              disabled={submitting()}
              onClick={() => void submit("up")}
            >
              {existing() ? "保存修改（有帮助）" : "提交好评"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
```

- [ ] **Step 6: Update the CSS**

In `src/components/workspace/MessageFeedback.css`, replace the `.msg-feedback-done` rule (lines ~92-95) with:

```css
.msg-feedback-btn.active {
  background: var(--ml-accent-soft, #e8f0fe);
  border-color: var(--ml-accent, #4a6fa5);
}

.msg-feedback-status {
  font-size: 0.75rem;
  color: var(--ml-muted, #888);
  margin-top: 0.3rem;
}
```

- [ ] **Step 7: Run the frontend suite + typecheck**

Run: `npx vitest run src/components/workspace/__tests__/messageFeedbackLogic.test.ts && npx tsc --noEmit`
Expected: tests PASS; `tsc` reports no new errors in the changed files.

- [ ] **Step 8: Commit**

```bash
git add src/components/workspace/messageFeedbackLogic.ts src/components/workspace/__tests__/messageFeedbackLogic.test.ts src/components/workspace/MessageFeedback.tsx src/components/workspace/MessageFeedback.css
git commit -m "feat(feedback): keep 👍/👎 editable after marking with prefilled form"
```

---

## Manual UAT (after all tasks)

1. `npm run tauri dev` (or the project's dev launch).
2. In a conversation, mark a reply 👍 → caption shows `✓ 已标记：有帮助`, 👍 highlighted, buttons still enabled.
3. Click 👎 → form opens; add a note + a dimension → 保存修改（需改进） → caption flips to `✓ 已标记：需改进 · <dim>`, 👎 highlighted.
4. Click 修改补充说明 → textarea/chips are pre-filled with the saved values; edit and save → caption updates.
5. With `feedback_upload_enabled` on, confirm the local DB keeps one `skill_feedback` row for that message (`id` stable), and the sync-service admin shows a single entry (not duplicates) after multiple edits.

---

## Self-Review

**Spec coverage:**
- Spec §3.1 (frontend always-visible + prefill + highlight) → Task 5. ✓
- Spec §3.2 (upsert by message_id, stable id) → Task 1; (outbox feedback_id + supersede + submit order + updated_at) → Tasks 2 & 3. ✓
- Spec §3.3 (dedupe by feedback_id, triage inheritance, downstream counts) → Task 4. ✓
- Spec §6 testing → unit tests in Tasks 1, 2, 4, 5; integration gate in Task 3; manual UAT section. ✓
- Spec §7 file list → matches File Structure. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `insert_skill_feedback` signature unchanged across tasks; `enqueue_feedback(pool, feedback_id, payload_json)` consistent in Tasks 2 & 3; `supersede_pending_feedback(pool, feedback_id)` consistent; `dedupeWithTriage(records, triageMap)` consistent in Tasks 4; `feedbackStatusText` / `ratingClickAction` signatures match between Task 5 helper, test, and component. ✓

**Note for executor:** `bun build ... --outfile /dev/null` in Task 4 Step 6 is a typecheck/build smoke test; if the environment lacks `/dev/null`, substitute a temp path and delete it. Verify whether `mergeTriage` remains imported in `server.ts` before removing it.
