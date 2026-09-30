# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SheepIt: a phone client for [Herdr](https://herdr.dev), the terminal multiplexer
local coding agents run in. A Python gateway on the developer's machine talks to
Herdr's UNIX sockets and serves a home-screen web app to an iPhone over
Tailscale. `README.md` describes the features from the user's side; `docs/`
carries the detail (`gateway.md` — running and routes, `push.md` — iOS
notifications, `design.md` — the sheep, the parsing, the console,
`scheduler.md` — the prompt queue and the usage windows it waits for,
`views.md` — the console, the transcript and the chat, and the plan folding
them into one).

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
node tools/test-usage.js                        # the tokens page: buckets, stack, legend
python3 tools/test-gateway.py                   # bincode, framing, git, notifications, token logs

tools/sheepit-queue list | add | rm | quota     # the prompt queue from a terminal
tools/sheepit-queue wall --pane wM:p1           # what the wall would do, without doing it

make -C menubar all                             # build SheepIt.app (clang, no Xcode)
make -C menubar run | install | login | unlogin
python3 tools/make-bleat.py                     # regenerate web/bleat.wav
```

There is no runner, no lint and no formatter: each suite is a standalone script
that prints failures and exits non-zero, so "run one test" means run one of the
seven suites. Restart `server.py` after changing the gateway; changing `web/` only
needs a reload.

Getting finished work from a worktree onto the phone — suites, commit, PR,
merge, pull into the production checkout, restart the gateway — is the
`ship-sheepit` skill in `.claude/skills/`, which Claude Code picks up from the
repository itself.

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

**The flock is the page the app opens on**, and a chat is something you go into
from it (`showFlock` / `selectAgent(paneId, open)` in `app.js`). Past 900px the
same two screens sit side by side: `style.css` turns the flock into a fixed
left column and `closePicker` becomes a no-op, so nothing there can leave the
list off screen. A pane is still selected behind the flock — with `open` false,
so the transcript is warm without the screen jumping into it. **Nothing else
covers that column either**: past 900px every `.full-view` — the console, the
changed files, the tokens page and the settings — is offset by `--flock-width`
and fills the right-hand column, the same half a chat opens in. The two that
read one pane follow the selection (`retargetPaneViews`, and `closePaneViews`
for a headless chat, which has no pane for either of them to read); the tokens
page and the settings belong to no pane and are left alone. The console no
longer stops the poll, only takes the transcript out of `loop` — a frozen flock
beside a live console is the bug that trade made visible.

**The overview groups those rows by workspace** (`byWorkspace` in `app.js`): a
pen, so Close and Remove can be offered honestly — every action in that swipe
drawer acts on the workspace, and when a row was a tab, closing one stopped the
whole branch and took its neighbours with it. A pen with one tab is one row, led
by that tab, its sheep hashed from the workspace (`penSeed`) rather than the
pane. **A pen with more than one hangs them out** (`penHtml`): the worktree's
title on a line of its own, carrying the same Rename/Close/Remove, and a sheep
per tab indented under it on a bracket — each hashed from its own pane, the one
place `penSeed` is deliberately not used, since two animals under one title must
not read as one agent. A tab's own drawer is what the strip offers it, Rename
(`tab.rename`) and Close (`tab.close`), which is safe there because a pen only
draws this way while it has a second tab to keep the workspace alive.
**Every row carries its drawer's first two as hover icons** on a pointer — a
worktree's led by a `+` for a new tab in it — a pencil and a bin in the corner the `…` hint used to occupy (`rowToolsHtml`,
`.row-tools`, and the title's `.pen-head-tools`, all of it hidden wherever there
is no hover) — since a mouse cannot swipe. They sit above the status badge and
hide nothing: hovering a row must not take anything off it. A chat's is the bin
alone. The drawer itself is the swipe's and is hidden wherever there is a
pointer, so Remove — which deletes a checkout and stays out of the icons on
purpose — is a touch-only action, and a right-click over a row is the browser's
own menu again. The title still opens the tab that needs you most
(`urgency`: blocked, done, working, idle, shell), and still says `3 tabs`, which
is what makes Close read as stopping more than one thing. Every tab an opened
pen draws is in the list signature (`penTabsMark`), or a second tab finishing
would redraw nothing. The
strip above the transcript (`tabStripHtml`) is still where a tab is switched
without leaving the chat, and the only place another is opened (`tab.create`).
No `×` on the last tab: Herdr closes the workspace along with it, which is the
pen's own Close.

**The phone groups those rows by project, not by workspace** (`groupByProject`
in `app.js`): the key is `worktree.repo_root` as read by `project_of`, so the
scheduler's `sheep/` worktrees sit under the repository they were cut from. The
list is only redrawn when its signature changes — a blind redraw restarts every
sheep animation, drops a row held open by a swipe, and pulls the floor out from
under a project being dragged.

**Order is creation order, then a finger.** Rows sort by `bornAt` (workspace
`number` × 1000 + pane index — Herdr exposes no creation date anywhere, and
never renumbers); agent attention sorts rows inside each project but never
moves a project heading. A drag overrides creation order and is saved by the
gateway so desktop and mobile share it. New projects join at the end, including
those made through global `+ New`, and keep their displayed position until moved.
The drag also calls `workspace.move`,
but only when the project is a single workspace — a project is a repository and
Herdr reorders workspaces. `workspace.move` counts the workspace being moved
when it resolves `insert_index`, which is why `insertIndexFor` exists and is
tested exhaustively. `state_change_seq` orders nothing; it feeds the "3m" label.

**Folders sit in that order as `folder:<id>`** (`layoutGroups`, `dropInto` in
`app.js`; `/api/folders` on the gateway). What is filed in a folder is ordered
by the folder, not by `customOrder`, and `state.groups` is the flattened list
the layout draws — so everything that walks the projects still sees them all.
Folding a folder, project or pen is per device (`sheepit.collapsed`), and a
folded thing always draws its agents' status dots: folding must never hide a
question.

**Renames go through Herdr** (`workspace.rename`, `tab.rename`) rather than
being kept phone-side, so the desktop's workspace strip and tab bar change too.
A row is a worktree, so Rename is `workspace.rename` (`renameRow`); a single
tab is renamed by holding its chip in the strip (`renameTabByPane`). A tab's *displayed* number is
its `label`, not its `number` — see `tabNumber`.

**The queue waits for the window.** Prompts from the phone go to `/api/queue`
rather than straight to an agent: `gateway/scheduler/` holds them in SQLite and
`dispatch.py` sends them as soon as the pane can take one (or immediately, via
`/api/queue/{id}/send`). **One function queues them all** — `queue_prompt` in
`server.py`, which the route and `panechat.send` both call, the latter through
the hook `panechat.init` is handed at startup. A second call to `agent.prompt`
with somebody's prompt in it is a hole in the hold the size of whatever view
made it, which is exactly what the chat view was until `docs/views.md` phase 1. **Only a window that is actually out holds a prompt** —
100% or a lock that was earned, never `threshold` and never an unreadable
reading; a hold is forever, since nothing retries what the sweep declined to
send. `quota.py` reads usage per agent, since Claude and Codex
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

**The same reading is the grass.** A row's sheep stands in a field whose height
is what that *agent kind* has left (`pastureOf` in `app.js`, keyed on
`agent`, cut to the tightest live window), and a working one chews it at a
speed set from how fast the window is going down — `burnRate`, arithmetic on
one reading rather than a history, since the phone only asks for usage while
the overview is open. Both are bucketed before they reach the list signature: a
field that moved a third of a percent must not redraw the row and restart every
sheep mid-chew. `docs/design.md` is the detail.

**Where the windows went is its own page.** A percentage cannot say what last
week cost, so `gateway/tokens.py` reads the agents' own session logs -- Claude
Code's `~/.claude/projects/*.jsonl`, Codex's rollouts -- and `/api/usage`
answers with a row per hour, agent, model and project. **Nothing is recorded for
it**, which is what gives the page a month of history on the day it ships; what
it costs instead is three quirks of somebody else's format, each of which
silently doubles or halves a week if missed: Claude Code writes the same message
three times as it streams (deduplicated on request and message id), a log is
appended to between passes (cached per file against the offset it was read to,
and re-read whole if it ever got *shorter*), and Codex counts cached input
inside its input (taken back out). The page buckets those UTC hours into *local*
hours and days, draws the empty ones, and colours by model in name order rather
than by size -- rank changes with the range, and a legend that repaints when you
tap "24h" is one nobody can learn. `docs/design.md` is the detail.

**The machine is the other wall, and it is off by default.** *Show machine load*
in the settings view turns it on (`sheepit.machine` in `localStorage`,
`state.machineStrip`); while it is off the phone asks `/api/queue/quota` with
`machine=0` and `quota_payload` reads no counters, so hiding the strip and not
paying for it are one switch. Under the usage windows the strip draws the
host — cpu, ram, swap, disk, network and load average, two to a line, read by
`gateway/machine.py` (`/proc` on Linux, `sysctl`/`vm_stat`/`netstat` on macOS,
standard library like everything else) and carried on the same
`/api/queue/quota` poll rather than one of its own, because a machine with six
builds on it and a subscription that is nearly gone feel identical from the
phone. The three rates come from one pass of every counter against one previous
pass, so the span is the poll interval rather than a sleep. What it refuses to
do is the part to keep: used memory is what is not *available* and never what
is not free, time waiting on a disk is not busy, partitions and device-mapper
views are not counted on top of the drive they are part of, overlays like
`tailscale0` are not counted on top of the wire they ride on, and a rate of
nothing (`0`) is not a counter nobody keeps (`—`). `docs/design.md` is the
detail.

**A pane can be read as a chat too.** The main app draws one chat surface, and
two things produce its events: a headless `claude -p` per chat
(`gateway/chat.py`), and a Claude Code already running in a Herdr pane
(`gateway/panechat.py`, id `pane:<pane_id>`), whose session log -- the one
`agent_session` names -- has the same messages in it. `chat.get` resolves both,
so the `/api/chat/*` routes do not know which they are talking to. A pane's
permission prompt is not in its log: a tool call with no result while Herdr
says `blocked` stands in for it, and is answered with the keys the TUI numbers
its options with (`1` yes, `2` always, Esc no). Pane chats and headless chats
use the same in-page renderer in `app.js`; the shared app header stays in place
while the pane chooses chat or verbatim transcript (`state.paneView`).

**The headless chats are the flock's other tab.** The switch at the top of
the flock (`flock-tabs`, `setFlockTab`, kept per device as `sheepit.flocktab`)
shows the projects or the chats. The chats ride along on `/api/agents`
(`flock_chats` in `server.py`) and are ordered at `orderChats` in `app.js` into
`state.chatPens` -- never into `state.agents` or a project, since a chat has no
workspace, no tab strip and no pane id Herdr would answer for, and the badge,
the bleat and the selection all walk that list assuming one. The tab that is
off screen wears a red dot while something in it is blocked, so switching
tabs never hides a question; `+ New` in the chats tab skips straight to a chat. A chat's status is
the same vocabulary with no `done` in it, since nothing marks one as read; its
sheep wears a speech bubble; its drawer offers Delete and none of the three
things that belong to a worktree. `docs/design.md` is the detail.

**Two plusses, and both of them ask.** `+ New` at the top of the flock asks
chat, console or folder: a console is a bare workspace in the home directory, which is
how a new project starts, and a chat is a headless `claude -p` in the one
directory the settings name as the chat home (`chat-home.json` in the state
dir, `/api/chat/home`). The first chat ever asks for that directory with a
folder picker the gateway walks one level at a time (`/api/chat/dirs`, which
can also make one); `handle_new` accepts that directory or a project root the
flock has a pane in, nothing else. `+` on a project heading asks console or worktree: a console
is a new workspace of its own in the project's directory
(`createWorkspace(cwd)`), a worktree is a branch cut from the project's
checkout. A tab is not offered there, since a heading does not know which
worktree it would join: it is the `+` among a worktree's hover icons
(`penTools`), and the `+` in the tab strip, whose sheet offers it as well. One
element draws all of it (`renderNewSheet`). The project `+` starts no headless
chat: in a project, a chat is a way of *reading* a pane.

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
  `/* Stamp anything whose sequence moved` (drafts), `/* ---- Tokens over time --`
  → `/* The page itself:` (the tokens page, whose half above that anchor
  deliberately touches no DOM). Check the anchors in
  `tools/test-*.js` after refactoring `app.js`. `test-flock.js` slices four
  times: `/* ---- The flock ---` → `// Opening a project is activity too`
  (the order, and the collapse to one row per workspace),
  `function agentListSignature() {` → `async function createWorkspace(cwd) {`
  (a row's markup, which borrows `tabChipLabel` from the strip slice below it),
  `// In the order the laptop's tab bar has them` →
  `// Render Metadata (lives in the settings sheet)` (the tab strip), and
  `const POSE = {` → `/* Everything a row draws.` (the sheep and their
  markings).
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
- **The flock is the document; everything else is fixed over it.** Safari only
  folds its URL bar away when the *document* scrolled, so on a phone
  `.agent-picker` is the one thing in the flow (`.picker-head` sticky, carrying
  the safe-area inset) and `.app-container` and every `.full-view` are
  `position: fixed` out of it — otherwise the page is two screens tall and the
  end of the list runs into the chat. Past 900px it inverts: `body` is
  `overflow: hidden` and each column scrolls itself, because a window has no
  URL bar to fold and a document that scrolled would carry the flock off the
  top of it. Three things follow, and each is a bug if forgotten: a screen laid
  over the flock locks `body` (`:has(.full-view:not(.hidden))`) or you come
  back to the list somewhere you never left it; closing the flock empties the
  flow, so the scroll position is kept by hand (`keepFlockScroll`); the chat
  waiting behind the flock is `visibility: hidden` while it is open, since the
  rubber-band at the end of the list slides the flock up and leaves whatever is
  pinned behind it showing; and the
  drag-to-reorder arithmetic reads the list's box live rather than caching it
  (`pointInList`), since the list now slides under the finger.
- **`theme-color` is the colour at the screen's edges, not a brand colour.**
  Safari paints its status strip and its URL bar with it, so anything but what
  is actually under them reads as a shade laid over the page — which is what
  `syncThemeColor` moves between the flock's base colour and a chat's surface.
- **Naming.** Everything belonging to this repo is SheepIt — `SHEEPIT_*`,
  `~/.config/sheepit/`, `com.sheepit.*`. *Herdr* and *Tailscale* are named only
  where they are literally meant (Herdr's sockets and RPC, Tailscale's commands).
- **Commit messages** are lowercase prose with a type prefix, saying what the
  change does for the user rather than what was edited — e.g.
  `feat: keep a half-written prompt with the project it was written for`,
  `fix: read a Codex pane, not just Claude Code's`.
