# Notifications on iOS

Get told the moment an agent wants you — off your tailnet, on cellular, with
the phone locked.

## Turning them on

1. **Install the app to the home screen.** Web Push does not work in a Safari
   tab, only in an installed web app (iOS 16.4+).
2. Open it from the home screen, then **gear → Notify when an agent needs you**,
   and accept the iOS prompt.

Delivery goes through Apple's push service rather than your tailnet, which is
why it reaches you away from home. The gateway has to be awake to send it: on a
laptop that sleeps, run `caffeinate -s` — or use the
[menu bar app](../menubar/README.md), which holds it for you.

The same permission drives the count on the home screen icon. Without it the
badge silently never appears; see [design.md](design.md#the-home-screen-icon).

## What it needs

The `openssl` binary, present on macOS and most Linux hosts. Python's standard
library has no ECDSA, so the VAPID JWT is signed by shelling out to it. No pip
packages, no service account, no third party.

VAPID keys and device subscriptions are generated on first use and stored mode
`600` in `~/.config/sheepit/` (itself `700`) — override with
`SHEEPIT_STATE_DIR`. Both are created private rather than chmod'ed afterwards. They live
outside the repository and must never be committed. `SHEEPIT_PUSH_SUB` sets the
RFC 8292 contact sent to the push service.

## Why notifications carry no payload

Encrypting a push payload needs ECDH plus AES-GCM, which the standard library
cannot do. Rather than take a dependency, SheepIt sends an empty push and lets
the service worker fetch what it needs on wake.

That costs something the payload would have carried for free: *which* agent
just stopped. The list alone cannot say — it only shows who is waiting now, so
a notification built from it can describe the herd but never the event. So the
gateway remembers. The watcher records the panes it saw stop in
`/api/push/last`, and `sw.js` reads that alongside `/api/agents`:

```text
title:  muskelmuskel finished          ← from /api/push/last
body:   Rewrite the importer · 2 more waiting
```

Two agents stopping in the same sweep become *"muskelmuskel and ib-orbit
finished"*; more than two, *"muskelmuskel and 3 others finished"*. One stopped
on a question says *needs you* instead. A record older than two minutes is
ignored as stale, and so is a gateway that cannot be reached at all: both fall
back to *"An agent is waiting for you"*.

What the notification will never do is lead with the herd's total. Reading
*"3 agents waiting"* every time one agent finished made a single event look
like every agent calling at once — so the count comes last, as *"2 more
waiting"*, and only when there are others.

The same handler sets the badge count, and collapses repeats into one
notification so a burst of finishing agents does not become a burst of alerts.

Naming the agent is the point of the feature, so a notification puts a pane's
name — and sometimes its terminal title — **on the lock screen**, where it is
readable without unlocking the phone. Titles are whatever the agent set them
to, which is usually what you asked it to do. The record itself is dropped
after two minutes on both sides of the wire.

## What earns a notification

Only two things: a turn that has finished with nobody having looked at it yet
(`done`), and an agent stopped on a question (`blocked`). The watcher polls
`agent.list` every three seconds and pushes when a pane that has been working
lands in one of them — once per piece of work, because the pane has to go back
to `working` before it can be news again.

`idle` is deliberately not on the list, and leaving it there is what made the
phone buzz for everything. Herdr reports the prompt box as `idle`, and Claude
Code passes through it constantly: every `/clear`, every interrupt, every pane
you opened and never used. The one thing `idle` never means is that somebody
finished something.

A sweep where a pane merely drops out of `agent.list` — detection blinking,
usually — says nothing either: the pane is remembered as having been working,
and it notifies when it lands somewhere that wants you.

## Testing and troubleshooting

```bash
curl -X POST http://127.0.0.1:3009/api/push/test
```

`201` means the push service accepted it. `404` or `410` mean the subscription
is dead — the gateway drops it automatically, and the phone will re-subscribe
next time you open the app.

If nothing arrives at all, work through these in order:

* Is the app installed to the home screen, rather than open in a tab?
* Is the Mac awake? An asleep machine sends nothing and reports no error.
* Did the permission prompt get denied once? iOS will not ask again — clear it
  under **Settings → Notifications**, or remove and re-add the app.

## Custom sounds are not possible

The Notification API's `sound` property was dropped from the standard in 2018
for want of implementations, and iOS plays its own system sound for web push
regardless. Nothing in the service worker can change it. SheepIt's
[bleat](design.md#the-bleat) is therefore a foreground sound only.
