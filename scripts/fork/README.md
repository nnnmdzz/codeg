# The `mobile` fork

This branch is upstream codeg at the release the server runs, plus a few
front-end changes. Only the web client is used from it: the server stays the
official `codeg-server` (and keeps updating itself online).

Served side by side with the official UI, behind the same backend:

- `codeg-us.cdn.…` → official `codeg-server` (web + `/api` + `/ws`)
- `codegdev-us.cdn.…` → `/api`, `/ws` to the same `codeg-server`; everything
  else to a static nginx serving `/usr/local/share/codeg/web-fork`

Both see the same conversations and the same running agents.

## Updating

Automatic: `codeg-web-fork-update.timer` runs `scripts/fork/auto-update.sh`
every 10 minutes. When the server's version differs from the version the fork
web was built for, it runs the deploy below and pushes the rebased branch; on a
rebase conflict or a failed build it stops without deploying (see
`journalctl -u codeg-web-fork-update`). Until then the watermark is amber.

By hand: after the server updates itself, run `scripts/fork/deploy-web.sh`. It reads the
server's version, rebases this branch onto that release tag (stops on a
conflict), builds, and swaps the result in with a `.bak` of the previous build.
Until then the fork UI is one release behind the server; the official UI is
always current.

## Changes carried

Keep these small, and where possible make them upstream PRs first: once a
release contains a carried PR, the rebase can drop it (`git rebase --skip` if
git cannot tell on its own — upstream's merged version replaces it).

- `src/components/fork/fork-watermark.tsx` + one line in `src/app/layout.tsx`:
  a small "dev fork · <tag> · <commit>" watermark at the bottom of every page,
  so this UI is never mistaken for the official one. It asks the server its
  version (`/api/health`) and turns amber when the server has updated past the
  fork. Fork-only.
- `src/lib/constants.ts`: connection keepalive every 90s instead of 30s (still
  half the backend's default 180s idle timeout). Fork-only.

History: upstream PR #815 (relative file links) was carried from v0.32.0 until
v0.32.2 shipped it.
