# -*- coding: utf-8 -*-
"""Convert lawtext/laws markdown (markitdown-from-docx) into the strict
per-article format consumed by the lawyer-desktop Rust indexer.

Output: one <slug>.md per statute under src-tauri/resources/law-library/
"""
import re
import sys
from pathlib import Path

SRC = Path(r"C:\Users\sorawatcher\workspace\lawyer-desktop\.tmp-corpus\laws\content")
OUT = Path(r"C:\Users\sorawatcher\workspace\lawyer-desktop\src-tauri\resources\law-library")

CN = "零一二三四五六七八九十百千"
ART_RE = re.compile(r"^-\s*\*\*(第[%s]+条(?:之[%s]+)?)\*\*[\s　]*(.*)$" % (CN, CN))
DIV_RE = re.compile(r"^(第[%s]+(?:分编|编|章|节))[\s　]*(.*)$" % CN)
SECNUM_RE = re.compile(r"^([一二三四五六七八九十]+)、[\s　]*(.*)$")
FOOTREF_RE = re.compile(r"\[\^[^\]]*\]")

DIV_LEVEL = {"编": 1, "分编": 2, "章": 3, "节": 4}


def squash(text):
    """Collapse all whitespace (incl. fullwidth) out of a string."""
    return re.sub(r"[\s　]+", "", text)


def norm_div(num, title):
    """'第一编', '总  则' -> '第一编 总则' (intra-word padding removed)."""
    t = squash(title)
    return f"{num} {t}" if t else num


def clean_body(text):
    text = FOOTREF_RE.sub("", text)
    text = text.replace("**", "")
    return text.strip()


class Article:
    def __init__(self, num, path):
        self.num = num          # e.g. 第一千零八十四条 / 第一百三十三条之一
        self.path = path        # tuple of division strings
        self.paras = []


def parse(src_file, preamble_markers=()):
    lines = src_file.read_text(encoding="utf-8").split("\n")
    # strip YAML frontmatter
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1:]
                break

    slots = {}                  # level -> division string
    articles = []
    preamble = []
    tail_blocks = []            # (division, [paras]) for article-less divisions (刑法附件)
    cur = None
    in_toc = False

    def cur_path():
        return tuple(slots[k] for k in sorted(slots) if slots.get(k))

    def set_div(level, text):
        nonlocal cur
        slots[level] = text
        for k in list(slots):
            if k > level:
                del slots[k]
        cur = None  # next article starts fresh under the new division

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()

        # horizontal rules / footnote definitions
        if stripped == "---":
            continue
        if stripped.endswith("↑"):  # markitdown footnote backref arrow
            continue

        # headings
        m = re.match(r"^(#+)\s*(.*)$", stripped)
        if m:
            text = m.group(2).strip()
            sq = squash(text)
            if sq.startswith("目录"):
                in_toc = True
                continue
            in_toc = False
            d = DIV_RE.match(text)
            if d:
                kind = re.sub(r"^第[%s]+" % CN, "", d.group(1))
                set_div(DIV_LEVEL[kind], norm_div(d.group(1), d.group(2)))
                continue
            if sq in ("附则",):
                set_div(1, "附则")
                continue
            am = re.match(r"^附件([一二三四五六七八九十]+)$", sq)
            if am:
                set_div(1, "附件" + am.group(1))
                tail_blocks.append(("附件" + am.group(1), []))
                continue
            s = SECNUM_RE.match(text)
            if s:
                set_div(1, f"{s.group(1)}、{squash(s.group(2)) or ''}".rstrip("、") if s.group(2) else f"{s.group(1)}、")
                # normalize like 五、附则
                set_div(1, f"{s.group(1)}、{squash(s.group(2))}" if squash(s.group(2)) else f"{s.group(1)}、")
                continue
            # unknown heading -> ignore (e.g. residual)
            continue

        if in_toc:
            continue

        # article start
        a = ART_RE.match(stripped)
        if a:
            in_toc = False
            cur = Article(a.group(1), cur_path())
            articles.append(cur)
            first = clean_body(a.group(2))
            if first:
                cur.paras.append(first)
            continue

        # plain-text section header (e.g. 担保解释 '一、关于一般规定')
        if not stripped.startswith(("-", ">")) and cur is None:
            s = SECNUM_RE.match(stripped)
            if s and len(stripped) < 30:
                set_div(1, f"{s.group(1)}、{squash(s.group(2))}")
                continue

        # continuation content
        body = stripped
        if body.startswith("- "):
            body = body[2:]
        body = clean_body(body)
        if not body:
            continue
        if cur is not None:
            cur.paras.append(body)
        elif tail_blocks and slots.get(1, "").startswith("附件"):
            tail_blocks[-1][1].append(body)
        else:
            # before the first article: keep only explicit preamble lines
            if any(k in body for k in preamble_markers):
                preamble.append(body)

    return preamble, articles, tail_blocks


