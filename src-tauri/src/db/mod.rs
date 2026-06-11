pub mod models;
pub mod queries;

use tauri_plugin_sql::{Migration, MigrationKind};

pub fn get_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "initial schema",
        sql: include_str!("../../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }]
}
