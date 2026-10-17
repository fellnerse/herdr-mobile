# Leaving the Mac alone for a month

SheepIt is only as available as the Mac behind it. This page is two lists:
what now recovers by itself, and the settings on the machine that no code in
this repository can change for you. Do the second list once, then run the
rehearsal at the end before trusting it with a month.

## What recovers by itself

The menu bar app is the supervisor. While its switch is on, a watchdog runs
every 20 seconds, and launchd runs the app itself so that it too comes back.

| What goes wrong | What happens | How long |
|---|---|---|
| The gateway crashes or is killed | Restarted, backing off 5 → 60 s if it keeps dying | 5 s |
| The gateway hangs (alive, not answering) | `/api/health` fails three times, it is SIGKILLed and restarted | ~1 min |
| A worker thread inside the gateway dies (pushes or the queue silently stop) | `/api/health` answers 503, treated as a hang | ~1 min |
| Herdr is stopped or crashes | Started again (at most once a minute) | ≤ 20 s |
| Tailscale disconnects | `tailscale up` | ≤ 1 min |
| The `tailscale serve` route to `:3009` disappears | Re-applied on `:8443` | ≤ 1 min |
| `caffeinate` is killed | Started again | ≤ 20 s |
| The menu bar app crashes, or is killed (`kill -9`, `killall`) | launchd starts it again; it reclaims its own gateway | ~10 s |
| You Quit it and open it again from Finder or Spotlight | That copy hands over to the login agent, so it is supervised again | — |
| The log grows | Copied to `gateway.log.old` and emptied past 10 MiB | — |

Every one of these, and a reboot, sends a push to the phone once the gateway
is back ("Herdr restarted", "Gateway restarted", "Mac restarted", ...), so a
restart that cost you your agents is something you hear about rather than find.

**Agents are told not to do it in the first place.** `tools/sheepit-guard` is
a `PreToolUse` hook that refuses `herdr server stop`, `pkill -f python`,
`killall herdr`, `lsof -ti:3009 | xargs kill`, `tailscale down`,
`tailscale serve reset`, `launchctl bootout … sheepit`, `shutdown`, `pmset
sleepnow`, deleting `~/.config/herdr` or `~/.config/sheepit`, and killing any
of those processes by pid, including the API proxy on `:8787` that every
Claude Code session talks through. It is a seatbelt against an agent tidying
up, not a sandbox: an agent that wants to can get past it.
`tools/sheepit-guard check '<command>'` says what it would do.

What nothing can bring back: **a reboot or a Herdr restart ends every agent
session that was running in it.** The queue survives (it is in SQLite), the
agents do not.

## What you have to do

### 1. Install this build and its login agent

```bash
make -C menubar login
```

This replaces the old login agent, which only ran `open -a SheepIt` once, with
one that runs the app and starts it again whenever it dies. **Quit** in the
menu still quits it for good; anything else that stops it is undone in
about ten seconds. Opening it again by hand after a Quit gives the job back to
launchd rather than running a copy nothing would restart.

If `~/Library/LaunchAgents/com.sheepit.gateway.plist` exists, remove it. Two
supervisors fighting over port 3009 is worse than one:

```bash
launchctl bootout gui/$(id -u)/com.sheepit.gateway
rm ~/Library/LaunchAgents/com.sheepit.gateway.plist
```

### 2. Wire in the guard, for Claude Code and for Codex

