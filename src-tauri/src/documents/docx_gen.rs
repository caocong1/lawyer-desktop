use anyhow::{Context, Result};
use std::path::Path;

pub fn generate_docx(title: &str, content_markdown: &str, output_path: &Path) -> Result<()> {
    use docx_rs::*;

    let mut doc = Docx::new();

    doc = doc.add_paragraph(
        Paragraph::new()
            .add_run(Run::new().add_text(title))
            .style("Heading1"),
    );

    doc = doc.add_paragraph(
        Paragraph::new().add_run(
            Run::new()
                .add_text("【声明：本文件为 AI 辅助生成的草稿，仅供律师审查参考，不构成法律建议。】")
                .size(18)
                .color("888888"),
        ),
    );

    doc = doc.add_paragraph(Paragraph::new());

    for line in content_markdown.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            doc = doc.add_paragraph(Paragraph::new());
            continue;
        }

        if let Some(heading) = trimmed.strip_prefix("### ") {
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(heading))
                    .style("Heading3"),
            );
        } else if let Some(heading) = trimmed.strip_prefix("## ") {
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(heading))
                    .style("Heading2"),
            );
        } else if let Some(heading) = trimmed.strip_prefix("# ") {
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(heading))
                    .style("Heading1"),
            );
        } else if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let text = &trimmed[2..];
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(&format!("• {}", text))),
            );
        } else {
            let clean = trimmed.replace("**", "").replace('*', "").replace('_', "");
            doc = doc.add_paragraph(Paragraph::new().add_run(Run::new().add_text(&clean)));
        }
    }

    let built = doc.build();
    let mut buf = std::io::Cursor::new(Vec::new());
    built.pack(&mut buf).context("Failed to pack docx")?;

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).context("Failed to create output directory")?;
    }
    std::fs::write(output_path, buf.into_inner()).context("Failed to write docx file")?;

    Ok(())
}
