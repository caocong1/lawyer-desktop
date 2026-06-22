# -*- coding: utf-8 -*-
"""Validate strict law-library markdown format + article continuity."""
import re
import sys
from pathlib import Path

OUT = Path(r"C:\Users\sorawatcher\workspace\lawyer-desktop\src-tauri\resources\law-library")

CN_DIGIT = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4,
            "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn2int(s):
    """Chinese numeral (up to thousands) -> int."""
    total, section, num = 0, 0, 0
    for ch in s:
        if ch in CN_DIGIT:
            num = CN_DIGIT[ch]
        elif ch == "十":
            section += (num or 1) * 10
            num = 0
        elif ch == "百":
            section += (num or 1) * 100
            num = 0
        elif ch == "千":
            section += (num or 1) * 1000
            num = 0
        else:
            raise ValueError(f"bad numeral char {ch!r} in {s!r}")
    return total + section + num


ART_HEAD = re.compile(r"^### (第([零一二三四五六七八九十百千]+)条(之([零一二三四五六七八九十]+))?)$")

problems = []
report = []

for f in sorted(OUT.glob("*.md")):
    text = f.read_text(encoding="utf-8")
    lines = text.split("\n")
    errs = []

    # H1 rules
    h1s = [i for i, l in enumerate(lines) if l.startswith("# ")]
    if len(h1s) != 1 or h1s[0] != 0:
        errs.append(f"H1 count/position bad: {h1s[:3]}")
    if not lines[1] == "" or not lines[2].startswith("> 文号："):
        errs.append("metadata line not at expected position")

    # whitespace hygiene
    if "\r" in text:
        errs.append("CR found")
    trail = [i + 1 for i, l in enumerate(lines) if l != l.rstrip()]
    if trail:
        errs.append(f"trailing spaces on lines {trail[:5]}")
    if re.search(r"\n{3,}", text):
        errs.append("triple blank lines")
    if "**" in text:
        errs.append("bold markup remains")
    if "[^" in text or "↑" in text:
        errs.append("footnote markup remains")

    # every ### heading must be an article heading
    arts = []
    for i, l in enumerate(lines):
        if l.startswith("###"):
            m = ART_HEAD.match(l)
            if not m:
                errs.append(f"line {i+1}: non-article ### heading: {l!r}")
                continue
            base = cn2int(m.group(2))
            sub = cn2int(m.group(4)) if m.group(4) else 0
            arts.append((base, sub, m.group(1), i + 1))
        elif l.startswith("##") and not l.startswith("## "):
            errs.append(f"line {i+1}: bad ## heading {l!r}")

    # continuity
    anomalies = []
    prev = None
    for base, sub, label, ln in arts:
        if prev is not None:
            pb, ps = prev
            ok = (base == pb + 1 and sub == 0) or \
                 (base == pb and sub == ps + 1)
            if not ok:
                if base > pb + 1:
                    anomalies.append(f"gap {pb}->{base} (line {ln})")
                else:
                    errs.append(f"line {ln}: ordering break {pb}之{ps} -> {label}")
        elif base != 1:
            errs.append(f"first article is {label}, not 第一条")
        prev = (base, sub)

    n_sub = sum(1 for a in arts if a[1] > 0)
    # empty article bodies
    for idx, (base, sub, label, ln) in enumerate(arts):
        nxt = arts[idx + 1][3] - 1 if idx + 1 < len(arts) else len(lines)
        body = [l for l in lines[ln:nxt] if l.strip() and not l.startswith("#")]
        if not body:
            errs.append(f"{label} (line {ln}): empty body")

    report.append((f.name, len(arts), arts[-1][0] if arts else 0, n_sub, anomalies))
    if errs:
        problems.append((f.name, errs))

print(f"{'file':<38}{'articles':>9}{'last#':>7}{'之X':>5}  anomalies")
for name, n, last, nsub, anom in report:
    print(f"{name:<38}{n:>9}{last:>7}{nsub:>5}  {'; '.join(anom) if anom else '-'}")

if problems:
    print("\nPROBLEMS:")
    for name, errs in problems:
        print(f"  {name}:")
        for e in errs:
            print(f"    - {e}")
    sys.exit(1)
print("\nAll files pass strict format + continuity checks.")
