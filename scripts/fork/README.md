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

From the page: while the watermark is amber it is a button. It opens a small
panel with "Update now", which starts the same `codeg-web-fork-update.service`
through `codeg-fork-admin` (below), shows how long it has been running and the
current step, the log when it fails, and "Reload page" once the new build is
deployed. A run the timer already started shows up there too.

By hand: after the server updates itself, run `scripts/fork/deploy-web.sh`. It reads the
server's version, rebases this branch onto that release tag (stops on a
conflict), builds, and swaps the result in with a `.bak` of the previous build.
Until then the fork UI is one release behind the server; the official UI is
always current.

## The update button's backend

`scripts/fork/fork_admin.py` is a small stdlib-only HTTP service run by
`codeg-fork-admin.service`. It listens only on the unix socket
`/run/codeg-fork-admin/admin.sock` — no TCP port — which the fork's nginx
container mounts and serves under `/__fork/`. Every request must carry the
page's codeg `Authorization: Bearer` header; the service keeps no secret of its
own and forwards that header to the local `codeg-server`'s `/api/health`, so a
token codeg accepts is the only way in. It can do exactly two things:

- `GET /__fork/status`: server version, the fork build on disk, and the
  updater's state (`idle` / `running` / `failed`, with the run's last log
  lines when running or failed)
- `POST /__fork/update`: `systemctl start codeg-web-fork-update.service`
  (joins a run already in progress)

It runs as root only so it can start that unit; the unit file drops every
capability, mounts the file system read-only, and allows network access to
localhost only.

Units (copies of what is installed live in `scripts/fork/systemd/`):

```bash
sudo cp scripts/fork/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codeg-web-fork-update.timer codeg-fork-admin.service
```

nginx (the `codeg-web-fork` service in the codeg compose stack): mount
`/run/codeg-fork-admin:/run/codeg-fork-admin:ro` and add

```nginx
location /__fork/ {
  proxy_pass http://unix:/run/codeg-fork-admin/admin.sock:/;
  proxy_read_timeout 15s;
}
```

Tests: `python3 scripts/fork/test_fork_admin.py` (fake codeg, fake
`systemctl`/`journalctl`, real unix socket — never touches systemd).

## Changes carried

Keep these small, and where possible make them upstream PRs first: once a
release contains a carried PR, the rebase can drop it (`git rebase --skip` if
git cannot tell on its own — upstream's merged version replaces it).

- `src/components/fork/fork-watermark.tsx` + one line in `src/app/layout.tsx`
  (inside the i18n providers, for the locale): a small "dev fork · <tag> ·
  <commit>" watermark at the bottom of every page, so this UI is never mistaken
  for the official one. It asks the server its version (`/api/health`) and,
  when the server has updated past the fork, turns amber and becomes the update
  button above. Fork-only.
- Upstream PR #840 ("recover the live session after sleep/wake instead of
  going stale"), cherry-picked as its five commits with `-x`: a WebSocket
  heartbeat and wake-time liveness probe, and a transcript resync after the
  event stream was down. It is the fix for replies that stop half-way with the
  send button already back — a turn that ended while the stream was down (a
  phone in the background, a socket that died without closing). Its Rust half
  (the desktop remote proxy) is carried but unused here. One hand merge:
  `web-connection-guard.tsx`, where the fork's reconnecting pill meets #840's
  probe (doc comment only). Once a release contains #840, drop these commits
  (`git rebase --skip` if git cannot tell on its own).
- Convert-to-Traditional button: a 「繁」 button left of Send converts the
  draft (or just the selection) from Simplified to Traditional Chinese with
  Taiwan phrasing (OpenCC `s2twp`). Reference badges and code between
  backticks are left alone; one Undo (offered in the toast) restores it. The
  only upstream touch is two lines in `src/components/chat/message-input.tsx`;
  everything else is fork-only: `src/components/fork/convert-to-traditional-button.tsx`,
  `src/lib/fork/{s2twp,composer-to-traditional}.ts`, and `src/lib/fork/opencc/`
  — opencc-js's core and the seven dictionaries s2twp uses, vendored rather
  than added to package.json so the lockfile stays upstream's and rebases keep
  applying. They load on the first press as their own chunk (about 430 KB
  gzipped). To update: `node scripts/fork/vendor-opencc.mjs <version>`.
- `src/lib/constants.ts`: connection keepalive every 90s instead of 30s (still
  half the backend's default 180s idle timeout). Fork-only.

History: upstream PR #815 (relative file links) was carried from v0.32.0 until
v0.32.2 shipped it.
