# The three views, and folding them into one

A pane can be read three ways: as its **console** (the terminal itself), as a
**transcript** (its last hundred lines, classified by glyph), and as a **chat**
(its session log, folded into messages). The last two arrived from different
directions and share nothing — not the page, not the poll, not the composer,
not even the HTML escaper — which is the duplication this document is about.

This is the plan for collapsing them, and the record of how far it has got.
Phases are checked off as they land.

## What the three actually are

| | source | transport | write path | works for |
|---|---|---|---|---|
| Console | the pane's pty | `herdr-client.sock` bincode → WebSocket, pushed | raw bytes to the pty | anything |
| Transcript | the pane's *screen*, last 100 lines | `GET /api/agents/<pane>/history`, polled every 2s | `POST /api/queue`; keys via `agent.send_keys` | any agent, and plain shells |
| Chat | Claude Code's session JSONL | `GET /api/chat/events`, long-polled by index | `POST /api/chat/send` → `POST /api/queue` (phase 1) | Claude Code panes only |

This table is what exists today. The transcript row is going away in phase 4,
not into `app.js` alongside the other two — see the decision below.

**Different truth is the whole split.** The transcript reads what is *drawn*;
the chat reads what was *written down*. So the transcript sees everything the
TUI paints and nothing else — the composer box, the line somebody is typing on
the desktop, the mode in the status bar, permission prompts, trust dialogs —
but only a hundred lines of it, and the structure is a guess. The chat sees the
whole session as typed objects, with markdown, folding tool cards and cost, and
no guessing; but the permission prompt is *not in the log*, so `_raise_ask`
infers it from a tool call with no result while Herdr says `blocked`, and
anything it cannot infer degrades to "waiting on something in the terminal".

**Decision: the transcript's guess is being dropped, not merged in.**
Classifying the screen into turns — which glyph starts one, which rules frame
the composer, which trailing lines are the status bar — is the part that
breaks every time an agent changes how it draws, and it is also the part
`tools/test-transcript.js` exists to catch: a fixture per agent, forever, for a
view whose whole value proposition (fidelity) it undermines by construction.
The plan below no longer merges transcript's classified rendering into
`app.js` as a third mode. It goes to two: **chat**, unchanged, and **plain**,
which absorbs everything transcript did *except* the classification —
`parseTranscript`'s row split, the live-input mirror and the number keypad are
read straight off the last rows regardless of whether the guess runs on top of
them, so plain keeps all three. What plain does not get is turn splitting,
composer framing or status-bar hiding: the last hundred lines, verbatim, is now
the only way to read a screen from the phone. That is a deliberate loss of
convenience for panes with no session log (Codex today, any plain shell
always) in exchange for a view that cannot go stale when an agent's TUI
changes. `tools/test-transcript.js`'s per-agent glyph fixtures go with the
classification; whatever still needs covering after phase 4 (row split, mode,
keypad) is covered where `test-drafts.js` or a slice of `test-flock.js`
already exercises it, not by a revived version of that suite.

**Two things are called a chat**, and the shared `/api/chat/*` routes hide it:

- A **pane chat** (`gateway/panechat.py`) is the same agent, unchanged: same
  process, same TUI, same pane. Nothing is stored for it — Claude Code writes
  that JSONL for itself so `--resume` works, and the gateway tails it. Writes
  go back through the queue and `agent.send_keys`, exactly as the transcript's
  do. It is purely a second reading.
- A **headless chat** (`gateway/chat.py`) is a different setup on the agent
  side: the gateway spawns its own `claude -p` with stream-json both ways and
  `--permission-prompt-tool stdio`. No pane, no TUI, no Herdr. Its permission
  prompts arrive over a real protocol rather than being inferred, which is why
  its Allow/Deny is trustworthy where a pane chat's is a best guess.

**Why Claude only.** For a pane chat this is mostly unwritten code: Codex keeps
rollouts under `~/.codex/sessions/`, which `tokens._scan_codex` already globs
and parses for the token page. What is missing is a Codex `slim_log` and an
approval mapping, since `panechat.answer` hardcodes Claude Code's TUI numbering
(`1` allow, `2` always, Esc deny). For a headless chat it is a real gap:
`codex exec --json` has no host-side permission callback, so a headless Codex
could not ask before a tool at all.

