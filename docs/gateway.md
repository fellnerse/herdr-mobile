# Running the gateway

The gateway is `gateway/server.py`: one Python file, standard library only. It
serves `web/` to your phone and proxies everything else onto Herdr's UNIX
socket. `openssl` is shelled out to for push signing; nothing else is needed.

## Requirements

* Python 3.10+
* A running [Herdr](https://herdr.dev) session or server on the same machine
* [Tailscale](https://tailscale.com), if you want to reach it from the phone

## Run it by hand

```bash
python3 gateway/server.py
```

It listens on `127.0.0.1:3009`. Two knobs, both environment variables:

| | |
|---|---|
| `SHEEPIT_PORT` | Port to listen on. Default `3009`. (`PORT` also works.) |
| `HOST` | Interface to bind. Default `127.0.0.1` — Tailscale Serve fronts it, so it does not need to be reachable itself. |

Herdr's socket is found automatically: `HERDR_SOCKET` if set, otherwise
`~/.config/herdr/herdr.sock`, falling back to `/root/.config/herdr/herdr.sock`.

> **fish shell:** `VAR=value python3 …` does not set the variable in fish. Use
> `env SHEEPIT_PORT=3009 python3 gateway/server.py`.

## Autostart

### macOS — the menu bar app (recommended)

```bash
make -C menubar login
```

One switch that runs the gateway, starts `herdr server` if nothing is
listening, brings Tailscale up, and holds `caffeinate -s` so the Mac stays
awake — an asleep Mac cannot deliver a push notification. See
[menubar/README.md](../menubar/README.md).

Turning it off leaves Herdr running: the headless server holds every open pane
and agent, so stopping that is `herdr server stop`, never a side effect of the
switch. The menu bar app and the launchd agent below cannot both own the port —
use one or the other.

### macOS — launchd

```bash
sed "s|SHEEPIT_DIR|$PWD|g" deploy/com.sheepit.gateway.plist \
  > ~/Library/LaunchAgents/com.sheepit.gateway.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sheepit.gateway.plist
```

Logs land in `sheepit.log` in the repository. To inspect, restart or remove:

```bash
launchctl print gui/$(id -u)/com.sheepit.gateway
launchctl kickstart -k gui/$(id -u)/com.sheepit.gateway
launchctl bootout gui/$(id -u)/com.sheepit.gateway
```

The unit runs `/usr/bin/python3` — system Python — rather than a Homebrew one
deliberately: the macOS application firewall ships with `/usr/bin/python3`
allowed for incoming connections while a Homebrew interpreter is not, so a
Homebrew-launched server can be silently unreachable from other devices.

### Linux — systemd

```bash
sudo cp deploy/sheepit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sheepit.service
```

Edit the paths in the unit first; it assumes `/root/projects/sheepit`.

## Reaching it from the phone

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3009
```

Then open `https://<node>.<tailnet>.ts.net:8443` on the phone — find the exact
name with `tailscale status --json | grep DNSName` — and **Share → Add to Home
Screen**. Installing it to the home screen is not optional if you want
notifications: Web Push does not work in a Safari tab, only in an installed web
app.

> **Prerequisite:** HTTPS certificates must be enabled for your tailnet (admin
> console → **DNS** → **HTTPS Certificates** → Enable). Without it,
> `tailscale serve --https` hangs and writes no config, and `tailscale cert`
> reports *"your Tailscale account does not support getting TLS certs"*. Check
> with `tailscale status --json | grep CertDomains`: it must list your node,
> not `null`.

## Sharing the tailnet with dev servers

Agents start dev servers, and they all want port 3000. This is why the gateway
defaults to **3009** and to HTTPS port **8443**: standard `443` stays free for
whatever an agent is previewing.

Tailscale is a mesh VPN, and the `tailscale0` firewall accepts traffic from
your own tailnet, so any dev server bound to `0.0.0.0` is already reachable
from the phone over plain HTTP — no proxy needed:

```text
http://<node>.<tailnet>.ts.net:3000     Next.js, Nuxt
http://<node>.<tailnet>.ts.net:5173     Vite
http://<node>.<tailnet>.ts.net:8000     FastAPI, Flask
```

Only the home-screen app needs HTTPS through Serve, because installation and
microphone access require a secure context.

Serve can also split one port by path:

```bash
tailscale serve --bg --set-path /sheepit http://127.0.0.1:3009
tailscale serve --bg --set-path /preview http://127.0.0.1:5173
```

Useful commands:

```bash
tailscale serve status           # what is routed where
tailscale serve status --json    # the raw table
tailscale serve --https=8443 off # drop one proxy
tailscale serve reset            # drop all of them
```

## Who can reach it

There are no accounts and no tokens. What protects the gateway is where it
sits: bound to `127.0.0.1`, reachable only through `tailscale serve`, on your
own tailnet. Anyone who can open the URL can read your panes and type into
them, so treat tailnet access as the credential.

One thing does not follow from network placement, and the gateway handles it
itself: a **page in another tab** is on your phone too. It cannot see the
tailnet, but it can ask the browser to make the request for you. So the
gateway serves no CORS headers at all — the app is same-origin with it and
needs none — and refuses any `/api/` request a browser marks as coming from
another site. Requests with no `Origin` and no `Sec-Fetch-Site` are not from a
page (curl, the menu bar app) and are left alone.

If you put something else in front of it, the same rule applies: `Origin` has
to agree with `Host`. Tailscale Serve passes the browser's `Host` through
untouched, which is what makes this work.

## The two Herdr sockets

Most of the gateway speaks JSON-RPC to `~/.config/herdr/herdr.sock`: listing
panes, reading scrollback, sending keys. The console needs something that
socket does not offer — a live byte stream — so it opens
`~/.config/herdr/herdr-client.sock` instead and speaks the protocol a desktop
Herdr speaks: a length-prefixed bincode envelope, `TerminalHello`, then
`AttachTerminal`, after which the pane's own ANSI arrives as it is drawn and
keystrokes go back the same way.

Both paths are found next to each other, and `HERDR_CLIENT_SOCKET` overrides
the second the way `HERDR_SOCKET` overrides the first.

Two consequences worth knowing:

* **Attaching sets the pane's size.** The handshake names a size and Herdr
  gives the pane that size; the runtime is shared with whatever is drawing the
  pane on the desktop, so that window changes shape too. The phone asks for
  what it can show at a readable font, and the **Fit** button asks again.
* **Protocol versions.** `ping` reports the protocol, and only the codecs
  actually verified here are used — 14 to 20, and 22, which Herdr 0.8.2 and
  later speak. Anything else is refused rather than guessed at, because a
  wrong variant index does not fail, it mis-decodes.

## The routes

| | |
|---|---|
| `GET /api/agents` | The herd: one row per tab, with status, cwd, the project it belongs to, and recency. |
| `GET /api/agents/{pane}/history` | Scrollback as text or ANSI. |
| `GET /api/agents/{pane}/changes` | What git says the agent changed. |
| `GET /api/agents/{pane}/diff?path=` | One file's unified diff. |
| `GET /ws/terminal/{pane}` | The console: a WebSocket carrying the pane's ANSI, with keystrokes, resizes and scrolls going back. |
| `POST /api/agents/{pane}/prompt`, `/keys` | Typing and single keys. |
| `POST /api/agents/{pane}/attach` | An image, as raw bytes with its own `Content-Type`. Written to `.sheepit/` beside the agent's work and excluded from git; answers with the path to put in a prompt. |
| `POST /api/workspaces`, `/api/workspaces/{id}/close` | Starting and closing projects. |
| `POST /api/workspaces/{id}/rename`, `/api/tabs/{id}/rename` | Herdr's own labels, so the laptop is renamed too. |
| `POST /api/workspaces/{id}/move` | Where a dragged project lands in Herdr's own order. |
| `GET|POST /api/push/*` | Notification keys, subscriptions and the last finisher. |

Everything under `/api/` and the WebSocket refuse a cross-origin request:
browsers do not apply CORS to a WebSocket, so the check is made by hand there.

## Implementation notes

* **Percent-encoded pane ids.** Mobile Safari encodes the colon in `w1:p2` as
  `w1%3Ap2`; the gateway unquotes path components before passing targets to
  Herdr.
* **The keyboard.** The viewport uses `interactive-widget=resizes-content` and
  `viewport-fit=cover`, and the layout height is driven from `visualViewport`,
  because iOS does not reliably reflow a fixed `dvh` layout when the keyboard
  opens — the header would slide off screen.
* **The console's scrolling.** Herdr streams the viewport rather than a
  scrolling log, so the browser's terminal keeps no scrollback of its own: a
  wheel or a drag is forwarded to Herdr, which scrolls the pane and sends the
  next frame already moved.
* **Battery.** Polling stops on `visibilitychange` when the phone locks or
  Safari is backgrounded, and resumes with an immediate refresh on wake.
* **Caching.** Assets are served with a strong `ETag` and
  `no-cache, must-revalidate`; without a validator iOS will happily strand a
  home-screen install on an old build.
* **Headers.** `web/` is served with a content security policy that allows
  nothing off-origin, plus `nosniff` and `X-Frame-Options: DENY`. The
  transcript reaches the page through `innerHTML`, so the policy is the
  backstop if anything ever slips past the escaping.
