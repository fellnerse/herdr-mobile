# The queue

Queue prompts for a chat you already have open. They are delivered while the
Claude subscription has usage left, halt when a window runs dry, and pick up
where they left off when the next one opens.

Everything you send from the phone goes through it — there is no separate "send
now" path. Into a free chat with usage left a prompt lands within the second;
into a busy one it waits. You do not have to know which of those you were in
when you typed it.

A pane with **no agent in it is not queued for at all** — it is a shell, and the
text is typed into it followed by enter. Queueing there would wait on an agent
that nothing is ever going to start. It is also how you open a session from the
phone: send `claude` to an empty window, and the queue delivers into it from
then on.

It runs inside the gateway rather than beside it: `gateway/server.py` is already
a threaded daemon with a background watcher and persistent state, so a second
service would only add another thing to install and forget to start. The queue
lives on disk, so restarting the gateway costs nothing that was still waiting.

## Nothing is provisioned

The queue delivers into a session that already exists. It does not create
worktrees, cut branches, or launch agents, which means there is no fresh
directory for Claude Code to ask about — **the folder-trust dialog never
appears**, because you already cleared it when you opened that chat yourself.

The trade is real and worth stating: a prompt delivered at 4am runs in the
working tree that pane is sitting in, on whatever branch, on top of whatever is
uncommitted, with the permission mode that session was started with. If you want
isolation, open the chat in a worktree — that decision belongs to the window,
not to the queue.

## Where the numbers come from

Each agent spends its own subscription, so each is asked separately and holds
only its own panes. A Claude window says nothing about what a Codex pane may
spend.

**Claude Code** resolves its own limits through `GET /api/oauth/usage`. The
queue calls the same endpoint with the OAuth token already on disk — or, on a
Mac, in the login Keychain, where Claude Code keeps it instead of in
`~/.claude/.credentials.json`. It costs **no tokens**, and returns both a live
utilization percentage and an exact reset timestamp, so delivery is scheduled
against real windows instead of being discovered by crashing into them.

Every non-null bucket is checked, not just `five_hour`. Bucket sets differ by
plan, and `seven_day_opus` going unwatched is how a prompt silently strands.

The access token lives about six hours. If the queue idles overnight the poll
can fail, so the last good response is cached and reused. It deliberately does
**not** refresh the token itself: rewriting the credentials races with Claude
Code. A cached `resets_at` stays valid across exactly the pause where it is
needed.

**Both agents also write their usage down**, and that costs nothing at all to
read: Claude Code caches its last reading in `.claude.json`, stamped with the
account it belongs to, and Codex records the rate limits of every turn in its
session rollout — a five-hour window and a seven-day one, the same shape under
different names. Claude falls back to its own note when the endpoint cannot be
reached.

**Codex is read off its own screen as well**, because the rollout is only
written when the model answers. A window that resets while nobody is working
still reads as full on disk — a pane finished a turn at 98%, the window
reopened two hours later, and the file still said 98% that evening. What
`/status` prints was fetched when somebody asked for it, so the gateway reads
the panes, parses the box when it is on screen, and takes whichever reading is
newer. Note that the box states what is **left**, not what is spent: "6% left"
is 94% gone.

If nothing has been read for fifteen minutes, one idle Codex pane is asked —
`/status`, typed in as a prompt. Two conditions, both necessary: the pane is
`idle`, and **its composer is empty**. A half-written prompt on screen would be
submitted along with the command, which is somebody's unfinished sentence sent
to their own agent; that pane is skipped and the older reading stands.

**A reading expires with the window it describes.** A note saying 98% was true
until that window reset; after the reset it is not stale but wrong, and a Codex
pane that finished a turn shortly before its window reopened would otherwise
read as full all afternoon. A bucket whose `resets_at` has passed blocks
nothing, and the phone draws it with no percentage at all rather than an old
one.

**Usage does not gate delivery at all**, so not knowing what is left costs
nothing: a prompt goes as soon as the pane can take it. A window therefore
matters in exactly two places — the strip, where it is information, and the
wall, where a banner is confirmed against it.

"Spent" in that second place means the cap itself — 100%, or a window the
provider locked after it was used. Not `threshold`, which is only where the bar
turns amber (80%).
And not a slot the plan never included, which is locked from the day it was
born and says nothing about what anybody spent.

When a spent window does not say when it reopens, that is `None`, and the
caller applies its own backoff. It used to answer "fifteen minutes from now",
a time that moved every time it was asked — the phone read 22:40, then 22:41 a
minute later, for a window that was not out at all.

## Delivery

- **One at a time per chat.** Claude Code would happily queue all of them
  itself, but then everything behind the first prompt runs against whatever the
  subscription looks like by the time it gets there — which is the entire thing
  this queue exists to decide.
- **No admission control.** A prompt somebody typed is theirs to spend their own
  window on, down to the last percent, so nothing in delivery consults usage.
  A queue that stops at 85% stops exactly when the phone is most wanted, and
  the 15% it was protecting is days of perfectly good weekly window.
