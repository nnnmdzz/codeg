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

After the server updates itself, run `scripts/fork/deploy-web.sh`. It reads the
server's version, rebases this branch onto that release tag (stops on a
conflict), builds, and swaps the result in with a `.bak` of the previous build.
Until then the fork UI is one release behind the server; the official UI is
always current.

## Changes carried

- `fix(markdown): keep relative file links relative through rehype-harden`
  (upstream PR #815)
