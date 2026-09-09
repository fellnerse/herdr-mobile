# SheepIt.app

The macOS half of [SheepIt](../README.md): a menu bar switch for the gateway,
on Apple Silicon.

One toggle drives the four things the phone needs, which otherwise have to be
started by hand and drift out of step:

| | |
|---|---|
| **Herdr** | `herdr server` is started if no server is listening — the gateway is only a proxy onto its socket, so without it the phone shows nothing |
| **Gateway** | runs `gateway/server.py` on `127.0.0.1:3009` |
| **Tailscale** | brought up if it is stopped — the phone reaches the gateway over the tailnet |
| **`caffeinate -s`** | an asleep Mac cannot send a push notification, so alerts silently never arrive |

The bar icon is the Sheep It sheep, drawn in code rather than bundled as an
asset: solid when the gateway is running, slashed and dimmed when it is off. It
is a template image, so the menu bar tints it for light and dark - which is why
the head is told from the fleece by a cut-out gap rather than by colour.

The Finder icon is the phone's home screen sheep. `make-icns.py` wraps
`web/icon.svg` in the rounded rectangle macOS expects - unlike iOS, macOS
does not mask an icon for you - and rasterises it with `qlmanage`, so there is
one sheep to edit rather than two.

## Build

```bash
make          # build/SheepIt.app
make run      # build and launch
make install  # copy to /Applications
make login    # install and start at login
make unlogin  # stop starting at login
```

`make login` installs a small LaunchAgent that runs `open -a SheepIt`
rather than adding a Login Item: scripting System Events to add one requires
Automation permission that a script cannot prompt for. `open` re-uses a running
instance, so logging in never starts a second copy.

No Xcode project and no dependencies — a single `clang` invocation against
AppKit. It is written in Objective-C rather than Swift deliberately: Command
Line Tools installs that carry a stale `SwiftBridging` modulemap fail every
Swift AppKit build, and clang is unaffected.

### Replacing an older build

The menu bar icon is drawn by the binary, so **a copy left running keeps
drawing its own icon** however many times the app is replaced on disk - which
is what makes a rebuild look like it did nothing. `make install` therefore
quits any running copy first, and also removes the app and LaunchAgent under
the previous `HerdrMenuBar` / `com.herdr.menubar` names, so the rename does not
leave two sheep in the bar. Relaunch with `make run`, or `make login` to
reinstate the login agent under its new label.

Finder caches app icons separately: if it still shows the old one after the
install, `killall Finder`.

## Notes

`gateway/server.py` is located by walking up from the bundle, so a build inside the
repository finds it automatically. Override with the `serverPath` user default
or the `SHEEPIT_SERVER` environment variable; `SHEEPIT_PORT` changes the port.

Herdr is found at the usual install locations rather than through `PATH`: a
GUI app inherits launchd's minimal environment, not the login shell's. Override
with the `herdrPath` user default or `HERDR_BIN`. Liveness is a `connect()` to
`~/.config/herdr/herdr.sock` (`HERDR_SOCKET` wins), so a socket file left
behind by a crash does not read as running.

Turning the switch off does not stop Herdr, and neither does quitting: the
headless server holds every pane and agent that is open, so tearing it down is
`herdr server stop`, never a side effect of the toggle.

The app and the launchd agent cannot both own the port. If you use this app,
remove the agent:

```bash
launchctl bootout gui/$(id -u)/com.sheepit.gateway
rm ~/Library/LaunchAgents/com.sheepit.gateway.plist
```

An orphaned gateway from a previous run is reclaimed automatically — but only
after confirming it is running the same `server.py`, never an unrelated
process. `caffeinate` is started with `-w <pid>`, so it exits with the app even
if the app is killed, rather than holding the Mac awake indefinitely.
