use crate::llm::types::{FunctionCall, ToolCall};
use serde_json::{json, Value};
use uuid::Uuid;

const KNOWN_TOOLS: &[&str] = &[
    "search_workspace",
    "read_chunk",
    "read_file",
    "list_files",
    "get_index_status",
    "read_user_file",
    "generate_docx",
    "select_skill",
    "ask_user",
];

/// Map fullwidth / token-separator characters (DeepSeek DSML uses U+FF5C `｜`
/// and U+2581 `▁`) onto their ASCII equivalents so detection and parsing see
/// one canonical form.
fn normalize_marker_chars(text: &str) -> String {
    text.replace('｜', "|").replace('▁', "_")
}

/// True when model leaked tool-call markup into plain text instead of using API tool_calls.
pub fn contains_tool_leakage(text: &str) -> bool {
    let lower = normalize_marker_chars(text).to_lowercase();
    lower.contains("dsml")
        || lower.contains("tool_calls")
        || lower.contains("tool_call")
        || lower.contains("<invoke")
        || lower.contains("</invoke")
        || lower.contains("invoke name=")
        || lower.contains("parameter name=")
        || lower.contains("function_call")
        || lower.contains("<|")
        || lower.contains("|>")
        || lower.contains("toolalls")
}

/// Strip tool markup from assistant text for display / persistence.
pub fn sanitize_assistant_content(text: &str) -> String {
    let mut s = text.to_string();

    while let Some(start) = find_case_insensitive(&s, "<tool_calls") {
        if let Some(end) = find_case_insensitive(&s[start..], "</tool_calls>") {
            s.replace_range(start..start + end + "</tool_calls>".len(), "");
            continue;
        }
        break;
    }

    while let Some(start) = find_case_insensitive(&s, "<invoke") {
        if let Some(end) = find_case_insensitive(&s[start..], "</invoke>") {
            s.replace_range(start..start + end + "</invoke>".len(), "");
            continue;
        }
        if let Some(next) = find_case_insensitive(&s[start + 7..], "<invoke") {
            s.replace_range(start..start + 7 + next, "");
            continue;
        }
        s.replace_range(start.., "");
        break;
    }

    let mut out = String::new();
    for line in s.lines() {
        let trimmed = line.trim();
        // Detect markers on a normalized copy (fullwidth ｜ etc.) but keep
        // the original line text when it is clean.
        let lower = normalize_marker_chars(trimmed).to_lowercase();
        if lower.contains("dsml")
            || lower.contains("tool_calls")
            || lower.contains("tool_call")
            || lower.contains("invoke name=")
            || lower.contains("invoke=")
            || lower.contains("parameter name=")
            || lower.contains("</invoke")
            || lower.contains("function_call")
            || lower.contains("toolalls")
            || lower.contains("<|")
            || lower.contains("|>")
        {
            continue;
        }
        // Only strip `<...>` lines matching known tool-leak tags, not all HTML.
        if trimmed.starts_with('<') && trimmed.ends_with('>') {
            let inner = trimmed[1..trimmed.len() - 1].trim().to_lowercase();
            let inner_stripped = inner.strip_prefix('/').unwrap_or(&inner);
            if inner_stripped.starts_with("tool_call")
                || inner_stripped.starts_with("invoke")
                || inner_stripped.starts_with("parameter")
                || inner_stripped.starts_with("function_call")
                || inner_stripped.starts_with("dsml")
            {
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }

    collapse_blank_lines(out.trim()).to_string()
}

fn collapse_blank_lines(s: &str) -> &str {
    s.trim()
}

fn find_case_insensitive(hay: &str, needle: &str) -> Option<usize> {
    hay.to_lowercase().find(&needle.to_lowercase())
}

fn normalize_tool_name(raw: &str) -> String {
    let n = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_lowercase();
    if KNOWN_TOOLS.iter().any(|t| *t == n) {
        return n;
    }
    if n.contains("search") && (n.contains("work") || n.contains("space") || n.contains("pace")) {
        return "search_workspace".into();
    }
    if n.contains("read") && n.contains("chunk") {
        return "read_chunk".into();
    }
    if n.contains("read") && n.contains("file") {
        return "read_file".into();
    }
    if n.contains("list") && n.contains("file") {
        return "list_files".into();
    }
    if n.contains("index") && n.contains("status") {
        return "get_index_status".into();
    }
    for known in KNOWN_TOOLS {
        if n.contains(known) || known.contains(&n) {
            return (*known).into();
        }
    }
    raw.trim().to_string()
}

fn parse_parameter_value(block: &str, param_name: &str) -> Option<String> {
    let patterns = [
        format!(r#"name="{param_name}""#),
        format!(r#"name='{param_name}'"#),
    ];
    for pat in &patterns {
        if let Some(idx) = find_case_insensitive(block, pat) {
            let rest = &block[idx + pat.len()..];
            let rest = rest.trim_start();
            if let Some(gt) = rest.find('>') {
                let after = &rest[gt + 1..];
                if let Some(lt) = after.find('<') {
                    return Some(after[..lt].trim().to_string());
                }
                let end = after
                    .find(|c: char| c == '\n' || c == '|')
                    .unwrap_or(after.len());
                return Some(after[..end].trim().to_string());
            }
        }
    }
    None
}

/// Extract the tool name from an invoke block. Handles `invoke name="x"`,
/// and the mangled `invoke="x"` variant seen in DSML leakage. When both
/// forms appear, the earlier match wins (the tool name precedes parameters).
fn extract_invoke_name(block: &str) -> Option<String> {
    let name_idx = find_case_insensitive(block, "name=");
    // `invoke=` value starts 7 chars in; encode as name_idx-compatible offset (+2).
    let invoke_idx = find_case_insensitive(block, "invoke=").map(|i| i + 2);
    let idx = match (name_idx, invoke_idx) {
        (Some(n), Some(i)) => n.min(i),
        (Some(n), None) => n,
        (None, Some(i)) => i,
        (None, None) => return None,
    };
    let rest = block[idx + 5..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let name_end = rest[1..].find(quote)?;
    Some(rest[1..1 + name_end].to_string())
}

fn parse_invoke_block(block: &str) -> Option<(String, Value)> {
    let raw_name = extract_invoke_name(block)?;
    let tool_name = normalize_tool_name(&raw_name);

    let mut args = serde_json::Map::new();
    for key in [
        "query",
        "k",
        "chunk_id",
        "relative_path",
        "max_chars",
        "pattern",
        "path",
        "skill_name",
        "reason",
    ] {
        if let Some(v) = parse_parameter_value(block, key) {
            if key == "k" || key == "max_chars" {
                if let Ok(n) = v.parse::<i64>() {
                    args.insert(key.to_string(), json!(n));
                }
            } else {
                args.insert(key.to_string(), Value::String(v));
            }
        }
    }

    Some((tool_name, Value::Object(args)))
}

/// Parse `<invoke name="...">` / DSML-style tool blocks embedded in model content.
pub fn parse_embedded_tool_calls(content: &str) -> Vec<ToolCall> {
    let content = &normalize_marker_chars(content);
    let mut calls = Vec::new();
    let lower = content.to_lowercase();
    let mut search_from = 0;

    while search_from < content.len() {
        let rel = match lower[search_from..].find("invoke") {
            Some(i) => i,
            None => break,
        };
        let start = search_from + rel;
        let block_end = lower[start..]
            .find("</invoke>")
            .map(|e| start + e + "</invoke>".len())
            .unwrap_or_else(|| {
                lower[start..]
                    .find("<invoke")
                    .map(|n| start + n)
                    .unwrap_or(content.len())
            });

        let block = &content[start..block_end.min(content.len())];
        if let Some((name, args)) = parse_invoke_block(block) {
            if KNOWN_TOOLS.contains(&name.as_str()) || name.starts_with("mcp_") {
                calls.push(ToolCall {
                    id: format!("embedded_{}", Uuid::new_v4()),
                    tool_type: "function".into(),
                    function: FunctionCall {
                        name,
                        arguments: args.to_string(),
                    },
                });
            }
        }

        search_from = block_end.max(start + 6);
    }

    calls
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim leaked content captured from a real failed conversation
    /// (deepseek-v4-pro via gateway, 2026-06-10). Uses fullwidth ｜ U+FF5C.
    const REAL_DSML_LEAK: &str = "<｜｜DSML｜｜tool_c>\n<｜｜DSML｜｜invoke=\"search_\">\n<｜｜DSML｜｜parameter namek\" stringfalse\">13｜｜DSML｜｜parameter>\n<｜｜DSML｜｜ name=\"query\" stringtrue\">保 投标见即付不可</｜｜DSML｜｜parameter>\n</invoke>\n</｜｜DSML｜｜_calls>";

    #[test]
    fn detects_dsml_leakage() {
        assert!(contains_tool_leakage("| | DSML | | tool_calls>"));
        assert!(contains_tool_leakage(r#"<invoke name="search_workspace">"#));
    }

    #[test]
    fn detects_fullwidth_dsml_leakage() {
        assert!(contains_tool_leakage(REAL_DSML_LEAK));
        assert!(contains_tool_leakage("<｜tool▁calls▁begin｜>"));
    }

    #[test]
    fn sanitize_strips_real_fullwidth_leak_completely() {
        assert_eq!(sanitize_assistant_content(REAL_DSML_LEAK), "");
    }

    #[test]
    fn sanitize_keeps_clean_markdown_tables() {
        let text = "# 诉讼方案\n\n| 序号 | 文件 | 状态 |\n|------|------|------|\n| 1 | 投标保函 | 已读取 |\n\n正文段落。";
        assert_eq!(sanitize_assistant_content(text), text);
    }

    #[test]
    fn sanitize_strips_inline_leak_lines_but_keeps_prose() {
        let text = "以下是分析：\n<｜｜DSML｜｜tool_c>\n结论：可以起诉。";
        let clean = sanitize_assistant_content(text);
        assert!(clean.contains("以下是分析："));
        assert!(clean.contains("结论：可以起诉。"));
        assert!(!clean.contains("DSML"));
    }

    #[test]
    fn parses_mangled_fullwidth_invoke_to_known_tool() {
        // Truncated name `search_` + fullwidth bars must still map to search_workspace.
        let calls = parse_embedded_tool_calls(REAL_DSML_LEAK);
        assert_eq!(calls.len(), 1, "calls: {:?}", calls);
        assert_eq!(calls[0].function.name, "search_workspace");
        assert!(calls[0].function.arguments.contains("保 投标见即付不可"));
    }

    #[test]
    fn parses_invoke_block() {
        let text = r#"<invoke name="search_workspace">
<parameter name="query">逾期利息</parameter>
<parameter name="k">15</parameter>
</invoke>"#;
        let calls = parse_embedded_tool_calls(text);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "search_workspace");
        assert!(calls[0].function.arguments.contains("逾期利息"));
    }

    #[test]
    fn sanitize_keeps_html_formatting_tags() {
        let text = "正文内容\n<br>\n<table>\n<tr>\n<td>单元格</td>\n</tr>\n</table>\n<strong>重点</strong>";
        let clean = sanitize_assistant_content(text);
        assert!(clean.contains("<br>"), "should keep <br>, got: {}", clean);
        assert!(clean.contains("<table>"), "should keep <table>");
        assert!(clean.contains("<strong>"), "should keep <strong>");
        assert!(clean.contains("正文内容"));
        assert!(clean.contains("单元格"));
    }

    #[test]
    fn sanitize_keeps_short_html_like_tags_under_120() {
        let text = "段落一\n<p>\n段落二";
        let clean = sanitize_assistant_content(text);
        assert!(clean.contains("<p>"), "should keep <p>, got: {}", clean);
        assert!(clean.contains("段落一"));
        assert!(clean.contains("段落二"));
    }
}
