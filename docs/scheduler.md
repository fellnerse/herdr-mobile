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

**Only a window that is out may hold anything.** Not `threshold`, which is a
colour on a bar, and not a reading nobody could take: not knowing is not the
same as knowing there is nothing left, and a hold is forever — nothing retries
a prompt the sweep declined to send. An agent that cannot be priced is
delivered to, and the wall catches it if that was optimistic.

Each agent is priced separately and holds only its own panes, since a Claude
window says nothing about what a Codex pane may spend.

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
- **Admission at the cap, and nowhere before it.** A prompt somebody typed is
  theirs to spend their own window on, down to the last percent: a queue that
  stops at 85% stops exactly when the phone is most wanted, and the 15% it was
  protecting is days of perfectly good weekly window. But "down to the last
  percent" has an end. A window with nothing left cannot take the prompt —
  handing it over spends it against a wall and loses the text in a refusal — so
  a pane whose agent is out waits for the window to reopen, and the chat says
  so above the composer. **Send now** goes anyway — it is a button under the
  prompt, not a sentence beside it.
- **The wall.** When a window runs out mid-turn, `esc` halts it and a resume
  prompt is queued *in front* of everything else for that chat. There is no
  separate pause state: a resume is just a prompt that jumps the queue. Current
  Claude Code does not simply stop: it opens `/rate-limit-options` and waits on
  "What do you want to do?", which is `blocked` — a chat nothing may write to,
  all night, over a question whose answer is always the same. So the menu is
  answered instead of escaped, and only ever with the option that says to wait;
  a menu without one is left for a person. The agent opens that menu by typing
  `/rate-limit-options` into its own composer, so answering is not the end of
  it: the composer is cleared afterwards, because a prompt is *appended* to
  whatever is already in there, and a resume that lands behind a slash command
  is submitted as an argument to it and swallowed — sent, by the queue's
  reckoning, and gone. Cleared only when the agent's own command is what is
  sitting there; a half-written sentence somebody left on the desktop is not
  this thread's to throw away.
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

### Checking it without running out

The wall is the one part of this that cannot be rehearsed by using the app: it
happens when a subscription runs out, at whatever hour that lands on, and when
it gets it wrong the evidence is a chat that sat still all night. So it is
asked instead of waited for:

```bash
tools/sheepit-queue wall --pane wM:p1        # a live chat, read-only
tools/sheepit-queue wall --screen wall.txt   # a screen captured earlier
tools/sheepit-queue wall --pane wM:p1 --send # press it, and watch the pane
```

It prints the same four answers `hit_the_wall` works from — does the text match,
is a menu on screen, which option would be pressed, what usage says — and then
the verdict. Without `--send` it touches nothing.

`/rate-limit-options` is a real slash command, so the menu can be put on screen
on purpose rather than waited for; Claude Code hides it and gates it on actually
being limited, so on a healthy account it may do nothing, and the `--screen`
path is the way to replay a menu you captured. The parse itself is pinned in
`tools/test-gateway.py` from a real screen, including the two menus that must
*not* be answered.

The rate-limit *menu* is the one thing that outranks usage. A banner can be
scrollback; a menu is the agent itself, stopped, saying it has run out. A cached
reading that has not caught up — or, on a machine with no Keychain, no reading
at all — must not be what leaves a chat sitting on that question until morning.

## The strip

One line per agent, one bar per window: `Claude 5h ▁▁ 10% 04:10 week ▃▃ 25%
21.9.` Both windows get a bar because they run out independently — a five-hour
window that is fine says nothing about a weekly one that is nearly gone.

It has to survive a 360px phone with two agents running, so everything that
could be inferred is gone: no "resets", no brackets, and a date rather than a
date and a time once the reset is more than eighteen hours out. Inside that,
a reset is a clock time — including the small hours of tomorrow, which is where
a five-hour window started in the evening lands.

## Where it is seen

In the chat it was typed into, above the box it was typed in. A queued prompt
is one line of text and three things you can do to it: **Edit**, which takes it
back into the composer where the keyboard already is, **Send now**, which hands
it over whatever the agent is in the middle of, and **Delete**.

It used to have a tab of its own, listing every chat's prompts. That put the
one thing you might want to take back two taps away from the place you would
notice it was still sitting there, and made a queue of one look like an
administrative system. The project list carries the same fact in a word — a row
with prompts behind it says `2 queued` beside what its agent is doing — and
that is the only place the queue is visible from outside its own chat.

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
| `POST /api/queue/{id}/send` | hand it over now, whatever the agent is doing |
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
