#!/usr/bin/env bash
# 由 systemd timer 定時執行：伺服器線上更新後（版本和 fork 網頁的建置版本不同），
# 自動 rebase、建置、部署 fork 網頁，成功後把 rebase 過的分支推回 GitHub。
# 版本相同時什麼都不做。rebase 衝突或建置失敗時停下來，不部署，
# 錯誤留在 journal（journalctl -u codeg-web-fork-update）。
set -euo pipefail

TARGET=${CODEG_FORK_WEB_DIR:-/usr/local/share/codeg/web-fork}
SERVER_BIN=${CODEG_SERVER_BIN:-/usr/local/bin/codeg-server}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO"

# 同一時間只跑一個
exec 9>"/tmp/codeg-web-fork-update.lock"
flock -n 9 || { echo "another update is running"; exit 0; }

server="v$("$SERVER_BIN" --version | awk '{print $NF}')"
built=$(head -1 "$TARGET/.fork-build" 2>/dev/null || echo "none")
if [[ "$server" == "$built" ]]; then
  exit 0
fi

echo "server $server, fork web built for $built — updating"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "fork repo has uncommitted changes; not updating automatically" >&2
  exit 1
fi
scripts/fork/deploy-web.sh
git push --force-with-lease origin "$(git branch --show-current)"
echo "fork web updated to $server"
