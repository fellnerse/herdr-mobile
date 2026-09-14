<div align="center">

<img src="web/icon.svg" alt="" width="112" height="112">

# SheepIt

**Manage your local agent herd remotely on your phone.**

</div>

Your coding agents run on the machine under your desk. SheepIt puts them in
your pocket: read what an agent is doing, answer the question it is stuck on,
and start the next one — from the sofa, the kitchen, or the bus.

It is a small web app you add to your iPhone home screen, plus a
standard-library Python gateway that talks to [Herdr](https://herdr.dev), the
terminal multiplexer your agents are running in. No accounts, no cloud, no
dependencies: the phone reaches your own machine over your own
[Tailscale](https://tailscale.com) network.

| | | |
|---|---|---|
| <img src="docs/media/agent.png" alt="An agent's transcript on the phone"> | <img src="docs/media/projects.png" alt="The project list, one sheep per project"> | <img src="docs/media/menubar.png" alt="The macOS menu bar app"> |
| Read an agent and answer it | Your herd, by project | One switch on the Mac |

## Why

An agent works for ten minutes, then stops to ask which of three options you
want — and until you walk back to the laptop, it waits. SheepIt closes that
gap. The phone shows the question, the keys to answer it, and a sheep per
project telling you at a glance who is working and who is waiting.

## What you get

- **Answer prompts from the phone.** Selection prompts render as their own
  card, with number keys that follow however many options the agent listed.
  Claude Code and Codex panes are both read, whichever glyphs they draw with.
- **Your herd at a glance.** The sheep is *who*, the row is *what*. Each pane
  gets its own animal — horns or none, woolly or shorn, one of thirteen breeds —
  hashed from the pane, so two agents on one project are never the same sheep
  twice and you can say "the black one with horns" and mean something. What it
  is *doing* is the coloured spine down the row and the pose it stands in:
  grazing while it works, head up when idle, ear pricked when blocked, asleep
  when done. Grouped under the repository they work in — worktrees included —
  in the order they were started, with whoever is asking you a question on top.
- **What is queued**, on the sheep it is stacked behind: prompts waiting for a
  window or a busy chat, counted per project in its heading.
- **What is left to spend**, above the flock: the same usage windows the queue
  runs on, so you can see the wall coming before you start three more agents.
- **Notifications when an agent actually wants you** — a turn that finished, a
  question on screen — off your network with the phone locked, plus a count on
  the home screen icon.
- **A bleat.** A sheep answers when an agent stops and needs you, if the app is
  open.
- **Send a screenshot.** Paste one straight into the composer, or use the
  paperclip for the photo library and the camera. The image is scaled down on
  the phone, written beside the work, and its path goes into the prompt for the
  agent to read. Git never sees it.
- **Native dictation.** Talk to your agent using the iOS keyboard's mic.
- **Drafts that stay put.** A half-written prompt belongs to the project it
  was typed for: switch away to check on another agent, come back, and it is
  still there with the caret where you left it. Kept on the phone, sent
  nowhere until you send it.
- **A plain view**, one switch away: the pane verbatim when you would rather
  read the terminal than the phone's reading of it.
- **A console.** The pane's own terminal, live, in the browser - for the
  full-screen editor an agent opened, the installer drawing a progress bar, or
  anything else that is a terminal rather than a transcript.
- **The changed files.** What the agent actually did to the working tree, read
  from git: a file list with its counts, and each file's diff unified or side
  by side.
- **A key palette** for the keys agents stop on — `y`, `n`, numbers, arrows,
  tab, enter, `Esc` and `Ctrl+C`.
- **Workspace control.** Start a project with **New**, swipe a row left to
  close one, cycle auto / plan / manual mode without touching the laptop.
- **A menu bar switch on the Mac** that starts everything the phone needs and
  keeps the machine awake so notifications can actually arrive.

## How it fits together

```
iPhone (home screen web app)
      │  HTTPS over your tailnet
      ▼
Tailscale Serve
      │
      ▼
SheepIt gateway  ── gateway/server.py, Python standard library only
      │  UNIX domain socket
      ▼
Herdr server  ── your agents, in their panes
```

The gateway never reaches the public internet. It reads and writes two UNIX
sockets belonging to Herdr - `herdr.sock` for the JSON-RPC everything else
uses, and `herdr-client.sock` for the console's live terminal - and serves the
`web/` directory to your phone.

## Quick start

You need Python 3.10+, a running [Herdr](https://herdr.dev), and Tailscale on
both machines.

```bash
git clone https://github.com/mowolf/herdr-mobile.git sheepit
cd sheepit
python3 gateway/server.py                      # http://127.0.0.1:3009
tailscale serve --bg --https=8443 http://127.0.0.1:3009
```

Then open `https://<node>.<tailnet>.ts.net:8443` in Safari on the phone and
**Share → Add to Home Screen**. On a Mac, `make -C menubar login` replaces all
of that with one switch in the menu bar.

Full instructions, autostart units and Tailscale routing live in
**[docs/gateway.md](docs/gateway.md)**.

## Turning the features on

Everything below lives behind the **gear** in the top right, once the app is
open on your phone.

### The console and the changed files

Both live behind the two icons beside the gear, and neither needs setting up.

The **console** attaches to the pane's own terminal over Herdr's client
socket - the same one a desktop Herdr uses - so it is the terminal, not a
reading of it: colours, redraws, full-screen programs, and keystrokes going
back. The key row underneath carries what a touch keyboard has no room for
(`esc`, `tab`, `^C`, the arrows). One thing to know: **attaching sets the
pane's size**, and the pane runtime is shared with whatever is showing it on
the desktop, so the window over there changes shape too. **Fit** re-asks for
the size that suits the phone after a rotation.

The **changed files** view runs git in the agent's own directory: a list of
what it touched with the lines added and removed, and a tap for the diff.
**Split** puts the old and new versions side by side, each half scrolling the
other. Untracked files are shown as what they are - all addition, against
nothing.

### Notifications

The one that needs setting up, because iOS insists.

1. **Add the app to your home screen first.** Web Push does not work in a
   Safari tab — only in an installed web app (iOS 16.4+). Share → *Add to Home
   Screen*, then open it from there rather than from Safari.
2. **gear → Notify when an agent needs you**, and accept the iOS prompt.

That is it. An alert names the agent that just stopped and what it was doing —
*"muskelmuskel finished / Rewrite the importer"* — and arrives through Apple's
push service rather than your tailnet, so it reaches you on cellular with the
phone locked. The gateway has to be awake to send it: on a laptop that sleeps,
use the [menu bar app](menubar/README.md) or run `caffeinate -s`.

Only two things earn one: a turn that finished with nobody having looked at it
yet, and an agent stopped on a question. A pane going quiet at its prompt —
a `/clear`, an interrupt, a pane you opened and never used — does not.

The same permission drives the **badge** on the home screen icon — the number
of agents waiting on you, clearing itself as you answer them. There is nothing
separate to enable.

If the toggle refuses to stay on, the hint beside it says why: *blocked in iOS
Settings* means the prompt was denied once and iOS will not ask again — clear
it under **Settings → Notifications**, or remove and re-add the app.
[More detail, and how to test it](docs/push.md).

### The bleat

**gear → Bleat when an agent needs you.** On by default; toggling it back on
plays it so you hear what you enabled. It follows the same rule as the
notification: a finished turn or a question, nothing else.

It only sounds while the app is open and in front of you — a notification
cannot carry a custom sound on iOS, so this is not a replacement for the one
above. iOS also refuses to let a page make any noise until it has been touched
once, so the first tap anywhere in the app is what unlocks it.

### Sending a screenshot

Nothing to turn on, and two ways in. **Paste** one straight into the composer —
iOS puts a screenshot on the clipboard the moment you take it, which makes this
the shortest path there is between seeing something wrong and an agent looking
at it. Or tap the **paperclip** left of the composer and pick a photo, take one,
or choose a file; iOS offers all three. On a laptop you can also drag an image
onto the composer. The image is scaled to 1600px
on the phone before it goes anywhere — a screenshot stays a PNG so its text
stays sharp — and lands in `.sheepit/` inside the directory the agent is
working in, with `@.sheepit/<name>.png` typed into the composer for you. Add
your question around it and send.

It goes *beside* the work on purpose: an agent reads a file in its own working
directory without stopping to ask permission, which is the whole point of
sending a picture from a phone. The directory is added to `.git/info/exclude`
on first use — ignored for this clone only, nothing committed, nothing in the
changed-files view — and images older than a week are cleared out as new ones
arrive.

The thumbnail strip above the composer shows what is attached. It is drawn from
the paths in the text, so deleting the path (or tapping **×**) un-attaches the
image; what you can see is exactly what will be sent.

### Dictation

No setting. Tap the microphone on the iOS keyboard and talk into the composer.

### The key palette

The **keyboard icon** in the header shows and hides it: `y`, `n`, the numbers,
arrows, tab, enter, `Esc` and `Ctrl+C`. The number keys follow whatever the
prompt on screen actually offers, so a five-option question gets five keys. The
choice is remembered.

`Ctrl+C` arms on the first tap and sends on the second, so a stray tap cannot
interrupt a working agent. It stays armed for a few seconds afterwards: leaving
an agent takes two interrupts in a row, and both agents give you only a moment
between them.

### Agent mode

**gear → Agent mode** cycles auto / plan / manual — the same `shift+tab` you
would press on the laptop.

### Projects

Tap the project name at the top for the full list. **New** starts a workspace;
swiping a row left reveals **Close**, which asks first — closing a workspace
stops every agent in it, and a stray swipe on a phone is cheap to make and
expensive to undo.

The list is one heading per project — the repository Herdr says the workspace
belongs to, so the queue's `sheep/` worktrees sit under the project they were
cut from rather than in a project each. Under a heading, sheep stay in the
order they were started; the one exception is an agent stopped on a question,
which rises to the top of its project and takes its project to the top of the
list. Nothing else moves, and nothing moves at all while you are looking at it.
Above the list is what is left of the usage window.

### Scrollback, the plain view and the status bar

**gear → Scrollback** trades detail for speed: 50 to 400 lines per refresh.

**Plain view** draws the pane verbatim: every line the agent printed, in order,
in the terminal's own colours, with nothing classified, collapsed or hidden.
The normal view is a set of guesses about a terminal dump — which glyph starts
a turn, which rules frame the composer, which of the last lines are the status
bar — and it earns its keep, but a guess that goes wrong hides something. Turn
this on when the phone is not showing you something the laptop is.

**Show agent status bar** brings back the agent's own bottom line — mode,
context left — which is hidden by default because it is noise on a phone. The
plain view already shows it, and greys the switch out while it is on.

## Repository layout

| | |
|---|---|
| `gateway/` | The Python gateway: `server.py` serves the app and proxies Herdr's socket; `push.py` signs Web Push. |
| `web/` | The phone app — plain HTML, CSS and JavaScript, no build step. `web/vendor/` holds xterm.js, the one third-party file it loads. |
| `menubar/` | `SheepIt.app`, the macOS menu bar switch. One `clang` invocation, no Xcode project. |
| `deploy/` | systemd and launchd units for running the gateway unattended. |
| `tools/` | The synthesised bleat, and the tests: `node tools/test-transcript.js` (the pane parser, both agents), `node tools/test-diff.js` (the diff rendering), `node tools/test-drafts.js` (the per-project drafts), `node tools/test-flock.js` (the overview's grouping and order), `node tools/test-attach.js` (pasting and attaching images), `python3 tools/test-gateway.py` (the Herdr codec, the WebSocket framing, git against a real repository, who earns a notification). |
| `LICENSES/` | The licences of the code this one borrowed from. |
| `docs/` | Everything below. |

## Documentation

- **[docs/gateway.md](docs/gateway.md)** — install, run, autostart, ports, and
  sharing a tailnet with dev servers.
- **[docs/push.md](docs/push.md)** — notifications on iOS, and what a
  standard-library push implementation can and cannot do.
- **[docs/design.md](docs/design.md)** — the sheep, the postures, the bleat,
  the icons, and the iOS limits that shaped them.
- **[menubar/README.md](menubar/README.md)** — the macOS app.

## Naming

*Herdr* and *Tailscale* are other people's programs, and are named here only
where they are meant: Herdr's socket, Tailscale's commands. Everything that
belongs to this repository is SheepIt — `SHEEPIT_*` environment variables,
`~/.config/sheepit/`, `com.sheepit.*` services.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). Use it, change it, share your
changes — for anything noncommercial. Personal and hobby use, study, charities,
schools and public institutions are all covered.

Selling it, or using it as part of a commercial product or service, is not.
For that, open an issue on
[GitHub](https://github.com/mowolf/herdr-mobile/issues) and ask.

### Other people's code

Two things here are somebody else's, both MIT, both carried with their notices
in [`LICENSES/`](LICENSES):

- **[xterm.js](https://xtermjs.org)** — the terminal the console draws with,
  vendored unchanged into `web/vendor/`.
- **[herdr-studio](https://github.com/powerfooI/herdr-studio)** by Arthur — the
  Herdr client protocol this gateway speaks (the bincode codec, the handshake,
  the variant numbering and the 0.8.2/0.9.0 differences) and the shape of the
  git reading behind the changed-files view were worked out there first and
  ported to Python here. The files that carry the port say so at the top.

Note this is a *source-available* licence, not an open-source one — the
noncommercial restriction is exactly what the OSI definition disallows. If you
need an OSI licence for a policy reason, this is not it.
