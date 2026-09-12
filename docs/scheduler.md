# The scheduler

Queue coding tasks and walk away. They run while the Claude subscription has
usage left, checkpoint when a window runs dry, and resume when the next one
opens.

It runs inside the gateway rather than beside it: `gateway/server.py` is already
a threaded daemon with a background watcher and persistent state, so a second
service would only add another thing to install and forget to start. The queue
lives on disk, so restarting the gateway costs at most the turn in flight.

## Where the numbers come from

Claude Code resolves its own limits through `GET /api/oauth/usage`. The
scheduler calls the same endpoint with the OAuth token already on disk. It costs
**no tokens**, and returns both a live utilization percentage and an exact reset
timestamp — so work is scheduled against real windows instead of being
discovered by crashing into them.

Every non-null bucket is checked, not just `five_hour`. Bucket sets differ by
plan, and `seven_day_opus` going unwatched is how a task silently strands.

The access token lives about six hours. If the queue idles overnight the poll
can fail, so the last good response is cached and reused. The scheduler
deliberately does **not** refresh the token itself: rewriting
`~/.claude/.credentials.json` races with Claude Code. A cached `resets_at` stays
valid across exactly the pause where it is needed.

## Pausing and resuming

- **Admission control.** New work only starts below `threshold` (default 85%).
- **Checkpoint.** If a window runs out mid-task, `esc` halts the turn and the
  task is marked `paused`. The agent keeps its pane and its conversation.
- **Resume.** After the reset the same agent is prompted to continue. If the
  pane did not survive a restart, the recorded Claude session UUID restarts it
  with `--resume` in the same worktree.

A pause is not an attempt. Counting it would let a task that merely spans three
windows exhaust `max_attempts` and be marked failed for behaving as designed.

## Isolation

Each task gets its own git worktree on a `sheep/` branch, so tasks never touch
your working tree and can run in parallel. Branches are left for review rather
than committed away.

## The folder-trust gate

A fresh worktree is a directory Claude Code has never seen, so it asks whether
you trust it before it will read, edit or execute there. That means **the first
run in each worktree stops and waits for you**: the task parks as `blocked` with
`waiting for you to trust the worktree folder`, pushes to your phone, and keeps
its pane alive so the dialog is still there to answer. Answer it and `retry`.

The scheduler does not click through this on your behalf. It is the gate that
decides whether an agent may execute in a directory, and a queue runner is not
entitled to answer it for you. If you want it gone, the honest options are to
trust the worktree root yourself once, or to accept the one-tap approval per
task.

## States

| State | Meaning |
|---|---|
| `queued` | waiting for quota or a free slot |
| `running` | agent is working |
| `paused` | window exhausted, resumable |
| `blocked` | agent asked something, needs a human |
| `done` / `failed` | terminal |

## Permissions

`agent_args` in `~/.config/sheepit/scheduler.json` is passed to Claude Code:

```jsonc
[]                                       // normal prompts; blocks a lot
["--permission-mode", "acceptEdits"]     // edits auto-approved, bash prompts
["--dangerously-skip-permissions"]       // full autonomy
```

Worktree isolation protects your working tree, not your machine — an agent
running without approvals can still execute arbitrary commands.

> **As root**, Claude Code refuses `--dangerously-skip-permissions` outright
> (`cannot be used with root/sudo privileges for security reasons`) and the task
> fails at startup. Use `acceptEdits`, or run the gateway as an unprivileged
> user.

## HTTP

| | |
|---|---|
| `GET /api/queue` | all tasks; `?state=` to filter |
| `GET /api/queue/quota` | usage windows, thresholds, next reset |
| `POST /api/queue` | `{prompt, repo, base?, branch?, priority?}` |
| `POST /api/queue/{id}/retry` | requeue, reset attempts |
| `POST /api/queue/{id}/delete` | drop it |

## Terminal

`tools/sheepit-queue` drives the same queue:

```bash
tools/sheepit-queue quota
tools/sheepit-queue add "Fix the flaky parser test" --repo ~/projects/foo --base main
tools/sheepit-queue list
tools/sheepit-queue retry 3
```

There is no `run` command on purpose — the dispatcher lives in the gateway, and
a second one would race it and run tasks twice.

## Configuration

`~/.config/sheepit/scheduler.json`, re-read every pass so edits apply without a
restart.

| Key | Default | |
|---|---|---|
| `threshold` | `85.0` | stop admitting work above this percentage |
| `poll_seconds` | `60` | idle re-check interval |
| `max_concurrent` | `1` | parallel tasks; they share one subscription |
| `task_timeout_ms` | `7200000` | give up waiting on one prompt |
| `max_attempts` | `2` | retries before parking as failed |
| `agent_args` | `[]` | passed to Claude Code |
| `branch_prefix` | `sheep/` | |
