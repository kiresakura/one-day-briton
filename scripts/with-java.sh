#!/bin/sh
# 找一個可用的 Java 21 以上執行環境，放到 PATH 最前面，再執行後面的指令。
# 順序：$JAVA_HOME → PATH 上能正常執行的 java → 專案內的 .tools/jre（不進版控）。
# 用法：scripts/with-java.sh <指令> [參數…]
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# 目錄裡的 java 能執行，而且主版本 21 以上才算數（macOS 內建的 /usr/bin/java 只是空殼）。
usable() {
  [ -x "$1/java" ] || return 1
  major=$("$1/java" -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\).*/\1/p')
  [ "${major:-0}" -ge 21 ]
}

java_dir=
if [ -n "${JAVA_HOME:-}" ] && usable "$JAVA_HOME/bin"; then
  java_dir=$JAVA_HOME/bin
elif on_path=$(command -v java 2>/dev/null) && usable "$(dirname -- "$on_path")"; then
  java_dir=$(dirname -- "$on_path")
else
  for candidate in "$root/.tools/jre/bin" "$root/.tools/jre/Contents/Home/bin"; do
    if usable "$candidate"; then
      java_dir=$candidate
      break
    fi
  done
fi

if [ -z "$java_dir" ]; then
  cat >&2 <<'MESSAGE'
找不到可用的 Java。資料庫模擬器需要 JDK/JRE 21 以上。
請擇一處理：
  1. 自行安裝 JDK/JRE 21 以上，並設定 JAVA_HOME 或讓 java 出現在 PATH；
  2. 下載 Eclipse Temurin JRE 21，解壓到專案的 .tools/jre/（做法見 play/README.md）。
MESSAGE
  exit 1
fi

PATH="$java_dir:$PATH"
export PATH
exec "$@"