def render(name, meta_line, preamble, articles, tail_blocks=()):
    out = [f"# {name}", "", f"> {meta_line}", ""]
    for p in preamble:
        out.append(p)
        out.append("")
    last_path = None
    for art in articles:
        if art.path != last_path:
            if art.path:
                out.append("## " + " · ".join(art.path))
                out.append("")
            last_path = art.path
        out.append(f"### {art.num}")
        out.append("")
        for p in art.paras:
            out.append(p)
            out.append("")
    for div, paras in tail_blocks:
        out.append(f"## {div}")
        out.append("")
        for p in paras:
            out.append(p)
            out.append("")
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if not text.endswith("\n"):
        text += "\n"
    return text


def parse_xingfa_amendment(path):
    """Extract verbatim replacement texts from 刑法修正案(十二)."""
    lines = path.read_text(encoding="utf-8").split("\n")
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1:]
                break
    items = []   # (target_article, first_para_only, [paras])
    cur = None
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        m = re.match(
            r"^[一二三四五六七八九十]+、(?:在刑法|将刑法)(第[%s]+条)(第一款)?.*?修改为：“(.*)$" % CN,
            line)
        if m:
            cur = {"target": m.group(1), "first_only": bool(m.group(2)), "paras": []}
            items.append(cur)
            txt = m.group(3)
            done = txt.endswith("”")
            cur["paras"].append(txt.rstrip("”"))
            if done:
                cur = None
            continue
        if cur is not None and line.startswith("“"):
            txt = line.lstrip("“")
            done = txt.endswith("”")
            cur["paras"].append(txt.rstrip("”"))
            if done:
                cur = None
    return items