Both read the same hook shape. Add one entry to the `PreToolUse` list that is
already in each file (yours has headroom's there; keep it):

`~/.claude/settings.json`, under `"hooks"` → `"PreToolUse"`:

```json
{"matcher": "Bash", "hooks": [{"type": "command",
  "command": "/Users/Mo/repos/herdr-mobile/tools/sheepit-guard", "timeout": 10}]}
```

`~/.codex/hooks.json`, the same entry under `"hooks"` → `"PreToolUse"`.

Point it at the production checkout, not a worktree that may be deleted. A
hook path that no longer exists fails open, which is the right failure but
means the guard is silently gone. Check that it is in place:

```bash
echo '{"tool_input":{"command":"herdr server stop"}}' | tools/sheepit-guard; echo $?   # 2
```

Codex also reads prefix rules from `~/.codex/rules/default.rules`. They can
back the hook up for the one command that matters most:

```
prefix_rule(pattern=["herdr", "server", "stop"], decision="forbidden")
prefix_rule(pattern=["tailscale", "down"], decision="forbidden")
```

### 3. Tailscale

- **Disable key expiry for this Mac.** In the admin console, under Machines, open
  this Mac's `…` menu and pick *Disable key expiry*. Otherwise the node drops
  off the tailnet when its key expires (180 days by default, and possibly in
  the middle of your month), and nothing on the machine can renew it without
  you logging in.
- **Turn off automatic updates for the month**
  (`tailscale set --auto-update=false`, or *Settings → Automatically update* in
  the app). An update restarts the network extension, and occasionally asks
  for approval in a dialog nobody is there to click.
- **Launch at login** must be on in the Tailscale app's settings.
- `tailscale serve status` should show `https://<mac>.<tailnet>.ts.net:8443`
  proxying to `http://127.0.0.1:3009`. The watchdog re-applies that route on
  `:8443` if it disappears. If you serve on another port, tell it:
  `defaults write dev.sheepit.menubar tailscaleServePort 8443`, or `off` to
  manage serve yourself.

### 4. Power and sleep

`caffeinate` prevents idle sleep, but not everything:

```bash
# On the charger: never sleep, never drop into standby or Power Nap, and
# keep the network up.
sudo pmset -c sleep 0 standby 0 powernap 0 tcpkeepalive 1 womp 1

# Boot again after a power cut (desktops; laptops boot on the battery anyway).
sudo pmset -a autorestart 1
```

- **Keep the lid open**, or use an external display, keyboard and power
  (clamshell mode). A closed lid with nothing attached sleeps the MacBook
  whatever `caffeinate` says. `sudo pmset -a disablesleep 1` stops even that,
  but it also stops the lid from putting the machine to sleep when it is in a
  bag. Undo it afterwards with `disablesleep 0`.
- **Keep it plugged in.** On battery, `caffeinate -i` still holds, but the
  battery runs out. macOS holds the charge at 80% on a Mac that is always
  plugged in, which is what you want for a month.
- Somewhere with air: a closed-lid MacBook under load gets warm.

### 5. Reboots, FileVault, and updates

This is the one that decides whether an unattended month survives a power cut.

**FileVault is on on this Mac.** After any restart it waits at the disk-unlock
screen for your password. Until then nothing runs: no login session, so no
SheepIt, Herdr or Tailscale, and the phone sees nothing until somebody types
the password at the Mac. Your options:

- **Planned restarts:** `sudo fdesetup authrestart` reboots and unlocks the
  disk once, so the machine comes back to the login session by itself if
  automatic login is set up. Use this, never a plain restart.
- **Unplanned restarts (a power cut, a kernel panic):** there is no way around
  the unlock screen with FileVault on. Recovering from these unattended means
  turning FileVault off and turning on automatic login
  (*System Settings → Users & Groups → Automatically log in as*). That is a
  real security trade-off for a laptop, and the decision is yours. Without it,
  accept that a power cut means the gateway is down until you get back.

**Software updates.** As set up now, macOS downloads updates automatically and
installs security responses and system files automatically. macOS updates are
not installed automatically. For the month:

- In *System Settings → General → Software Update → Automatic updates*, keep
  *Install macOS updates* **off** and turn *Install Security Responses and
  system files* **off** too. Some of those restart the Mac.
- Check that nothing else restarts it or swaps binaries under running agents:
  Homebrew's `autoupdate`, a scheduled `darwin-rebuild switch` (Herdr comes from
  `/run/current-system`), MDM policies.

### 6. A way in when SheepIt itself is down

Everything above recovers what it can; this is for when it cannot. Turn on
*System Settings → General → Sharing → Remote Login* (SSH) and, optionally,
*Screen Sharing*. Both are reachable over the tailnet from the phone (an SSH
app, or the Screen Sharing URL `vnc://<mac>.<tailnet>.ts.net`). The standalone
Tailscale on macOS cannot be a Tailscale SSH server, so this is the macOS
one. Use a key, not a password:
`ssh-copy-id`, then set `PasswordAuthentication no` in
`/etc/ssh/sshd_config.d/`.

### 7. Disk

A month of agents writes session logs (`~/.claude/projects`, `~/.codex`),
worktrees, `node_modules` and build output. The machine strip in SheepIt's
settings (*Show machine load*) shows the disk on the phone. Start the month
with plenty of space free; `df -h /` and
`du -sh ~/.claude/projects ~/.codex/sessions` say where it goes.

### 8. Rehearse it

Do each of these with the phone on cellular (Wi-Fi off) and watch it recover.
Allow the time from the table above. Afterwards,
`~/Library/Logs/SheepIt/gateway.log` should show each recovery and the phone
should have had a push for it.

| Do | Expect |
|---|---|
| `kill -9 $(lsof -nP -iTCP:3009 -sTCP:LISTEN -t)` | Back in ~5 s, "Gateway restarted" |
| `kill -STOP $(lsof -nP -iTCP:3009 -sTCP:LISTEN -t)` | Killed and back in ~1 min |
| `herdr server stop` (from your own terminal; agents are blocked) | Herdr back in ≤ 20 s, "Herdr restarted" |
| `killall -9 SheepIt` | Back in ~10 s, "SheepIt restarted" |
| `tailscale serve --https=8443 off` | Route back within a minute |
| `tailscale down` | Back within a minute, "Tailscale reconnected" |
| `sudo fdesetup authrestart` | Phone works again with no input at the Mac, "Mac restarted" |
| Pull the power cable for an hour | Still on battery, still reachable |

## Where to look

```bash
tail -n 100 ~/Library/Logs/SheepIt/gateway.log           # every restart and why
curl -s localhost:3009/api/health                         # gateway, its threads, Herdr
launchctl print gui/$(id -u)/com.sheepit.menubar | grep -E 'state|runs|last exit'
tailscale serve status
pmset -g assertions | grep -i caffeinate                   # what is holding it awake
```
