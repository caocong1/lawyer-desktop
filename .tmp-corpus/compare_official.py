# -*- coding: utf-8 -*-
"""Compare generated interpretation md files against official court.gov.cn HTML."""
import re
import difflib
from pathlib import Path
from html.parser import HTMLParser

TMP = Path(r"C:\Users\sorawatcher\workspace\lawyer-desktop\.tmp-corpus")
OUT = Path(r"C:\Users\sorawatcher\workspace\lawyer-desktop\src-tauri\resources\law-library")

CN = "零一二三四五六七八九十百千"


class TextExtract(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in ("p", "br", "div"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_text(path):
    p = TextExtract()
    p.feed(path.read_text(encoding="utf-8", errors="replace"))
    return "".join(p.parts)


def split_articles(text):
    """Split normalized text into {article_label: body} keyed on 第X条 at para start."""
    arts = {}
    cur = None
    for line in text.split("\n"):
        line = re.sub(r"[\s　]+", "", line)
        if not line:
            continue
        m = re.match(r"^(第[%s]+条(?:之[%s]+)?)(.*)$" % (CN, CN), line)
        if m and len(m.group(1)) >= 3:
            cur = m.group(1)
            arts.setdefault(cur, "")
            arts[cur] += m.group(2)
        elif cur:
            arts[cur] += line
    return arts


def md_articles(path):
    arts = {}
    cur = None
    for line in path.read_text(encoding="utf-8").split("\n"):
        m = re.match(r"^### (第[%s]+条(?:之[%s]+)?)$" % (CN, CN), line)
        if m:
            cur = m.group(1)
            arts[cur] = ""
        elif line.startswith("#"):
            cur = None
        elif cur is not None:
            arts[cur] += re.sub(r"[\s　]+", "", line)
    return arts


def compare(md_file, html_file, label):
    gen = md_articles(OUT / md_file)
    off = split_articles(html_text(TMP / html_file))
    print(f"=== {label}: generated {len(gen)} arts, official page {len(off)} arts ===")
    missing = [k for k in gen if k not in off]
    if missing:
        print(f"  not found on official page: {missing}")
    same, diff = 0, []
    for k, v in gen.items():
        if k not in off:
            continue
        o = off[k]
        # official page may have trailing junk after last article; compare prefix-tolerant
        if v == o or o.startswith(v):
            same += 1
        else:
            diff.append(k)
    print(f"  exact-match articles: {same}/{len(gen) - len(missing)}")
    for k in diff:
        sm = difflib.SequenceMatcher(None, gen[k], off[k])
        print(f"  DIFF {k} (ratio {sm.ratio():.3f}):")
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag != "equal":
                print(f"    {tag}: gen[{gen[k][i1:i2][:80]!r}] vs off[{off[k][j1:j2][:80]!r}]")


compare("danbaozhidu-jieshi.md", "danbao-official.html", "担保制度解释 vs 法释2020-28 官方页")
compare("dulibaohan-guiding.md", "dulibaohan-official.html", "独立保函规定(2020修正) vs 2016原文官方页")
