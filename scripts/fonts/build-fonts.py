#!/usr/bin/env python3
# 自行託管字型的建置：把 .tools/fonts-src/ 的原始字型做成 play/fonts/ 的 woff2 子集。
#
# 用法（在專案根目錄執行；環境準備見 scripts/fonts/README.md）：
#   sh scripts/fonts/fetch-sources.sh
#   .tools/fontenv/bin/python scripts/fonts/build-fonts.py
#   npm run fonts:check
#
# 步驟：向 charset.mjs 要字表 → 可變字型固定在指定字重 → 用 fontTools 子集化 → 授權檔若列出保留字型名稱
# （Reserved Font Name）就把字型內部名稱改成中性的新名稱 → 寫出 woff2、授權檔與 fallback-chars.json。
# 不改時間戳記，同樣的輸入每次都產生一模一樣的位元組。
import hashlib
import json
import re
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / ".tools" / "fonts-src"
OUT = ROOT / "play" / "fonts"
CHARSET = ROOT / "scripts" / "fonts" / "charset.mjs"
FALLBACK = ROOT / "scripts" / "fonts" / "fallback-chars.json"

# 瀏覽器排橫書時預設會開的 OpenType 功能；直書、全形／半形替換、小型大寫等都不收。
HORIZONTAL = ["ccmp", "locl", "rvrn", "liga", "clig", "calt", "rlig", "rclt", "kern", "mark", "mkmk", "curs"]
# 中文另留標點擠壓（Chrome 的 text-spacing-trim 會用到）。
CJK_FEATURES = HORIZONTAL + ["halt", "chws"]
# 拉丁字型另留等寬數字（app.css 有用 font-variant-numeric: tabular-nums）。
LATIN_FEATURES = HORIZONTAL + ["tnum"]
# 只留版權（0）、名稱（1–6、16、17）與授權（13、14）；其餘名稱與直書度量（vhea、vmtx、VORG）、STAT 都不收。
NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
EXTRA_DROP_TABLES = ["vhea", "vmtx", "VORG", "STAT"]

FONTS = [
    {
        "out": "NotoSerifTC-Bold.woff2",
        "source": "notoseriftc/NotoSerifTC[wght].ttf",
        "wght": 700,
        "charset": "cjk",
        "features": CJK_FEATURES,
        "license": "notoseriftc/OFL.txt",
        "license_out": "OFL-NotoSerifTC.txt",
        "rename": ("ODB Serif TC", "ODBSerifTC"),
    },
    {
        "out": "NotoSerifTC-Black.woff2",
        "source": "notoseriftc/NotoSerifTC[wght].ttf",
        "wght": 900,
        "charset": "cjk",
        "features": CJK_FEATURES,
        "license": "notoseriftc/OFL.txt",
        "license_out": "OFL-NotoSerifTC.txt",
        "rename": ("ODB Serif TC", "ODBSerifTC"),
    },
    {
        "out": "Cinzel-Bold.woff2",
        "source": "cinzel/Cinzel[wght].ttf",
        "wght": 700,
        "charset": "latin",
        "features": LATIN_FEATURES,
        "license": "cinzel/OFL.txt",
        "license_out": "OFL-Cinzel.txt",
        "rename": None,
    },
    {
        "out": "CormorantGaramond-SemiBold.woff2",
        "source": "cormorantgaramond/CormorantGaramond[wght].ttf",
        "wght": 600,
        "charset": "latin",
        "features": LATIN_FEATURES,
        "license": "cormorantgaramond/OFL.txt",
        "license_out": "OFL-CormorantGaramond.txt",
        "rename": None,
    },
]


def fail(message):
    sys.exit(f"build-fonts：{message}")


def required_chars(kind):
    try:
        result = subprocess.run(["node", str(CHARSET), kind, "--json"], cwd=ROOT, capture_output=True, check=False)
    except FileNotFoundError:
        fail("找不到 node；字表由 charset.mjs 計算，需要 Node.js")
    if result.returncode != 0:
        fail(f"charset.mjs {kind} 失敗：{result.stderr.decode('utf-8', 'replace').strip()}")
    return set(json.loads(result.stdout))


def unicode_points(font):
    points = set()
    for table in font["cmap"].tables:
        if table.isUnicode() and table.format != 14:
            points.update(cp for cp, glyph in table.cmap.items() if glyph != ".notdef")
    return points