LAWS = [
    {
        "slug": "minfadian",
        "src": SRC / "法律" / "ff808081729d1efe01729d50b5c500bf.md",
        "name": "中华人民共和国民法典",
        "meta": "文号：中华人民共和国主席令第四十五号 | 公布日期：2020-05-28 | 施行日期：2021-01-01 | 时效状态：现行有效",
        "expected": 1260,
    },
    {
        "slug": "minshisusongfa",
        "src": SRC / "法律" / "ff8081818a21dc13018b425303b7086d.md",
        "name": "中华人民共和国民事诉讼法",
        "meta": "文号：中华人民共和国主席令第十一号（2023年修正） | 公布日期：2023-09-01 | 施行日期：2024-01-01 | 时效状态：现行有效",
        "expected": 306,
    },
    {
        "slug": "gongsifa",
        "src": SRC / "法律" / "ff8081818c9108eb018cb6922f750c07.md",
        "name": "中华人民共和国公司法",
        "meta": "文号：中华人民共和国主席令第十五号（2023年修订） | 公布日期：2023-12-29 | 施行日期：2024-07-01 | 时效状态：现行有效",
        "expected": 266,
    },
    {
        "slug": "laodonghetongfa",
        "src": SRC / "法律" / "2c909fdd678bf17901678bf74d7106b3.md",
        "name": "中华人民共和国劳动合同法",
        "meta": "文号：中华人民共和国主席令第七十三号（2012年修正） | 公布日期：2012-12-28 | 施行日期：2013-07-01 | 时效状态：现行有效",
        "expected": 98,
    },
    {
        "slug": "xingfa",
        "src": SRC / "法律" / "ff808181796a636a0179822a19640c92.md",
        "name": "中华人民共和国刑法",
        "meta": "文号：中华人民共和国主席令第八十三号（1997年修订；2023年12月29日刑法修正案（十二）主席令第十八号修正，自2024-03-01施行） | 公布日期：1997-03-14 | 施行日期：1997-10-01 | 时效状态：现行有效",
        "amendment": SRC / "法律" / "ff8081818c3ce31f018cb6a6bc412f55.md",
        "expected": None,
    },
    {
        "slug": "zhaobiaotoubiaofa",
        "src": SRC / "法律" / "2c909fdd678bf17901678bf88f170b31.md",
        "name": "中华人民共和国招标投标法",
        "meta": "文号：中华人民共和国主席令第二十一号（1999年公布；2017年修正，主席令第八十六号） | 公布日期：2017-12-27 | 施行日期：2017-12-28 | 时效状态：现行有效",
        "expected": 68,
    },
    {
        "slug": "zhaobiaotoubiaofa-shishitiaoli",
        "src": SRC / "行政法规" / "ff8080816f3cbb3c016f410aac441307.md",
        "name": "中华人民共和国招标投标法实施条例",
        "meta": "文号：中华人民共和国国务院令第613号（2011年公布；2019年第三次修订，国务院令第709号） | 公布日期：2011-12-20 | 施行日期：2012-02-01 | 时效状态：现行有效",
        "expected": 84,
    },
    {
        "slug": "danbaozhidu-jieshi",
        "src": SRC / "司法解释" / "ff80808177e757ac01780077d2291b77.md",
        "name": "最高人民法院关于适用《中华人民共和国民法典》有关担保制度的解释",
        "meta": "文号：法释〔2020〕28号 | 公布日期：2020-12-31 | 施行日期：2021-01-01 | 时效状态：现行有效",
        "preamble_markers": ("制定本解释",),
        "expected": 71,
    },
    {
        "slug": "dulibaohan-guiding",
        "src": SRC / "司法解释" / "ff808181799df4000179abddf50b100d.md",
        "name": "最高人民法院关于审理独立保函纠纷案件若干问题的规定",
        "meta": "文号：法释〔2016〕24号（2020年修正，法释〔2020〕18号） | 公布日期：2020-12-29 | 施行日期：2021-01-01 | 时效状态：现行有效",
        "preamble_markers": ("制定本规定",),
        "expected": 26,
    },
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for law in LAWS:
        preamble, articles, tail_blocks = parse(law["src"], law.get("preamble_markers", ()))

        if law["slug"] == "xingfa":
            items = parse_xingfa_amendment(law["amendment"])
            by_num = {a.num: a for a in articles}
            applied = []
            for it in items:
                art = by_num.get(it["target"])
                if art is None:
                    print(f"  !! amendment target missing: {it['target']}")
                    continue
                if it["first_only"]:
                    art.paras = [it["paras"][0]] + art.paras[1:]
                    assert len(it["paras"]) == 1, it
                else:
                    art.paras = list(it["paras"])
                applied.append((it["target"], "第一款" if it["first_only"] else "全条",
                                len(it["paras"])))
            print(f"  xingfa amendment XII applied: {applied}")

        text = render(law["name"], law["meta"], preamble, articles, tail_blocks)
        out_file = OUT / (law["slug"] + ".md")
        out_file.write_text(text, encoding="utf-8", newline="\n")
        n = len(articles)
        exp = law["expected"]
        flag = "OK" if (exp is None or n == exp) else f"MISMATCH expected {exp}"
        print(f"{law['slug']}: {n} articles [{flag}], preamble={len(preamble)} paras")


if __name__ == "__main__":
    main()
