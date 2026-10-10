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
  phone in the background, a socket that died without closing). Hand merges:
  `web-connection-guard.tsx`, where the fork's reconnecting pill meets #840's
  probe (doc comment only); and, from v0.35.0, its desktop half is dropped —
  v0.35.0 ships its own heartbeat for the remote proxy (`run_ws_connection`
  in `remote_proxy.rs`), so `remote_proxy.rs`, `remote-desktop-transport.ts`
  and `lib.rs` stay upstream's and the desktop transport has no
  `probeLiveness` (optional in the interface). The browser half is carried
  whole. Once a release contains #840, drop these commits
  (`git rebase --skip` if git cannot tell on its own).
- Convert-to-Traditional button: a 「繁」 button left of Send converts the
  draft (or just the selection) from Simplified to Traditional Chinese with
  Taiwan phrasing (OpenCC `s2twp`), then switches punctuation to Taiwan's
  forms (`src/lib/fork/taiwan-punctuation.ts`): “”‘’ → 「」『』 when used in
  Chinese (English quotes and apostrophes stay), · → ‧ between Chinese
  characters, —— → ──, and half-width , . ? ! : ; after Chinese → full width
  (a period only before a space, the end or Chinese, so 說明.txt and ./src
  stay; straight quotes stay too, they may belong to a command). Reference
  badges and code between backticks are left alone; one Undo (offered in the
  toast) restores it. The
  chevron next to it holds a "Convert to Traditional before sending" switch
  (per device, off by default; 「繁」 turns primary and underlined while on):
  Send, Enter, queueing, saving a queued edit and steering then convert the
  whole draft first, and a converter that fails to load blocks the send
  instead of sending it unconverted. Upstream touch in
  `src/components/chat/message-input.tsx`: the button's mount, plus
  `handleSend` / `handleSteerClick` renamed to `…Now` and re-declared as
  `useSendAsTraditional(…Now)`, so every caller goes through the switch.
  Everything else is fork-only: `src/components/fork/convert-to-traditional-button.tsx`,
  `src/lib/fork/{s2twp,composer-to-traditional,convert-on-send}.ts`, and `src/lib/fork/opencc/`
  — opencc-js's core and the seven dictionaries s2twp uses, vendored rather
  than added to package.json so the lockfile stays upstream's and rebases keep
  applying. They load on the first press as their own chunk (about 430 KB
  gzipped). To update: `node scripts/fork/vendor-opencc.mjs <version>`.
- Thinking blocks open by default: one prop (`defaultOpen`) on `ReasoningPart`
  in `src/components/message/content-parts-renderer.tsx`. Upstream folds them
  until asked (its `Reasoning` default stays folded, and its tests still
  hold); once open, upstream no longer auto-closes them, so nothing is pulled
  away mid-read. Earlier replies still fold their whole process (thinking
  included) when a new message is sent — that is upstream's thread fold, left
  as is. Test: `src/components/fork/reasoning-default-open.test.tsx`.
- Token usage cost: a "Cost" section (official API rates, not a bill) on the
  Token Usage page — total (with the delta vs the previous period), a bar splitting
  it into input / output / cache write / cache read, cost per period, and a
  ranked list by model / agent / folder / session, in USD. Each model in the
  report gets its own model-filtered report, so periods, agents and folders
  are priced exactly instead of averaging rates; those reports also carry
  everything the detail views need, so they cost no extra requests:
  - a list row opens into its kind split, the other dimension (a model's
    agents; an agent's or folder's models) and its cost per session and per
    turn;
  - the trend stacks the three costliest models (accent tones, the rest
    merged), and tapping or hovering a period lists its models.
  The Session tab ranks sessions. The report only has a token total per
  session, so the list starts as an estimate at each agent's per-token rate
  for the model, then — only while that tab is open, for the listed sessions,
  two at a time, cached for the page — reads each session's own four-kind
  totals (`getFolderConversation` with `fromIndex` past the end: no turns,
  just stats; the server still parses the transcript). A session wholly in
  the range on one model is then exact and matches Session Details; one that
  crosses the range edge or used several models is split by tokens and keeps
  its ≈. Cache writes are priced at the 1-hour rate for Claude Code
  (measured: all of its writes are 1-hour) and the 5-minute rate for other
  agents; models without a known rate are listed as unpriced, never counted
  as zero. Rates are a LiteLLM snapshot in
  `src/lib/fork/pricing/prices.json`, refreshed with
  `node scripts/fork/vendor-prices.mjs`. Per-model reports are reused while
  the main report's numbers are unchanged (switching filters back, refreshes
  with no new usage). The only upstream touch is the section's mount in
  `src/components/token-usage/token-usage-page.tsx`; the rest is
  `src/components/fork/{token-usage-cost-section,cost-composition}.tsx` and
  `src/lib/fork/pricing/`.
- Reply cost: each reply's cost, from its own usage and model, as small text
  in its stats row next to the token icon (that icon's tooltip can't be
  opened by touch). A reply merged from sub-turns on different models is
  priced at the first one and marked ≈. Upstream touch: the agent type is
  provided around the thread in `src/components/message/message-list-view.tsx`
  (cache-write pricing depends on it) and the amount is one line in
  `src/components/message/turn-stats.tsx`; the rest is
  `src/components/fork/reply-cost.tsx`.
- Session cost: the same pricing in Session Details (the right panel tab and
  the dialog), under Token Usage — the total and the four-kind bar, then
  every priced model (one included, so it's clear which model the price is
  for) with its cost, its share when there are several, and each kind as
  tokens × rate = cost; plus the turn count and cost per turn when the whole
  session is loaded, and the rate snapshot's date.
  The amount always follows the session's total usage; the split comes from
  turns already in memory (the open conversation's timeline), never from an
  extra fetch — transcripts run to tens of MB. Turns older than the loaded
  window go to the earliest loaded model, flagged as an estimate when the
  session used more than one model. Upstream touch: the mount in
  `src/components/conversations/session-details-content.tsx`; the rest is
  `src/components/fork/session-cost-section.tsx` and
  `src/lib/fork/pricing/session-cost.ts`.
- `src/lib/constants.ts`: connection keepalive every 90s instead of 30s (still
  half the backend's default 180s idle timeout). Fork-only.

History: upstream PR #815 (relative file links) was carried from v0.32.0 until
v0.32.2 shipped it.