## The state this found Herdr in

`agent_session` is absent from this Herdr's RPC output — not in `pane.get`, not
in `agent.list`, on any pane. `panechat.refresh` reads the session id from
there, so it never resolves one, `summary()` reports `claude: false`, and every
Claude pane opened as a chat says "There is no Claude Code in this pane."
**Pane chat is unreachable until that is fixed**, which is why it is phase 0
and not an afterthought: everything below would otherwise be refactoring a code
path nobody can exercise.

The fix needed nothing from Herdr, and is phase 0 below: the pane's
`foreground_cwd` finds the project directory, and the pane's title picks between
the sessions in it.

## The order, and why it is this order

Make the thing observable; then fix behaviour while the two pages are still
separate, so a regression has an obvious owner; then do the pure extractions;
and only merge the views once nothing about their behaviour still differs.

### Phase 0 — make pane chat reachable — **done**

- [x] Resolve the session without `agent_session`. `panechat._resolve` keeps
  Herdr's answer first and falls back to `tokens.session_logs(cwd)`, which finds
  the project directory by turning everything in the path that is not a letter
  or a digit into a dash. The session id is the log's own filename.
- [x] Tiebreak two panes in one repo. Claude Code writes an `ai-title` line
  carrying exactly the string Herdr reports as the pane's title, and **rewrites
  it on every turn** — so a 128KB tail identifies a log however long the session
  has run, and `log_title` caches that against the file's size.
- [x] Hold the answer. The pick stands until the pane's title changes or a
  *working* pane's log has been silent for 20s, which is what a `/clear` into a
  fresh session looks like from here. Steady state costs one directory scan.
- [x] Refuse the tie it cannot win. A pane with no title yet, in a repository
  with several sessions, resolves to **nothing** rather than to the newest log:
  somebody else's conversation drawn as yours is worse than an empty screen, and
  the title arrives within a turn or two. A directory with one log has no tie.
- [x] Split the error string three ways — no Claude Code, no log found yet,
  nothing in the session — in `summary()` (`claude` and `session` are now
  separate) and in `paneEmpty` in `chat.js`.
- [x] Covered in `tools/test-gateway.py`: the slug, the tail read with a quoted
  title, the title picking between two logs in one cwd, a retitle switching
  sessions, the refused tie, and the single-log case. Passes under 3.9.

**Verified live:** all three Claude panes on this machine resolve, each to a
different log, and the shells resolve to nothing. The pane running this session
resolved to the log holding this conversation.

Two things found on the way, both outside this phase:

- `tools/test-gateway.py` aborted the whole suite on any machine without an OMP
  install — `current('antigravity')` reached the real source for what is only an
  alias test. The source is stubbed there now.
- Five failures predate all of this and are unchanged by it (three git ones, and
  two where a macOS temporary directory compares `/var` against `/private/var`).
  Confirmed identical at `HEAD`.

### Phase 1 — one send path — **done**

- [x] There is now one function that queues a prompt, `queue_prompt` in
  `server.py`, and `POST /api/queue` is a two-line caller of it. A pane chat's
  send is the other caller: `panechat.init` is handed it at startup and
  `panechat.send` goes through it instead of calling `agent.prompt` itself.
  Nothing else may reach `agent.prompt` with somebody's prompt in it — that is
  the door a spent window gets written through.
- [x] A `blocked` pane is no longer refused. `panechat.send` used to raise "it is
  waiting on a question", losing what had been typed; the dispatcher's `READY`
  is `("idle", "done")`, so the queue simply holds the text until the question
  is answered and delivers it then.
- [x] The strip came with it. A pane chat draws what the queue is holding for
  its pane above the composer (`#queue-strip` in `chat.html`, `drawQueue` in
  `chat.js`), with Edit, Send now and Delete — the same three the transcript
  offers, against the same routes. It polls only while something is outstanding,
  so an idle chat costs no requests, and a freshly sent prompt is held back for
  1.5s exactly as the transcript's is: the ordinary case delivers inside that
  and never draws a chip that is taken away again.
