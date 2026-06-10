use anyhow::{Context, Result};
use encoding_rs::GB18030;
use std::path::Path;

/// Parsed file content normalized to Markdown-ish plain text.
#[derive(Debug, Clone)]
pub struct ParsedDocument {
    pub markdown: String,
    pub source_ext: String,
}

fn read_text_with_encoding(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("read text file: {}", path.display()))?;

    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }

    let (decoded, _, had_errors) = GB18030.decode(&bytes);
    if had_errors {
        log::warn!(
            "GB18030 decode had errors for {}, using lossy UTF-8 fallback",
            path.display()
        );
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        Ok(decoded.into_owned())
    }
}

fn parse_text_like(path: &Path, ext: &str) -> Result<ParsedDocument> {
    let markdown = read_text_with_encoding(path)?;
    Ok(ParsedDocument {
        markdown,
        source_ext: ext.to_string(),
    })
}

fn parse_pdf(path: &Path) -> Result<ParsedDocument> {
    match pdf_extract::extract_text(path) {
        Ok(text) => Ok(ParsedDocument {
            markdown: text,
            source_ext: "pdf".into(),
        }),
        Err(e) => {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(ParsedDocument {
                markdown: format!(
                    "[PDF 文件: {} — {} bytes — 提取失败: {}]",
                    path.display(),
                    size,
                    e
                ),
                source_ext: "pdf".into(),
            })
        }
    }
}

fn docx_paragraph_text(p: &docx_rs::Paragraph, out: &mut String) {
    for child in &p.children {
        match child {
            docx_rs::ParagraphChild::Run(run) => docx_run_text(run, out),
            docx_rs::ParagraphChild::Hyperlink(link) => {
                for lc in &link.children {
                    if let docx_rs::ParagraphChild::Run(run) = lc {
                        docx_run_text(run, out);
                    }
                }
            }
            docx_rs::ParagraphChild::Insert(ins) => {
                for ic in &ins.children {
                    if let docx_rs::InsertChild::Run(run) = ic {
                        docx_run_text(run, out);
                    }
                }
            }
            _ => {}
        }
    }
    out.push('\n');
}

fn docx_run_text(run: &docx_rs::Run, out: &mut String) {
    for rc in &run.children {
        match rc {
            docx_rs::RunChild::Text(t) => out.push_str(&t.text),
            docx_rs::RunChild::Tab(_) => out.push('\t'),
            docx_rs::RunChild::Break(_) => out.push('\n'),
            _ => {}
        }
    }
}

fn docx_table_text(table: &docx_rs::Table, out: &mut String) {
    for row in &table.rows {
        let docx_rs::TableChild::TableRow(row) = row;
        let mut cells_text: Vec<String> = Vec::new();
        for cell in &row.cells {
            let docx_rs::TableRowChild::TableCell(cell) = cell;
            let mut cell_text = String::new();
            for content in &cell.children {
                match content {
                    docx_rs::TableCellContent::Paragraph(p) => docx_paragraph_text(p, &mut cell_text),
                    docx_rs::TableCellContent::Table(t) => docx_table_text(t, &mut cell_text),
                    _ => {}
                }
            }
            cells_text.push(cell_text.trim().replace('\n', " "));
        }
        out.push_str(&cells_text.join(" | "));
        out.push('\n');
    }
}

fn parse_docx(path: &Path) -> Result<ParsedDocument> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let fallback = |reason: String| ParsedDocument {
        markdown: format!(
            "[DOCX 文件: {} — {} bytes — 文本提取失败: {}]",
            path.display(),
            size,
            reason
        ),
        source_ext: "docx".into(),
    };

    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return Ok(fallback(e.to_string())),
    };

    let docx = match docx_rs::read_docx(&bytes) {
        Ok(d) => d,
        Err(e) => return Ok(fallback(e.to_string())),
    };

    let mut text = String::new();
    for child in &docx.document.children {
        match child {
            docx_rs::DocumentChild::Paragraph(p) => docx_paragraph_text(p, &mut text),
            docx_rs::DocumentChild::Table(t) => docx_table_text(t, &mut text),
            _ => {}
        }
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(fallback("文档无可提取文本".into()));
    }

    Ok(ParsedDocument {
        markdown: trimmed.to_string(),
        source_ext: "docx".into(),
    })
}

/// Parse a file into unified Markdown text based on extension.
pub fn parse_file(path: &Path, ext: &str) -> Result<ParsedDocument> {
    let ext = ext.to_lowercase();
    match ext.as_str() {
        "pdf" => parse_pdf(path),
        "docx" => parse_docx(path),
        _ => parse_text_like(path, &ext),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lawyer-ws-parse-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_markdown_file() {
        let dir = temp_dir();
        let path = dir.join("doc.md");
        fs::write(&path, "# Title\n\nBody text").unwrap();
        let doc = parse_file(&path, "md").unwrap();
        assert!(doc.markdown.contains("# Title"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_json_as_text() {
        let dir = temp_dir();
        let path = dir.join("data.json");
        fs::write(&path, r#"{"key": "索赔"}"#).unwrap();
        let doc = parse_file(&path, "json").unwrap();
        assert!(doc.markdown.contains("索赔"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn docx_extracts_text_roundtrip() {
        let dir = temp_dir();
        let path = dir.join("file.docx");

        let file = fs::File::create(&path).unwrap();
        docx_rs::Docx::new()
            .add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(docx_rs::Run::new().add_text("关于投标保函的诉讼请示")),
            )
            .add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(docx_rs::Run::new().add_text("索赔金额为人民币500,000元。")),
            )
            .add_table(docx_rs::Table::new(vec![docx_rs::TableRow::new(vec![
                docx_rs::TableCell::new().add_paragraph(
                    docx_rs::Paragraph::new().add_run(docx_rs::Run::new().add_text("被告")),
                ),
                docx_rs::TableCell::new().add_paragraph(
                    docx_rs::Paragraph::new()
                        .add_run(docx_rs::Run::new().add_text("重庆市双业融资担保有限公司")),
                ),
            ])]))
            .build()
            .pack(file)
            .unwrap();

        let doc = parse_file(&path, "docx").unwrap();
        assert!(doc.markdown.contains("关于投标保函的诉讼请示"), "got: {}", doc.markdown);
        assert!(doc.markdown.contains("索赔金额为人民币500,000元。"));
        assert!(doc.markdown.contains("被告 | 重庆市双业融资担保有限公司"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn docx_invalid_bytes_fall_back_to_marker() {
        let dir = temp_dir();
        let path = dir.join("file.docx");
        fs::write(&path, "fake docx bytes").unwrap();
        let doc = parse_file(&path, "docx").unwrap();
        assert!(doc.markdown.contains("文本提取失败"));
        let _ = fs::remove_dir_all(&dir);
    }
}
