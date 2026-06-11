use serde::{Deserialize, Serialize};

/// Target chunk size and overlap (characters).
pub const CHUNK_SIZE: usize = 3500;
pub const CHUNK_OVERLAP: usize = 500;

/// A chunk ready for persistence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChunkDraft {
    pub relative_path: String,
    pub heading_path: Vec<String>,
    pub ordinal: i32,
    pub content: String,
}

/// Split by Markdown `#` headings, then subdivide long sections with overlap.
pub fn chunk_markdown(relative_path: &str, markdown: &str) -> Vec<ChunkDraft> {
    let sections = split_by_headings(markdown);
    let mut drafts = Vec::new();
    let mut ordinal: i32 = 0;

    for section in sections {
        for part in split_with_overlap(&section.content, CHUNK_SIZE, CHUNK_OVERLAP) {
            if part.trim().is_empty() {
                continue;
            }
            drafts.push(ChunkDraft {
                relative_path: relative_path.to_string(),
                heading_path: section.heading_path.clone(),
                ordinal,
                content: part,
            });
            ordinal += 1;
        }
    }

    if drafts.is_empty() {
        drafts.push(ChunkDraft {
            relative_path: relative_path.to_string(),
            heading_path: Vec::new(),
            ordinal: 0,
            content: String::new(),
        });
    }

    drafts
}

struct Section {
    heading_path: Vec<String>,
    content: String,
}

fn split_by_headings(markdown: &str) -> Vec<Section> {
    let lines: Vec<&str> = markdown.lines().collect();
    if lines.is_empty() {
        return vec![Section {
            heading_path: Vec::new(),
            content: String::new(),
        }];
    }

    let mut sections: Vec<Section> = Vec::new();
    let mut heading_stack: Vec<(usize, String)> = Vec::new();
    let mut current_lines: Vec<String> = Vec::new();
    let mut saw_heading = false;

    let flush = |sections: &mut Vec<Section>,
                 heading_stack: &[(usize, String)],
                 lines: &mut Vec<String>| {
        let content = lines.join("\n").trim().to_string();
        if content.is_empty() && !sections.is_empty() {
            lines.clear();
            return;
        }
        sections.push(Section {
            heading_path: heading_stack.iter().map(|(_, t)| t.clone()).collect(),
            content,
        });
        lines.clear();
    };

    for line in lines {
        if let Some(level) = heading_level(line) {
            saw_heading = true;
            flush(&mut sections, &heading_stack, &mut current_lines);
            while heading_stack.last().is_some_and(|(l, _)| *l >= level) {
                heading_stack.pop();
            }
            let title = line[level..].trim().to_string();
            heading_stack.push((level, title));
            current_lines.push(line.to_string());
        } else {
            current_lines.push(line.to_string());
        }
    }

    flush(&mut sections, &heading_stack, &mut current_lines);

    if !saw_heading {
        let trimmed = markdown.trim().to_string();
        return vec![Section {
            heading_path: Vec::new(),
            content: trimmed,
        }];
    }

    sections
}

fn split_with_overlap(text: &str, max_len: usize, overlap: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_len {
        return vec![trimmed.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + max_len).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        chunks.push(chunk);
        if end >= chars.len() {
            break;
        }
        let next = end.saturating_sub(overlap);
        start = if next <= start { end } else { next };
    }
    chunks
}

fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = trimmed[hashes..].trim_start();
    if rest.is_empty() || rest.starts_with('#') {
        return None;
    }
    Some(hashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_by_headings_with_nested_path() {
        let md = "# 第一章\n内容 A\n\n## 第一节\n内容 B\n\n# 第二章\n内容 C";
        let chunks = chunk_markdown("case/plan.md", md);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].heading_path, vec!["第一章"]);
        assert_eq!(chunks[1].heading_path, vec!["第一章", "第一节"]);
        assert_eq!(chunks[2].heading_path, vec!["第二章"]);
    }

    #[test]
    fn plain_text_single_chunk() {
        let text = "无标题纯文本\n第二行";
        let chunks = chunk_markdown("notes.txt", text);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].heading_path.is_empty());
        assert!(chunks[0].content.contains("无标题纯文本"));
    }

    #[test]
    fn long_section_splits_with_overlap() {
        let body = "字".repeat(4000);
        let md = format!("# 长章节\n{}", body);
        let chunks = chunk_markdown("long.md", &md);
        assert!(chunks.len() >= 2);
        assert!(chunks[0].content.chars().count() <= CHUNK_SIZE);
    }

    #[test]
    fn split_with_overlap_advances() {
        let text = "a".repeat(5000);
        let parts = split_with_overlap(&text, 3500, 500);
        assert!(parts.len() >= 2);
    }
}