- [x] A shell is still the exception `queue_prompt` makes, unchanged: a pane
  with no agent in it gets the text typed into the terminal and a return,
  because nothing would ever deliver a queue row into it.
- [x] `/api/chat/answer` was left alone. Answering a permission prompt is keys,
  it is immediate, and it must never queue — a held "yes" is a pane sitting on a
  question with the answer in a database.
- [x] Covered in `tools/test-gateway.py`: `queue_prompt` on its own (refusals,
  what is recorded with a row, the shell path, and that nothing reaches the pane
  behind the queue's back), and `panechat.send` queueing rather than prompting,
  holding for a blocked pane, and surfacing the queue's own refusal.

One visible difference remains, and it is the honest one: a headless chat's
message still goes straight to its own `claude -p`, because the queue addresses
panes and a headless chat has none. It spends the same subscription, so a window
that is out is not held against it. Making the queue able to hold for a chat id
is its own piece of work, and it is not a view problem.

### Phase 2 — one key vocabulary

- [ ] One table, `name → {bytes, rpcName, label}`: the keys bar sends named
  keys over `agent.send_keys` and the console's row sends raw bytes over the
  WebSocket, which is the same vocabulary written twice.
- [ ] Keep the context-sensitivity — the palette is sized to the prompt on
  screen by `renderNumberKeys`, while the console's row is fixed.

### Phase 3 — one composer

- [ ] Extract the composer — textarea, autoresize, attach, `@`-completion,
  recall, drafts, queue strip — with a pluggable send.
- [ ] Bring the slash/skill menu with it, so a Codex pane gets it too.
- [ ] Keep `tools/test-drafts.js` passing, and cover completion and drafts
  under the extracted component.

### Phase 4 — fold the chat renderer in, drop the transcript's guess, retire the second page

- [ ] Move `build()`, `markdown()`, `itemHtml()` and `askHtml()` into `app.js`
  as a second render mode beside `plainHtml`.
- [ ] Delete `renderTranscript`'s block classification — rule detection,
  composer framing, status-bar hiding, turn splitting — and the `RE_RULE_GLYPH`
  machinery under it. Keep `parseTranscript`'s row split and the three things
  read straight off it regardless of classification: `renderLiveInput`,
  `renderNumberKeys`, `state.mode`. `plainHtml` becomes the only way to draw a
  screen; there is no classified mode left for it to be an escape hatch from.
- [ ] Delete `tools/test-transcript.js`'s per-agent glyph fixtures with it.
  Whatever of `parseTranscript` still needs covering (row split, live input,
  mode, keypad) moves to wherever exercises the surviving code path, not a
  revived version of that suite.
- [ ] Delete `chat.html`, `chat.js`, `chat.css`, `renderPaneChat`, the
  `postMessage` protocol, the second `visualViewport` handler, the second
  escaper and the second scroll-to-bottom; drop `frame-ancestors 'self'` from
  the CSP if nothing else wants it.
- [ ] Re-anchor the sliced suites and add `tools/test-chat.js` with real event
  fixtures — what `test-transcript.js` used to be for pane glyphs.

### Phase 5 — the view model

- [ ] `state.paneView` becomes a per-pane renderer choice, `chat | plain`,
  replacing the wide-only chat/transcript toggle and the plain-view checkbox
  in the settings sheet — there is no third option once the transcript's guess
  is gone. Chat is offered only where a log resolves; plain is what every
  other pane gets, and what a chat-eligible pane falls back to on request.
- [ ] Source follows renderer: the log where there is one, the screen
  otherwise.
- [ ] Update `docs/design.md` and the architecture notes in `CLAUDE.md`, which
  describe the iframe and the two-page split as current design.

### Phase 6 — once that is stable

- [ ] A composer over the console, in its "bytes" send mode. This is what
  actually delivers `@`-completion in the console, and it is a feature rather
  than a merge.
- [ ] Codex pane chat: a Codex `slim_log` and an approval mapping. Headless
  Codex stays out — there is no `--permission-prompt-tool` to talk to.

**The risk worth naming:** phase 1 edits `chat.js`, which phase 4 deletes. That
is deliberate. A few lines thrown away buy a phase 4 in which any behaviour
change is unambiguously a refactor bug.
