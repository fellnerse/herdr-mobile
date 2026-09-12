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
| Read an agent and answer it | Your herd, most recent first | One switch on the Mac |

## Why

An agent works for ten minutes, then stops to ask which of three options you
want — and until you walk back to the laptop, it waits. SheepIt closes that
gap. The phone shows the question, the keys to answer it, and a sheep per
project telling you at a glance who is working and who is waiting.

## What you get

- **Answer prompts from the phone.** Selection prompts render as their own
  card, with number keys that follow however many options the agent listed.
  Claude Code and Codex panes are both read, whichever glyphs they draw with.
- **Your herd at a glance.** One sheep per project, coloured *and* posed by
  what its agent is doing: grazing while it works, head up when idle, ear
  pricked when blocked, asleep when done. Sorted by whatever changed last.
- **Notifications when an agent finishes**, off your network with the phone
  locked, plus a count on the home screen icon.
- **A bleat.** A sheep answers when an agent stops, if the app is open.
- **Native dictation.** Talk to your agent using the iOS keyboard's mic.
- **A plain view**, one switch away: the pane verbatim when you would rather
  read the terminal than the phone's reading of it.
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

The gateway never reaches the public internet. It reads and writes one UNIX
socket belonging to Herdr, and serves the `web/` directory to your phone.

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

### Notifications

The one that needs setting up, because iOS insists.

1. **Add the app to your home screen first.** Web Push does not work in a
   Safari tab — only in an installed web app (iOS 16.4+). Share → *Add to Home
   Screen*, then open it from there rather than from Safari.
2. **gear → Notify when an agent finishes**, and accept the iOS prompt.

That is it. Alerts name the agent that just finished and count how many are
now waiting — *"muskelmuskel finished / 3 agents waiting for you"* — and arrive
through Apple's push service rather than your tailnet, so they reach you on
cellular with the phone locked. The gateway has
to be awake to send them: on a laptop that sleeps, use the
[menu bar app](menubar/README.md) or run `caffeinate -s`.

The same permission drives the **badge** on the home screen icon — the number
of agents waiting on you, clearing itself as you answer them. There is nothing
separate to enable.

If the toggle refuses to stay on, the hint beside it says why: *blocked in iOS
Settings* means the prompt was denied once and iOS will not ask again — clear
it under **Settings → Notifications**, or remove and re-add the app.
[More detail, and how to test it](docs/push.md).

### The bleat

**gear → Bleat when an agent finishes.** On by default; toggling it back on
plays it so you hear what you enabled.

It only sounds while the app is open and in front of you — a notification
cannot carry a custom sound on iOS, so this is not a replacement for the one
above. iOS also refuses to let a page make any noise until it has been touched
once, so the first tap anywhere in the app is what unlocks it.

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
expensive to undo. The list is ordered by whatever changed most recently, and
holds still while you are looking at it.

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
| `web/` | The phone app — plain HTML, CSS and JavaScript, no build step. |
| `menubar/` | `SheepIt.app`, the macOS menu bar switch. One `clang` invocation, no Xcode project. |
| `deploy/` | systemd and launchd units for running the gateway unattended. |
| `tools/` | The synthesised bleat, and `test-transcript.js` — `node tools/test-transcript.js` checks the pane parser against both agents. |
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

Note this is a *source-available* licence, not an open-source one — the
noncommercial restriction is exactly what the OSI definition disallows. If you
need an OSI licence for a policy reason, this is not it.
