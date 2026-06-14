//! Chinese-numeral parsing for statute article references (第一千零八十四条).

/// A parsed article reference: number plus optional 之X suffix (第X条之一).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArticleRef {
    pub number: u32,
    pub suffix: Option<String>,
}

fn digit_value(c: char) -> Option<u32> {
    match c {
        '零' | '〇' => Some(0),
        '一' => Some(1),
        '二' | '两' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '七' => Some(7),
        '八' => Some(8),
        '九' => Some(9),
        _ => c.to_digit(10),
    }
}

fn unit_value(c: char) -> Option<u32> {
    match c {
        '十' => Some(10),
        '百' => Some(100),
        '千' => Some(1000),
        '万' => Some(10000),
        _ => None,
    }
}

/// Parse Chinese or Arabic numerals (mixed digits tolerated), up to 万 scale.
pub fn parse_cn_number(s: &str) -> Option<u32> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse().ok();
    }

    let mut total: u32 = 0; // completed 万-sections
    let mut section: u32 = 0; // current section below 万
    let mut num: u32 = 0; // pending digit(s)
    let mut saw_any = false;

    for c in s.chars() {
        if let Some(u) = unit_value(c) {
            saw_any = true;
            if u == 10000 {
                let sec = section.checked_add(num)?;
                let sec = if sec == 0 { 1 } else { sec };
                total = total.checked_add(sec.checked_mul(10000)?)?;
                section = 0;
                num = 0;
            } else {
                // Bare 十 means 10 (十条 / 十一条).
                let n = if num == 0 && u == 10 { 1 } else { num };
                section = section.checked_add(n.checked_mul(u)?)?;
                num = 0;
            }
        } else if let Some(d) = digit_value(c) {
            saw_any = true;
            if c.is_ascii_digit() {
                num = num.checked_mul(10)?.checked_add(d)?;
            } else {
                num = d;
            }
        } else {
            return None;
        }
    }
    if !saw_any {
        return None;
    }
    total.checked_add(section)?.checked_add(num)
}

/// Parse "第五百八十五条", "第585条", "585", "五百八十五", "第五百八十五条之一".
pub fn parse_article_ref(s: &str) -> Option<ArticleRef> {
    let mut t = s.trim();
    t = t.strip_prefix('第').unwrap_or(t);

    let (number_part, suffix) = match t.find('条') {
        Some(idx) => {
            let after = t[idx + '条'.len_utf8()..].trim();
            let suffix = if after.is_empty() {
                None
            } else if after.starts_with('之') {
                Some(after.to_string())
            } else {
                return None;
            };
            (&t[..idx], suffix)
        }
        None => (t, None),
    };

    Some(ArticleRef {
        number: parse_cn_number(number_part)?,
        suffix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_numbers() {
        assert_eq!(parse_cn_number("一"), Some(1));
        assert_eq!(parse_cn_number("十"), Some(10));
        assert_eq!(parse_cn_number("十一"), Some(11));
        assert_eq!(parse_cn_number("二十"), Some(20));
        assert_eq!(parse_cn_number("五百八十五"), Some(585));
        assert_eq!(parse_cn_number("一千零八十四"), Some(1084));
        assert_eq!(parse_cn_number("一千二百六十"), Some(1260));
        assert_eq!(parse_cn_number("585"), Some(585));
        assert_eq!(parse_cn_number(""), None);
        assert_eq!(parse_cn_number("第"), None);
    }

    #[test]
    fn parses_article_refs() {
        let r = parse_article_ref("第五百八十五条").unwrap();
        assert_eq!(r.number, 585);
        assert_eq!(r.suffix, None);

        let r = parse_article_ref("第585条").unwrap();
        assert_eq!(r.number, 585);

        let r = parse_article_ref("585").unwrap();
        assert_eq!(r.number, 585);

        let r = parse_article_ref("第二百八十七条之一").unwrap();
        assert_eq!(r.number, 287);
        assert_eq!(r.suffix.as_deref(), Some("之一"));

        assert!(parse_article_ref("第五条款").is_none());
    }
}
