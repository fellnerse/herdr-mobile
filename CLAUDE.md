# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SheepIt: a phone client for [Herdr](https://herdr.dev), the terminal multiplexer
local coding agents run in. A Python gateway on the developer's machine talks to
Herdr's UNIX sockets and serves a home-screen web app to an iPhone over
Tailscale. `README.md` describes the features from the user's side; `docs/`
carries the detail (`gateway.md` — running and routes, `push.md` — iOS
notifications, `design.md` — the sheep, the parsing, the console,
`scheduler.md` — the prompt queue and the usage windows it waits for).

## Hard constraints

These are the rules the whole repository is built on; breaking one is a design
change, not a refactor.

- **The gateway is Python standard library only.** No pip, no requirements file.
  Web Push signing (`gateway/push.py`) is hand-rolled ECDSA/HKDF against
  `hashlib`/`hmac` for this reason.
- **The web app has no build step.** `web/` is plain HTML/CSS/JS served as-is.
  The only third-party file is xterm.js, vendored unchanged in `web/vendor/`.
- **The gateway never reaches the public internet**, except Apple's push service.
- **Ported code carries its notice.** `bincode.py`, `terminal.py` and
  `gitdiff.py` are ports from herdr-studio (MIT); each says so at the top and
  `LICENSES/` holds the text. Keep that if you touch them.
- **Licence is PolyForm Noncommercial 1.0.0** — source-available, not open source.

## Commands

```bash
python3 gateway/server.py                       # serve on http://127.0.0.1:3009
tailscale serve --bg --https=8443 http://127.0.0.1:3009

node tools/test-transcript.js                   # pane parser, both agents
node tools/test-diff.js                         # diff rendering, unified + split
node tools/test-drafts.js                       # per-project drafts
node tools/test-flock.js                        # the overview: grouping, order, rows
node tools/test-queue.js                        # the queue above the composer
python3 tools/test-gateway.py                   # bincode, framing, git, notifications

tools/sheepit-queue list | add | cancel         # the prompt queue from a terminal

make -C menubar all                             # build SheepIt.app (clang, no Xcode)
make -C menubar run | install | login | unlogin
python3 tools/make-bleat.py                     # regenerate web/bleat.wav
```

There is no runner, no lint and no formatter: each suite is a standalone script
that prints failures and exits non-zero, so "run one test" means run one of the
six suites. Restart `server.py` after changing the gateway; changing `web/` only
needs a reload.

Environment: `SHEEPIT_PORT` (or `PORT`, default 3009), `HOST` (default
127.0.0.1), `HERDR_SOCKET`, `HERDR_CLIENT_SOCKET`, `SHEEPIT_STATE_DIR`
(default `~/.config/sheepit`, holds VAPID keys and push subscriptions).

## Architecture

```
web/ (PWA on the phone) ──HTTPS over tailnet──> tailscale serve
                                                     │
                                            gateway/server.py
                                       ┌─────────────┴─────────────┐
                              herdr.sock (JSON-RPC)        herdr-client.sock
                              everything but the console   (bincode, the console)
```

**Two sockets, two protocols.** Nearly everything is JSON-RPC over `herdr.sock`
(`agent.list`, `agent.read`, `agent.prompt`, `agent.send_keys`, `pane.*`,
`workspace.*`, `tab.*`), spoken by `gateway/herdr_rpc.py`. The console is
different: `gateway/terminal.py` speaks Herdr's
*client* protocol over `herdr-client.sock` — the one a desktop Herdr speaks —
encoded with the bincode codec in `gateway/bincode.py`, proxied to the browser
as a WebSocket framed by hand in `gateway/wsproto.py`, and drawn by xterm.js.
Herdr protocol versions differ (14–20 vs 22) in handshake shape and in
`ServerMessage` variant numbering; `terminal.py` asks the server which it speaks
rather than assuming. Attaching **sets the pane's size**, which resizes it for
whatever desktop client is also showing it.

**The transcript is a guess.** `web/app.js` reads a raw terminal dump and infers
structure from glyphs — which line starts a turn, which rules frame the
composer, which trailing lines are the status bar, which lines are a selection
prompt and how many options it offers. Claude Code and Codex draw with different
glyphs and both must parse. The failure that matters is a waiting agent whose
question never reaches the phone, so `tools/test-transcript.js` holds real pane
fixtures for both agents. The **plain view** exists as the escape hatch when the
guessing hides something — keep it working verbatim.

**Status vocabulary.** Herdr's `agent_status` (`working`, `idle`, `done`,
`blocked`, plus anything unrecognised → `unknown`) drives the sheep pose, the
dot colour and the badge through one whitelist (`POSE` in `app.js`). Adding a
status means adding it there, not branching at the call sites. Status is the
fleece colour and the pose; *identity* is the ear tag, fleece patch and face
shade, hashed from the pane id in `sheepMarks` — the two must stay independent,
or two agents on one project read as the same animal.

**Rows come from workspaces and their tabs, not from agents**
(`build_agent_rows` in `server.py`): one row per tab, so a tab running a plain
shell is still reachable, and a split tab running two agents gets a row each
rather than hiding one. A Herdr that does not answer `tab.list` falls back to
the tab ids the panes carry (`tabs_from_panes`).

