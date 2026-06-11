use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Event channel for the developer-facing agent trace panel.
pub const AGENT_TRACE_EVENT: &str = "agent-trace";

/// One structured trace event per significant backend step of a turn,
/// ordered by `seq`. `payload` is kind-specific (see emit sites in chat.rs).
#[derive(Debug, Clone, Serialize)]
pub struct AgentTraceEvent {
    pub conversation_id: String,
    pub message_id: String,
    pub seq: u64,
    /// Wall-clock epoch millis when the event was emitted.
    pub ts_ms: u64,
    /// Millis since the turn started (monotonic).
    pub elapsed_ms: u64,
    pub kind: String,
    pub payload: Value,
}

/// Emits ordered `agent-trace` events for one `send_message` turn.
pub struct Tracer {
    app: AppHandle,
    conversation_id: String,
    message_id: String,
    seq: AtomicU64,
    started: Instant,
}

impl Tracer {
    pub fn new(app: &AppHandle, conversation_id: &str, message_id: &str) -> Self {
        Self {
            app: app.clone(),
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            seq: AtomicU64::new(0),
            started: Instant::now(),
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn emit(&self, kind: &str, payload: Value) {
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let event = AgentTraceEvent {
            conversation_id: self.conversation_id.clone(),
            message_id: self.message_id.clone(),
            seq: self.seq.fetch_add(1, Ordering::SeqCst),
            ts_ms,
            elapsed_ms: self.elapsed_ms(),
            kind: kind.to_string(),
            payload,
        };
        let _ = self.app.emit(AGENT_TRACE_EVENT, &event);
    }
}

/// Truncate on a char boundary, appending a marker with the dropped length.
pub fn preview(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!("{}\n…[截断，共 {} 字符]", head, total)
}
