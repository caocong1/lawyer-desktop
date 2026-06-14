use sqlx::{Pool, Sqlite};

const GUOHANG_PROMPT: &str =
    "使用律师文书技能，读取本目录下全部材料，生成诉讼方案，并生成 DOCX。";

const GUOHANG_MATERIALS: &str =
    r"C:\Users\sorawatcher\workspace\cn-lawyer-docs-skill\learning-materials\guohang-chongqing-shuangye\case-materials\案件资料";

const GUOHANG_RUBRIC: &str =
    "learning-materials/guohang-chongqing-shuangye/evaluation/gold-rubric.md";

const GUOHANG_GOLD_DOCX: &str = r"C:\Users\sorawatcher\workspace\cn-lawyer-docs-skill\learning-materials\guohang-chongqing-shuangye\lawyer-final-docs\关于中国国际航空股份有限公司重庆分公司与重庆市双业融资担保有限公司合同纠纷诉讼方案之法律备忘录-国浩20260526-V1.docx";

/// Insert seed eval case if not already present.
pub async fn ensure_guohang_seed(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT COUNT(*) FROM eval_cases WHERE name = 'guohang-chongqing-shuangye'",
    )
    .fetch_optional(pool)
    .await?;

    let materials = if std::path::Path::new(GUOHANG_MATERIALS).is_dir() {
        GUOHANG_MATERIALS
    } else {
        log::warn!("Guohang case materials not found at {}", GUOHANG_MATERIALS);
        GUOHANG_MATERIALS
    };

    let gold_ref = if std::path::Path::new(GUOHANG_GOLD_DOCX).is_file() {
        Some(GUOHANG_GOLD_DOCX)
    } else {
        log::warn!("Guohang gold reference DOCX not found at {}", GUOHANG_GOLD_DOCX);
        None
    };

    if existing.map(|(c,)| c).unwrap_or(0) > 0 {
        if let Some(g) = gold_ref {
            sqlx::query(
                "UPDATE eval_cases SET gold_reference_path = ? WHERE name = 'guohang-chongqing-shuangye' AND (gold_reference_path IS NULL OR gold_reference_path = '')",
            )
            .bind(g)
            .execute(pool)
            .await?;
        }
        return Ok(());
    }

    crate::db::queries::insert_eval_case(
        pool,
        "guohang-chongqing-shuangye",
        Some("matter-intake"),
        Some("litigation-legal"),
        GUOHANG_PROMPT,
        Some(materials),
        Some(GUOHANG_RUBRIC),
        gold_ref,
        "val",
        "real",
    )
    .await?;

    log::info!("Inserted guohang seed eval case");
    Ok(())
}
