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
