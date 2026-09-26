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
| Transcript | the pane's *screen*, last 400 lines by default | `GET /api/agents/<pane>/history`, polled every 2s | `POST /api/queue`; keys via `agent.send_keys` | any agent, and plain shells |
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
  separate) and in `paneEmpty` in the app renderer.
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
  its pane above the composer (`#chat-queue-strip` in `index.html`, rendered
  by `app.js`), with Edit, Send now and Delete — the same three the transcript
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

### Phase 2 — one key vocabulary — **done**

- [x] One table, `KEY_VOCAB` in `app.js`, `name → {bytes}`: `#keys-bar`
  already sent a name straight to Herdr over `agent.send_keys` (`sendKey`),
  needing nothing more from the table than the name itself; `#console-keys`
  now looks up the same name's bytes (`sendConsoleKey`) instead of carrying an
  escape sequence in its own markup.
- [x] Found on the way: `#console-keys` was dead. Its buttons carried
  `data-seq=""` — the four characters backslash-u-0-0-1-b, never
  unescaped by anything — and no listener read `data-seq` at all, so the row
  had shipped unwired. It is now `data-key="esc"` etc., the same names
  `#keys-bar` uses, wired through `KEY_VOCAB`.
- [x] Kept the context-sensitivity — `renderNumberKeys` still sizes the
  keys-bar's palette to the prompt on screen; the console's row is still
  fixed, drawing arrows and ctrl+c whether or not anything is waiting on them,
  since a raw pty never tells you what it wants.
- [x] Covered by the existing suites: `node tools/test-transcript.js`,
  `test-diff.js`, `test-drafts.js`, `test-flock.js`, `test-queue.js`,
  `test-usage.js` all pass unchanged, and `node -c web/app.js` confirms the
  new code parses.

### Phase 3 — one composer

- [x] Start with the shared mechanics that do not depend on a view's send
  contract: textarea sizing, image shrinking and `imagesIn`, plus one
  attachment strip holding `{name, url}` entries. The chat renderer supplies
  `images[]`; the plain view folds the same strip's paths into `@path` tokens
  when it queues a prompt. Image-only prompts work in both.
- [x] Extract scoped draft persistence, recall history, queue-strip rendering
  and action delegation into `composer.js`. Each view still supplies its send
  callback and queue-row presentation, so pane prompts continue through the
  queue and chat messages continue through `/api/chat/send`.
- [x] Keep completion behavior view-specific for now: plain keeps `@` path
  completion and chat keeps its slash menu, as requested; neither completion
  was added to the other view.
- [x] The plain key palette opens from the composer's icon row, next to
  attach. Its panel is anchored above the composer, and the header toggle is
  gone. The palette remains plain-only because chat prompts have structured
  Allow/Deny controls.
- [x] Verify `tools/test-drafts.js` after the extraction; all draft tests pass.
  Completion coverage is deferred with the completion work.

### Phase 4 — fold the chat renderer in, drop the transcript's guess, retire the second page — **done**

- [x] Move the pane and headless chat renderer into `app.js` beside the
  verbatim transcript renderer. Both chat kinds use structured events in the
  main app document on phones and wide screens.
- [x] Unify the shared view header: it shows the project and tab title with a
  segmented Chat/Normal/Console switcher. Console fits on attach and when its
  viewport resizes; the touch shortcut row remains mobile-only. Changed Files
  stays in the shared header.
- [x] Removed transcript block classification, turn splitting, composer
  framing, status-bar hiding, and the `RE_RULE_GLYPH` machinery. The pane
  transcript is now always verbatim; status lines remain visible. The
  “Plain view” and “Show agent status bar” settings are gone. Row splitting,
  ANSI colors, live-input mirroring, mode detection and keypad sizing remain.
- [x] Replaced the per-agent glyph fixtures in `tools/test-transcript.js` with
  focused checks for verbatim rows, ANSI colors, live input, mode and keypad.
- [x] Delete `chat.html`, `chat.js` and `chat.css`; remove the iframe and
  `postMessage` protocol. The app shares viewport sizing, escaping and
  scroll-to-bottom helpers, and the CSP no longer permits framing.
- [x] Re-anchor the flock and queue suites and add `tools/test-chat.js` with
  prompt, assistant, tool, permission, result and blocked-pane event fixtures.

### Phase 5 — the view model

- [ ] `state.paneView` becomes a per-pane renderer choice, `chat | transcript`,
  replacing the wide-only chat/transcript toggle. The transcript renderer is
  verbatim; it is offered for every pane, and chat only where a log resolves.
- [ ] Source follows renderer: the log where there is one, the screen
  otherwise.
- [ ] Update `docs/design.md` to describe the in-page chat and view model.
- [x] Updated the `CLAUDE.md` architecture note to remove the iframe and
  two-page design.

### Phase 6 — once that is stable

- [ ] Ensure console scrolling works after the view rework. Wheel and touch
  scrolling currently do not move the console scrollback; verify both and fix
  the broken path.
- [ ] A composer over the console, in its "bytes" send mode. This is what
  actually delivers `@`-completion in the console, and it is a feature rather
  than a merge.
- [ ] Codex pane chat: a Codex `slim_log` and an approval mapping. Headless
  Codex stays out — there is no `--permission-prompt-tool` to talk to.

**The risk worth naming:** phase 1 edits `chat.js`, which phase 4 deletes. That
is deliberate. A few lines thrown away buy a phase 4 in which any behaviour
change is unambiguously a refactor bug.

## Follow-up

- [ ] After the consolidation work, check why changing the scrollback setting
  does not take effect. This was observed during the plan review and is out of
  scope for the current work.
