---
name: ship-sheepit
description: Ship finished SheepIt (herdr-mobile) work all the way to the phone - commit the worktree branch, open a PR, merge it, pull into the production checkout and restart the gateway on 3009. Use when the user says ship it, merge it, land it, "create a PR and merge", or asks to get a branch onto the running server.
---

# Ship SheepIt

Takes work sitting in a `herdr-mobile` worktree and ends with the production
gateway on port 3009 serving it. Six steps, in order; none of them is
skippable, and step 4 is the one that is easy to get wrong.

## Before anything: the suites

There is no runner, so run them all. A red suite stops the ship.

```bash
for t in tools/test-*.js; do node "$t" >/dev/null || echo "FAIL $t"; done
python3 tools/test-gateway.py >/dev/null || echo "FAIL gateway"
```

If the gateway was touched, also check it against the interpreter the menubar
app actually launches (Python 3.9 — `str | None` is a `TypeError` there):
`/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3 tools/test-gateway.py`.
That path only exists on the Mac; skip it where it does not.

## 1. Commit

Conventional commit, lowercase prose, saying what the change does **for the
user** rather than what was edited. `feat:` and `fix:` are the only types
commitizen cuts a release from — `refactor:` lands silently.

**No Claude attribution, no co-author trailer, no generated-with line** —
neither in the commit nor in the PR body. That is a standing rule for this
repository.

## 2. PR

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<the commit subject>" --body "$(cat <<'EOF'
...
EOF
)"
```

Write the body the way the repository writes prose: what it does for the person
holding the phone, why the old behaviour was wrong, and a short testing note
naming the suites and anything checked in a browser.

## 3. Merge

Merging into `main` is deliberate and approved: asking to ship SheepIt *is* the
request to merge the PR and put it on the running gateway. Landing on `main` is
the whole point of the skill, not a side effect to stop and ask about.

```bash
gh pr merge <n> --merge --delete-branch=false
gh pr view <n> --json state -q .state    # MERGED
```

Keep the branch: the worktree is still checked out on it, and deleting the
remote branch out from under a live worktree is a mess for no gain. Worktrees
are removed through SheepIt itself.

## 4. Pull into the production checkout

The gateway is served from the checkout the keep-alive script runs from — never
a worktree (`/root/projects/herdr-mobile` on the host this was written for).
Nothing you merged reaches the phone until that checkout moves.

```bash
cd <production-checkout> && git status --short && git pull --ff-only && git log --oneline -1
```

Untracked local scratch under `.claude/` is meant to be there; leave it alone.

## 5. Restart the gateway

**Kill it and let the keep-alive bring it back. Do not start `server.py`
yourself.**

`~/.config/sheepit/keep-gateway-up.sh` is a restart loop that respawns the
gateway from the checkout five seconds after it exits, and it re-binds 3009 the
moment the port is free. Starting a second one by hand just loses the race and
leaves `Address already in use`. (`sheepit.service` is inactive; the script is
what actually keeps it up.)

```bash
ss -ltnp | grep 3009          # the pid to kill
kill <pid>
sleep 7
ss -ltnp | grep 3009          # a new pid, not the old one
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3009/
```

Then confirm it is serving the new code rather than a 200 from the old process
— grep the change out of what it actually serves, e.g.
`curl -s http://127.0.0.1:3009/style.css | grep -c "<something the branch added>"`.

Production is the tailnet's `https://<host>:8443` → 3009. Restarting drops open
console WebSockets; the phone reconnects on its own.

## 6. Tear down the dev version, if one is up

A branch served for the user to try (port 3049 behind
`tailscale serve --https=8444`) is stale the moment it is merged.

Stopping it is deliberate and approved: kill the dev server and turn the 8444
route off as part of every ship, without asking. Check first that the 3049
process runs from the worktree just merged (`readlink /proc/<pid>/cwd`); a dev
server for some *other* branch is still in use, so leave that one running.

```bash
ss -ltnp | grep 3049 && kill <pid>
tailscale serve --https=8444 off
```

## Report

Say what merged (PR number and URL), that the checkout moved, the new gateway
pid, and that 8443 is serving it. If a suite failed or the pull was not a
fast-forward, say so plainly and stop rather than forcing anything.
