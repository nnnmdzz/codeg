#!/usr/bin/env bash
# Build this fork's web client and install it where the fork's static server
# reads it. Run on the codeg server host.
#
#   scripts/fork/deploy-web.sh            # build + deploy
#   scripts/fork/deploy-web.sh --no-build # redeploy the last build
#
# The fork only replaces the FRONT END. /api and /ws still go to the one
# official codeg-server, so the web client must be built from the same release
# the server runs — otherwise the two can disagree on the API. This script
# reads the server's version and, if the fork branch sits on an older release
# tag, rebases it onto the matching one first (stopping on a conflict).
#
# The online updater never touches $TARGET: it updates CODEG_STATIC_DIR (the
# official web dir) only. After an online update, run this again.
set -euo pipefail

TARGET=${CODEG_FORK_WEB_DIR:-/usr/local/share/codeg/web-fork}
SERVER_BIN=${CODEG_SERVER_BIN:-/usr/local/bin/codeg-server}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO"

build=1
[[ "${1:-}" == "--no-build" ]] && build=0

server_version=$("$SERVER_BIN" --version | awk '{print $NF}')
want="v${server_version#v}"
base=$(git describe --tags --abbrev=0 HEAD)
echo "server: $want   fork base: $base   branch: $(git branch --show-current)"

if [[ "$base" != "$want" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree not clean; commit or stash before rebasing" >&2; exit 1
  fi
  echo "rebasing fork from $base onto $want ..."
  git fetch --quiet upstream tag "$want" --no-tags
  if ! git rebase --onto "$want" "$base"; then
    echo "rebase stopped on a conflict. Resolve it, 'git rebase --continue', then run this again." >&2
    echo "If the conflicting commit came from an upstream PR that $want already contains," >&2
    echo "'git rebase --skip' it — upstream's merged version replaces it." >&2
    exit 1
  fi
  echo "rebased. Push when ready: git push --force-with-lease origin $(git branch --show-current)"
fi

if (( build )); then
  pnpm install --frozen-lockfile
  # 水印上顯示的版本：上游 tag · fork commit（見 src/components/fork/fork-watermark.tsx）
  NEXT_PUBLIC_CODEG_FORK_TAG="${want#v}" \
    NEXT_PUBLIC_CODEG_FORK_COMMIT="$(git rev-parse --short HEAD)" \
    NODE_ENV=production pnpm build
fi

for f in index.html workspace.html; do
  [[ -f out/$f ]] || { echo "out/$f missing — build looks incomplete, not deploying" >&2; exit 1; }
done

# Swap in a whole new directory, keeping the previous one as .bak.
staging="$TARGET.new"
rm -rf "$staging"
mkdir -p "$(dirname "$TARGET")"
cp -a out "$staging"
printf '%s\n' "$want" "$(git rev-parse --short HEAD)" "$(date -Is)" > "$staging/.fork-build"
kept=""
if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET.bak"
  mv "$TARGET" "$TARGET.bak"
  kept=" (previous kept at $TARGET.bak)"
fi
mv "$staging" "$TARGET"
echo "deployed $(git rev-parse --short HEAD) for $want to $TARGET$kept"