- **The wall.** When a window runs out mid-turn, `esc` halts it and a resume
  prompt is queued *in front* of everything else for that chat. There is no
  separate pause state: a resume is just a prompt that jumps the queue.
- **Blocked.** A chat sitting on a question is never written to — text sent now
  would answer it. It notifies instead, once, and the queue holds.
- **No agent.** Typed into the pane as keystrokes rather than held. A chat whose
  agent quit with a `session_uuid` recorded is resumed instead; one without is
  just a shell.

## How it knows

Herdr does the watching, over one subscription on its UNIX socket:

| Event | What it tells us |
|---|---|
| `pane.agent_status_changed` | the chat just freed up |
| `pane.output_matched` | the usage-limit banner appeared |
| `pane.closed` | the chat is gone; try to bring it back |

`pane.output_matched` matters most. The banner used to be found by reading the
last 60 visible lines at poll time, which missed any that had already scrolled
past and misread the turn as a failure. Herdr now matches `LIMIT_PATTERN`
server-side and continuously.

Events are a latency optimisation, never a source of truth: every wake-up
re-reads state, and a stream that drops silently costs responsiveness and
nothing else. A sweep runs every `poll_seconds` regardless. Queueing a prompt is
invisible to Herdr, so the HTTP side nudges the dispatcher directly rather than
letting a message typed into an idle chat wait out a poll.

The wall is the one exception, because the subscription is the only thing
watching for it — everything else is re-read anyway. So with no stream to hear
it from, the dispatcher reads each waiting pane itself and looks for the banner.
**That hit is routed through the same `hit_the_wall` a subscribed match is**, and
for the same reason: the banner says go and ask, usage says yes or no. Acting on
matched text directly parks a healthy chat that merely mentioned running out of
usage — which is a thing agents say to each other constantly.

## Visibility

Automatic is not the same as invisible.

- **In Herdr**, the depth is a token on the pane itself
  (`pane.report_metadata`, `queued=3`), so waiting work is visible from the
  desktop without the phone.
- **On the phone**, the queue view and the header badge count what is still
  owed. Delivered prompts belong to the conversation and stop being counted.
- **A push** fires when a window is exhausted, when a queue empties, and when a
  chat blocks with prompts stacked behind it. That last one is the case the
  queue cannot get itself out of, so it comes and finds you.

## Recovery

Herdr sessions are server-side and detached, so closing the app or dropping the
phone connection costs nothing — the pane is still there. A reboot is what
recovery is for: the pane is gone, but `session_uuid` still names the
conversation, and `claude --resume` walks back into it with its history intact.

Where it comes back depends on what survived: a new tab in its old workspace if
that still exists, otherwise a new workspace at the recorded `cwd`. Closing the
last pane in a workspace takes the workspace with it, so after a reboot the
second path is the usual one.

A chat that cannot be resumed — no session was ever recorded — has its prompts
marked `failed` rather than deleted. What you typed should still be there to
read and re-queue.

## States

| State | Meaning |
|---|---|
| `waiting` | holding for quota, or for the chat to finish |
| `sent` | handed over; the conversation owns it now |
| `failed` | could not be delivered, with `last_error` saying why |

`sent` rows are pruned 24h after delivery and are not shown on the phone at all
— the queue is what is still owed, not a log of everything ever sent, and the
transcript is the real record. `failed` rows are never pruned: those are the
ones still waiting on you, and they stay until you delete them.

## Permissions

A queued prompt inherits the permission mode of the session it lands in. This
queue never widens it.

`agent_args` in `~/.config/sheepit/scheduler.json` is used only on the cold
path, when a lost session has to be relaunched — set it to match how you start
your sessions so one that comes back after a reboot comes back the way you left
it.

## HTTP

| | |
|---|---|
| `GET /api/queue` | queued prompts; `?pane_id=` or `?state=` to filter |
| `GET /api/queue/quota` | usage windows per agent: what each has spent, when it resets, and whether it is out |
| `POST /api/queue` | `{prompt, pane_id}` — the only send path; answers `delivered: "terminal"` when the pane had no agent and the text was typed instead |
| `POST /api/queue/{id}/update` | `{prompt}`, while it is still waiting |
| `POST /api/queue/{id}/delete` | drop it |

## Terminal

`tools/sheepit-queue` drives the same queue:

```bash
tools/sheepit-queue quota
tools/sheepit-queue chats
tools/sheepit-queue add "Fix the flaky parser test" --pane wM:p1
tools/sheepit-queue list
tools/sheepit-queue rm 3
```

There is no `run` command on purpose — the dispatcher lives in the gateway, and
a second one would race it and deliver every prompt twice.

## Configuration

`~/.config/sheepit/scheduler.json`, re-read every pass so edits apply without a
restart.

| Key | Default | |
|---|---|---|
| `threshold` | `80.0` | where a usage window turns amber — a warning, not a gate. Red is the cap itself, which is not a setting |
| `poll_seconds` | `60` | worst-case sweep interval if the event stream drops |
| `agent_kind` | `claude` | |
| `agent_args` | `[]` | passed to a relaunched session on the cold path |
