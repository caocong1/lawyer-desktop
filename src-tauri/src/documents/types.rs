use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegalDocumentModel {
    pub title: String,
    pub document_type: Option<String>,
    pub parties: Option<Vec<Party>>,
    pub sections: Vec<DocumentSection>,
    pub citations: Option<Vec<Citation>>,
    pub disclaimers: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Party {
    pub name: String,
    pub role: Option<String>,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSection {
    pub id: Option<String>,
    pub heading: Option<String>,
    pub content: String,
    pub clauses: Option<Vec<Clause>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clause {
    pub id: String,
    pub title: Option<String>,
    pub text: String,
    pub risk_level: Option<String>,
    pub citations: Option<Vec<Citation>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Citation {
    pub source: String,
    pub reference: String,
    pub excerpt: Option<String>,
    pub url: Option<String>,
}

/// Parse LLM JSON output into a structured legal document model.
pub fn parse_legal_document_json(raw: &str) -> Result<LegalDocumentModel> {
    let trimmed = raw.trim();

    let json_str = if trimmed.starts_with("```") {
        let without_fence = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        without_fence
    } else {
        trimmed
    };

    serde_json::from_str(json_str).with_context(|| "failed to parse legal document JSON")
}

impl LegalDocumentModel {
    pub fn to_markdown(&self) -> String {
        let mut md = String::new();
        md.push_str(&format!("# {}\n\n", self.title));

        if let Some(ref disclaimers) = self.disclaimers {
            for d in disclaimers {
                md.push_str(&format!("> {}\n\n", d));
            }
        }

        if let Some(ref parties) = self.parties {
            md.push_str("## 当事人\n\n");
            for p in parties {
                let role = p.role.as_deref().unwrap_or("当事人");
                md.push_str(&format!("- **{}** ({})", p.name, role));
                if let Some(ref details) = p.details {
                    md.push_str(&format!(": {}", details));
                }
                md.push('\n');
            }
            md.push('\n');
        }

        for section in &self.sections {
            if let Some(ref heading) = section.heading {
                md.push_str(&format!("## {}\n\n", heading));
            }
            if !section.content.is_empty() {
                md.push_str(&section.content);
                md.push_str("\n\n");
            }
            if let Some(ref clauses) = section.clauses {
                for clause in clauses {
                    let title = clause.title.as_deref().unwrap_or(&clause.id);
                    md.push_str(&format!("### {} {}\n\n", clause.id, title));
                    md.push_str(&clause.text);
                    md.push_str("\n\n");
                }
            }
        }

        if let Some(ref citations) = self.citations {
            md.push_str("## 引用来源\n\n");
            for c in citations {
                md.push_str(&format!("- {} — {}\n", c.source, c.reference));
            }
        }

        md
    }
}