def reserved_font_names(license_text):
    """授權檔在 OFL 正文之前的版權聲明裡，用 Reserved Font Name 列出的名稱。"""
    parts = re.split(r"SIL OPEN FONT LICENSE Version 1\.1", license_text, maxsplit=1)
    if len(parts) != 2:
        fail("授權檔不是預期的 OFL 1.1 格式，請人工確認保留字型名稱")
    names = []
    for match in re.finditer(r"Reserved\s+Font\s+Names?\s*:?\s*([^\n]*(?:\n[^\n]+)*)", parts[0], re.I):
        quoted = re.findall(r"[\"'“‘]([^\"'”’]+)[\"'”’]", match.group(1))
        names.extend(quoted or [match.group(1).strip().rstrip(".")])
    return names


def rename_family(font, new_family, new_ps_family):
    """把字型內部名稱換成新的家族名；只改 name 表 1、3、4、6、16、17、18、21、22、25 號，版權（0）與授權（13、14）不動。"""
    if "CFF " in font or "CFF2" in font:
        fail("CFF 字型的內部名稱（CFF 表裡的字型名）改名還沒做，請改用 TrueType 原始檔")
    name = font["name"]
    old_family = name.getDebugName(16) or name.getDebugName(1)
    old_ps_family = (name.getDebugName(6) or "").split("-")[0]
    for record in name.names:
        text = record.toUnicode()
        if record.nameID in (1, 4, 16, 18, 21):
            record.string = text.replace(old_family, new_family)
        elif record.nameID in (3, 6, 25):
            record.string = text.replace(old_ps_family, new_ps_family)
        # 17、22 是樣式名（Bold、Black），本來就不含家族名。
    return [old_family, old_ps_family]


def check_names(font, banned, out):
    for record in font["name"].names:
        if record.nameID in (0, 13, 14):
            continue
        text = record.toUnicode().lower()
        for word in banned:
            if word and word.lower() in text:
                fail(f"{out} 的 name 表 {record.nameID} 號仍含「{word}」")


def build(spec, chars):
    source = SRC / spec["source"]
    license_file = SRC / spec["license"]
    for path in (source, license_file):
        if not path.is_file():
            fail(f"找不到 {path.relative_to(ROOT)}，請先跑 sh scripts/fonts/fetch-sources.sh")
    font = TTFont(source, recalcTimestamp=False)
    lacking = chars - unicode_points(font)
    if spec["wght"] is not None and "fvar" in font:
        font = instancer.instantiateVariableFont(font, {"wght": spec["wght"]}, updateFontNames=True, static=True)

    options = subset.Options()
    options.flavor = "woff2"
    options.hinting = False
    options.desubroutinize = True
    options.layout_features = spec["features"]
    options.name_IDs = NAME_IDS
    options.name_languages = [0x0409]
    options.drop_tables = list(options.drop_tables) + EXTRA_DROP_TABLES
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(chars - lacking))
    subsetter.subset(font)

    rfn = reserved_font_names(license_file.read_text(encoding="utf-8"))
    if rfn:
        if not spec["rename"]:
            fail(f"{spec['license']} 列出保留字型名稱 {rfn}，但 {spec['out']} 沒有設定改名")
        old_names = rename_family(font, *spec["rename"])
        check_names(font, rfn + old_names, spec["out"])

    buffer = BytesIO()
    subset.save_font(font, buffer, options)
    data = buffer.getvalue()

    covered = unicode_points(TTFont(BytesIO(data)))
    if chars - lacking - covered:
        fail(f"{spec['out']} 子集化後少了 {sorted(chars - lacking - covered)}")
    return data, lacking, rfn


def main():
    charsets = {kind: required_chars(kind) for kind in sorted({spec["charset"] for spec in FONTS})}
    for kind, chars in charsets.items():
        digest = hashlib.sha256(json.dumps(sorted(chars)).encode()).hexdigest()[:12]
        print(f"字表 {kind}：{len(chars)} 字（sha256 {digest}）")

    results = []
    for spec in FONTS:
        data, lacking, rfn = build(spec, charsets[spec["charset"]])
        results.append((spec, data, lacking))
        note = f"，保留字型名稱 {rfn} → 改名為 {spec['rename'][0]}" if rfn else ""
        print(f"{spec['out']}：{len(data)} 位元組，原檔沒有的字 {len(lacking)} 個{note}")

    # 全部做完才寫檔，中途失敗不會留下一半新一半舊的字型。
    OUT.mkdir(parents=True, exist_ok=True)
    fallback = {}
    for spec, data, lacking in results:
        (OUT / spec["out"]).write_bytes(data)
        shutil.copyfile(SRC / spec["license"], OUT / spec["license_out"])
        fallback[spec["out"]] = [{"code": f"U+{cp:04X}", "char": chr(cp)} for cp in sorted(lacking)]
    FALLBACK.write_text(json.dumps(fallback, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum(len(data) for _, data, _ in results)
    print(f"共 {total} 位元組；已寫出 play/fonts/ 與 scripts/fonts/fallback-chars.json")


if __name__ == "__main__":
    main()
