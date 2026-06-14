use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RubricDimension {
    pub id: String,
    pub label: String,
    pub verdict: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeResult {
    pub dimensions: Vec<RubricDimension>,
    pub score: f64,
    pub summary: String,
}

pub const GENERIC_LEGAL_RUBRIC: &str = r#"## 通用法律输出评估标准

| 维度 | 通过标准 |
|------|---------|
| R1 法律依据 | 引用了与结论匹配的法条/司法解释 |
| R2 主体资格 | 涉及特殊主体时已核验资格 |
| R3 逻辑完整 | 论证链完整，无跳跃 |
| R4 反向检索 | 检索或声明了不利案例/反例 |
| R5 结构规范 | 文书结构符合模板 |
| R6 风险提示 | 包含主要程序/实体风险 |
| R7 引用准确 | 法条号、案号精确 |
| R8 结论明确 | 首选方案唯一明确 |
| R9 待验证标注 | 不确定处标注待律师复核 |
| R10 格式落款 | 格式与落款完整 |

评分：pass=1.0, warn=0.5, fail=0.0。总体 score = 各维平均。
"#;

pub async fn judge_output(
    provider: &dyn crate::llm::provider::LlmProvider,
    answer: &str,
    rubric: &str,
    gold_reference: Option<&str>,
) -> anyhow::Result<JudgeResult> {
    use crate::llm::types::{ChatMessage, ChatRequest};

    let gold_section = gold_reference
        .filter(|g| !g.trim().is_empty())
        .map(|g| {
            let truncated: String = g.chars().take(12000).collect();
            let suffix = if g.chars().count() > 12000 {
                "\n\n[律师最终版已截断]"
            } else {
                ""
            };
            format!(
                "\n\n## 律师最终版参考（gold reference）\n{truncated}{suffix}\n\n\
                 请对照律师最终版要点，评估 AI 输出在结构、论证路径、结论与关键法条引用上的一致性。"
            )
        })
        .unwrap_or_default();

    let prompt = format!(
        "你是中国法律输出评审员。对照以下 rubric 与律师最终版（如有）评估 AI 生成的法律输出。\n\n\
         ## Rubric\n{rubric}{gold_section}\n\n\
         ## AI 输出\n{answer}\n\n\
         请输出 JSON（不要 markdown 代码块）：\n\
         {{\"dimensions\":[{{\"id\":\"R1\",\"label\":\"...\",\"verdict\":\"pass|warn|fail\",\"note\":\"...\"}}],\
         \"score\":0.0到1.0,\"summary\":\"一句话总结\"}}\n\
         verdict 只能是 pass、warn、fail。"
    );

    let request = ChatRequest {
        model: provider.model_name().to_string(),
        messages: vec![ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: prompt,
            name: None,
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: None,
        temperature: Some(0.1),
        max_tokens: Some(4096),
        stream: false,
    };

    let response = provider.chat(&request).await?;
    let text = response
        .choices
        .first()
        .and_then(|c| c.message.as_ref())
        .map(|m| m.content.clone())
        .unwrap_or_default();

    parse_judge_json(&text)
}

fn parse_judge_json(text: &str) -> anyhow::Result<JudgeResult> {
    let trimmed = text.trim();
    let json_str = if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            &trimmed[start..=end]
        } else {
            trimmed
        }
    } else {
        trimmed
    };

    #[derive(Deserialize)]
    struct Raw {
        dimensions: Vec<RubricDimension>,
        score: f64,
        summary: String,
    }

    let raw: Raw = serde_json::from_str(json_str).unwrap_or(Raw {
        dimensions: vec![],
        score: 0.5,
        summary: "评委输出解析失败，使用默认分数".into(),
    });

    let score = if raw.score.is_finite() && raw.score >= 0.0 && raw.score <= 1.0 {
        raw.score
    } else if !raw.dimensions.is_empty() {
        let sum: f64 = raw
            .dimensions
            .iter()
            .map(|d| match d.verdict.as_str() {
                "pass" => 1.0,
                "warn" => 0.5,
                _ => 0.0,
            })
            .sum();
        sum / raw.dimensions.len() as f64
    } else {
        0.5
    };

    Ok(JudgeResult {
        dimensions: raw.dimensions,
        score,
        summary: raw.summary,
    })
}

pub fn load_rubric_for_case(case_rubric: Option<&str>, skills_root: Option<&std::path::Path>) -> String {
    if let Some(r) = case_rubric {
        if r.ends_with(".md") {
            if let Some(root) = skills_root {
                let path = root.join(r);
                if let Ok(content) = std::fs::read_to_string(&path) {
                    return content;
                }
            }
            if let Ok(content) = std::fs::read_to_string(r) {
                return content;
            }
        } else if !r.is_empty() {
            return r.to_string();
        }
    }
    GENERIC_LEGAL_RUBRIC.to_string()
}

/// Load gold reference text from an absolute path or path relative to skills root.
pub fn load_gold_reference(
    gold_path: Option<&str>,
    skills_root: Option<&std::path::Path>,
) -> Option<String> {
    let path_str = gold_path?.trim();
    if path_str.is_empty() {
        return None;
    }

    let candidates: Vec<std::path::PathBuf> = {
        let mut v = vec![std::path::PathBuf::from(path_str)];
        if let Some(root) = skills_root {
            v.push(root.join(path_str));
        }
        v
    };

    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let ext = candidate
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let text = match ext.as_str() {
            "docx" => crate::workspace::parser::extract_docx_text(&candidate).ok(),
            "md" | "txt" => std::fs::read_to_string(&candidate).ok(),
            _ => std::fs::read_to_string(&candidate).ok(),
        };
        if let Some(t) = text.filter(|s| !s.trim().is_empty()) {
            return Some(t);
        }
    }
    None
}