**The phone groups those rows by project, not by workspace** (`groupByProject`
in `app.js`): the key is `worktree.repo_root` as read by `project_of`, so the
scheduler's `sheep/` worktrees sit under the repository they were cut from. The
list is only redrawn when its signature changes — a blind redraw restarts every
sheep animation, drops a row held open by a swipe, and pulls the floor out from
under a project being dragged.

**Order is creation order, then a question, then a finger.** Rows sort by
`bornAt` (workspace `number` × 1000 + pane index — Herdr exposes no creation
date anywhere, and never renumbers); an agent `blocked` on a question rises to
the top of its project and takes the project with it; a drag overrides both and
is saved to `localStorage` (`sortGroups`). The drag also calls `workspace.move`,
but only when the project is a single workspace — a project is a repository and
Herdr reorders workspaces. `workspace.move` counts the workspace being moved
when it resolves `insert_index`, which is why `insertIndexFor` exists and is
tested exhaustively. `state_change_seq` orders nothing; it feeds the "3m" label.

**Renames go through Herdr** (`workspace.rename`, `tab.rename`) rather than
being kept phone-side, so the desktop's workspace strip and tab bar change too.
A row is a tab, so Rename is `tab.rename` — except on a workspace holding one
tab, where it renames the workspace (`renameRow`). A tab's *displayed* number is
its `label`, not its `number` — see `tabNumber`.

**The queue waits for the window.** Prompts from the phone go to `/api/queue`
rather than straight to an agent: `gateway/scheduler/` holds them in SQLite and
`dispatch.py` sends them as soon as the pane can take one (or immediately, via
`/api/queue/{id}/send`) — **usage never gates
delivery**; only a pane that hit the wall mid-turn is parked, until the window
it exhausted reopens. `quota.py` reads usage per agent, since Claude and Codex
spend different subscriptions, and has
two sources for each: what the API says (Claude only, token from the Keychain on
macOS) and what the agent wrote down itself (`.claude.json`'s cached reading,
Codex's rollout `rate_limits`), which needs no credentials — plus, for Codex,
the `/status` box parsed off the pane, since its rollout only moves when the
model answers. A reading expires with the window it describes: a `resets_at` in
the past means the percentage belongs to a window that is gone. Asking a pane
for `/status` needs an idle pane **and an empty composer**, or the command is
submitted along with whatever somebody was typing. `docs/scheduler.md` is the
detail.

**Push carries no payload.** iOS/Web Push here sends an empty notification; the
service worker (`web/sw.js`) then fetches `/api/push/last`, which the gateway's
`StatusWatcher` thread parked when it saw the transition (TTL 120s, applied on
both sides). Only `working → done` and `working → blocked` earn a push: `idle`
is the prompt box Claude Code passes through on every `/clear`, and pushing on
it taught people to ignore the ones that mattered.

**Security is position, not authentication.** No accounts, no tokens: the
gateway binds loopback behind `tailscale serve`. What stands in for auth is the
same-origin guard on every `/api/` route and on the WebSocket (browsers do not
apply CORS to WebSockets, so that check is made by hand), plus a strict CSP,
since the transcript reaches the page through `innerHTML`. Do not add a wildcard
CORS header, and keep path arguments from the client checked — `gitdiff.py`
refuses paths that escape the pane's directory.

## Gotchas

- **The JS tests slice `web/app.js` between literal anchor strings**, because it
  is one browser IIFE with no exports. Renaming or moving these lines breaks the
  suites even though the app still works: `const RE_RULE_GLYPH` →
  `function renderTranscript(text)` (transcript), `function statusLabel(file)` →
  `elBtnChanges.addEventListener` (diff), `const DRAFTS_KEY` →
  `/* Stamp anything whose sequence moved` (drafts). Check the anchors in
  `tools/test-*.js` after refactoring `app.js`. `test-flock.js` slices three
  times: `/* ---- The flock ---` → `// Opening a project is activity too`
  (the order), `function agentRowHtml(` → `async function createWorkspace() {`
  (a row's markup), and `const POSE = {` → `/* Everything a row draws.` (the
  sheep and their markings).
- **The gateway runs on Python 3.9.** The menubar app launches it with the
  python Xcode ships, so `str | None` outside `from __future__ import
  annotations` is a `TypeError` at import - and the only symptom is the menubar
  switch flicking straight back off, because the child died before it could
  bind. Check with the interpreter that actually runs it:
  `/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3 tools/test-gateway.py`.
- **Pane ids contain a colon** (`w1:p2`) which Mobile Safari percent-encodes;
  route handlers `unquote` path components before passing targets to Herdr.
- **iOS keyboard and layout**: height is driven from `visualViewport` rather
  than `dvh`, with `interactive-widget=resizes-content`. Don't "simplify" it
  back to CSS viewport units.
- **Naming.** Everything belonging to this repo is SheepIt — `SHEEPIT_*`,
  `~/.config/sheepit/`, `com.sheepit.*`. *Herdr* and *Tailscale* are named only
  where they are literally meant (Herdr's sockets and RPC, Tailscale's commands).
- **Commit messages** are lowercase prose with a type prefix, saying what the
  change does for the user rather than what was edited — e.g.
  `feat: keep a half-written prompt with the project it was written for`,
  `fix: read a Codex pane, not just Claude Code's`.
