#!/bin/sh
# 下載建置字型用的原始字型與授權檔到 .tools/fonts-src/（不進版控），並逐一核對 SHA-256。
# 網址都釘在上游儲存庫的固定版本（commit），內容不會變；核對不符就停下來、不留下檔案。
# 用法（在專案根目錄）：sh scripts/fonts/fetch-sources.sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
DEST="$ROOT/.tools/fonts-src"
GOOGLE_FONTS=https://github.com/google/fonts/raw/1d0e46c7933245c8180fe83e47917961c913bbdb

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    echo "找不到 sha256sum 或 shasum，沒辦法核對下載的檔案" >&2
    exit 1
  fi
}

# fetch <存到 .tools/fonts-src/ 底下的路徑> <網址> <SHA-256>
fetch() {
  out="$DEST/$1"
  if [ -f "$out" ] && [ "$(sha256_of "$out")" = "$3" ]; then
    echo "已有 $1"
    return 0
  fi
  mkdir -p "$(dirname -- "$out")"
  echo "下載 $1"
  curl -fsSL --retry 3 -o "$out.part" "$2"
  actual=$(sha256_of "$out.part")
  if [ "$actual" != "$3" ]; then
    rm -f "$out.part"
    echo "SHA-256 不符：$1" >&2
    echo "  預期 $3" >&2
    echo "  實際 $actual" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

fetch 'notoseriftc/NotoSerifTC[wght].ttf' "$GOOGLE_FONTS/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf" \
  0077e18f57c6908f4a000969880940bdb0dad057c0e8d98b49dc364c3d1b09c6
fetch 'notoseriftc/OFL.txt' "$GOOGLE_FONTS/ofl/notoseriftc/OFL.txt" \
  5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6
fetch 'cinzel/Cinzel[wght].ttf' "$GOOGLE_FONTS/ofl/cinzel/Cinzel%5Bwght%5D.ttf" \
  f4d83d34d1f6c741193e4acf4b3dff9531e5a67b6aa65228d00a7db72a4e0f34
fetch 'cinzel/OFL.txt' "$GOOGLE_FONTS/ofl/cinzel/OFL.txt" \
  f2b3029aba64c378bf0963b62945eee15e564fe4330b934c8f2eb058282b5e83
fetch 'cormorantgaramond/CormorantGaramond[wght].ttf' "$GOOGLE_FONTS/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf" \
  b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0
fetch 'cormorantgaramond/OFL.txt' "$GOOGLE_FONTS/ofl/cormorantgaramond/OFL.txt" \
  60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956

echo "原始字型都已就緒（.tools/fonts-src/）"
