# The sheep, the sound, and the icons

Notes on the parts of SheepIt that exist to be understood at a glance, and on
the iOS limits that shaped them.

## The flock

The overview draws one sheep per pane, and the split is deliberate: **the sheep
is who, the row is what**.

### It is the page, not a sheet

The flock is what the app opens on. It used to be a sheet pulled down over
whichever chat the phone happened to have selected, which meant the first thing
you saw on unlocking was one agent out of nine, chosen for you — and the
question you picked the phone up for was behind a tap. Now a chat is somewhere
you go: a row opens it, and the header's back chevron is the way out of it. A
pane is still chosen behind the flock so its transcript is loaded by the time
you ask for it; it just does not drag the screen with it.

On a Mac the same two screens fit side by side. Past 900px the flock stops
being a sheet and becomes a 360px column on the left that nothing closes: the
chat opens beside it, the back chevron and the X have nothing left to do and go
away, and the transcript and composer hold to a column of their own rather than
running the width of a monitor. Everything below that width still stacks, which
is what a phone and a narrow window both want. The breakpoint lives in
`style.css`; `app.js` knows only that closing the flock is not a thing there.

### The row says what it is doing

When something is queued behind a pane, the row says *that* instead — "1
queued", in orange, where the agent's own word would be. An agent that finished
with a prompt still waiting is not "done", it is one prompt from starting
again, and what it was doing is still on the card twice over: the spine and the
pose. A question on screen is the exception and outranks the count, since
nothing is ever delivered into one.


| State | Row | Sheep |
|---|---|---|
| Working 🟡 | amber spine | grazing, head down — chewing the grass it is spending |
| Idle 🟢 | green spine | standing, head up |
| Blocked 🔴 | red spine **and a tinted card** | head up, ear pricked — twitch |
| Done 🔵 | blue spine | lying down asleep — slow breathing |
| Unknown ⚪ | grey spine | no sheep — empty pasture |

The spine is five pixels down the left edge of the card, drawn as an inset
shadow so the corner radius clips it and the swipe underneath does not have to
know about it. It is louder than a coloured animal ever was, and it stays
scannable down a list of projects rather than needing you to look at one sheep.

Blocked gets the card tinted as well. Posture carries a lot, but posture alone
is weaker than colour for the one state that must never be missed — and with
status off the fleece, a sleeping black sheep and a working black sheep differ
only in pose and in the row around them. That edge has to be unmissable, not a
hairline.

Idle stands rather than sleeps on purpose: it is the state that most wants
answering, so it must not look like the dormant one. The pane with no agent in
it at all is the empty pasture — which is what a project's plain shell tab
draws, beside its siblings' sheep.

Every animation stops under `prefers-reduced-motion`.

### The grass says what is left to spend

The field under a sheep is its subscription. Full window, tall grass; spent
window, stubble — and the sheep that is working chews it: the head dips into
the grass on its own hinge, and the tall tuft under the muzzle bends as it is
taken.

Three decisions hold that up.

- **Cropped, not mown.** Every blade shortens together rather than blades
  vanishing one at a time. At forty-four pixels, how many of a thing there are
  is arithmetic and how tall it is is a glance — and a sheep that ate its way
  across the field from one end would finish up chewing bare ground, since the
  head does not move. A spent window still draws stubble, because bare ground
  and *no reading at all* are opposite things to know and must not be one
  picture. A pane with nothing behind it — a shell, an agent nobody can price —
  gets no field.
- **The tightest window, not the average.** What stops you is whichever window
  runs out first, so the grass is cut to that one. A window that has rolled
  over describes a wall that is gone and is left out of the reckoning entirely.
  Once the window is spent the field dries off to brown, which is the same line
  the queue holds prompts on.
- **The field belongs to the subscription, not the pane.** Every Claude sheep
  on this machine eats the same field and the Codex sheep eat their own, which
  is the level `quota.py` can actually answer at. Two Claude agents on one
  project therefore stand in identically tall grass — that is not a bug, it is
  the same field twice.

How fast it is going is the second half of the answer, and it needs no history:
a window's length is in its name and its end is in `resets_at`, so how far into
it we are is arithmetic on a single reading. That rate sets `--chew`, the one
duration the body's bob, the head's dip and the blade's bend all share — a herd
burning through a subscription visibly eats faster than one nibbling at it.
The speed is bucketed into four, because the list only redraws when its
signature moves and a duration that tracked the rate exactly would restart
every sheep mid-chew on every poll. The number itself is printed under the
agent's name in the usage strip, where it is a rate in percent an hour.

Only the blade at the muzzle moves. Eight swaying blades on every row of a list
is a battery bill, not a meadow.

### The machine is the other wall

Under the subscriptions' windows, in the same columns, sits the computer
itself: hostname, one-minute load average under it, then five readings two to a
line — `cpu`, `ram` and `swap` as bars in percent of the whole machine, `disk`
and `net` as throughput. The core count sits beside the CPU bar because 100% of
two is not 100% of sixteen, and the installed total beside memory and swap, in
the column the reset times use. `gateway/machine.py` takes it — `/proc` on
Linux, `sysctl`, `vm_stat` and `netstat` on macOS, no third-party package — and
it rides on the usage poll rather than one of its own, because it answers the
same glance.

The continuation rows carry an empty name column rather than starting at the
margin: a wrapped flex item lands half a column left of the readings above it,
and five bars that do not line up are harder to read than three that do.

Three of the five are rates, and a rate is the difference between two readings.
All the counters are therefore read in one pass against one previous pass, so
the span is the phone's own polling interval — an honest average over the last
thirty seconds. The first paint has nothing to subtract from and samples a
tenth of a second instead, which is coarse and says so by being the only
reading taken that way.

What the numbers refuse to do matters more than what they do:

- **Used memory is what is not *available*, never what is not free.** Linux
  spends every spare page on cache and hands it back on demand; macOS counts
  active, wired and compressed. Free memory on a healthy machine reads as a
  machine about to die.
- **Waiting on a disk is not being busy.** A build blocked on IO would
  otherwise turn every build into 100% CPU.
- **Nothing is counted twice.** `sda1` is part of `sda` and `dm-3` is a view of
  it again, so only whole drives count; Tailscale's traffic leaves through
  `eth0` as well, wrapped, so overlays and bridges are left out and the wire is
  counted once.
- **Measured-and-idle is not the same as not measured.** A rate of nothing
  prints `0`, a counter this operating system does not keep prints `—`, and a
  machine with swap turned off gets no swap bar at all rather than an empty one.

Amber at 75% and red at 95%, the same colours the windows use — except swap,
which is amber at 25% and red at 60%: memory at three quarters is a machine
doing its job, swap at three quarters is a machine already paying for it.

### The sheep says which one it is

Two agents on one project used to be the same animal twice, and grouping the
list by project is exactly what puts them side by side.

The first answer was paint: a raddle mark in a hashed colour, the way a real
flock is sprayed. It worked, but it asks the wrong question. You do not
recognise a sheep by its mark — you recognise it by its shape, and then by what
colour the animal is. Shape survives a glance too fast to register hue, and
colour you can name: *the black one with horns* is a thing you can hold in your
head, where *the one with the teal blob on its flank* is a thing you decode.

So the whole animal is identity, hashed from the pane id with FNV-1a:

* **Horns** — hornless, a short curl, or a full spiral. The strongest cue at 44
  pixels, *provided* it changes the outline, which took two attempts. Drawn
  inside the silhouette in bone, a horn on a white sheep is pale on pale and
  alters no shape at all; and a placement that works for a raised head curls
  straight into the body when the head is down, which is two of the four poses.
  So the four placements were searched for rather than eyeballed — off the
  face, off the eye, inside the canvas, and mostly outside the fleece — and the
  test samples the curves and holds that last part. The horn is coloured
  against the fleece, dark on a pale sheep and bone on a dark one, the same way
  the eye is coloured against the face.
* **Coat** — woolly (the cloud line), shorn (a smooth, slimmer barrel with more
  daylight under it, drawn as two ellipses so it tapers into the neck rather
  than reading as furniture), or a fringe down over the eyes.
* **Breed** — thirteen, near enough to real ones to be nameable: white,
  Suffolk (white with a black face), cream, oatmeal, tan, saddleback, brown,
  grey, dalmatian, black, badger face, spotted, Jacob. Each carries its own
  face colour, because the pairing is what makes it read as an animal and a
  face has to stay off its own fleece to be a face at all.
* **Muzzle** — dark on a pale face, pale on a dark one, or none. The cheapest
  way to tell two of one breed apart.

That is 234 animals, most of which differ in silhouette before they differ in
colour; over the pane ids Herdr actually hands out, two dozen panes come out
with twenty-three distinct sheep. The test asserts that, and that both shape
axes actually vary — a hash that quietly settled on one horn would leave the
flock looking hashed but identical.

#### Why five of them are patterned

Lightness alone cannot separate the dark end of a palette. Charcoal, black and
a dark badger grey are one animal three times at this size, and no amount of
picking hex codes fixes it — the differences are real on a swatch and gone at
44 pixels. Hue can do it, which is why a brown sheep is nobody's black sheep,
but there is only so much dark hue to go round.

So the dark neutrals carry patterns instead: dots for the dalmatian, a broad
belt for the badger face, and black left as the one plain dark animal. Spots
(spotted, Jacob) and a saddle over the back do the same work at the light end.
A pattern is clipped to whatever body the coat drew, so nothing spills off a
shorn sheep's slimmer barrel, and each drawing defines its own clip because a
list draws a dozen of them into one document.

The test holds the rule rather than the palette: at most one dark, near-neutral
breed may be a plain colour. Add a fourth grey sheep with no pattern and it
fails.

### Outlines, and the hole in the row

Everything laid over the body is outlined in the card's own colour: face, ear,
fringe, horn. That is what makes a fringe legible where the face under it is
pale too — the scalloped card-coloured edge draws a line across the brow, where
a soft ellipse of fleece-coloured wool drew nothing.

The rim around the whole animal is the one place that rule inverts, and getting
it wrong is what left a black sheep as a hole in the row: the card's own colour
cannot separate anything *from the card*. A pale sheep needs no rim against a
dark row and keeps the card-coloured one; a dark sheep gets a light one
instead, its own fleece mixed halfway to a pale grey, so the halo still belongs
to that animal rather than outlining every dark sheep in the same white.

The body itself cannot simply be stroked: it is four overlapping circles and a
rectangle, and stroking them draws a line through every place two of them meet
— the fleece comes out as a diagram of its own construction. So the shapes are
drawn twice, once in the card's colour with a fat stroke and once filled on top.
The first pass leaves a halo; the second covers every internal line of it.

A horn gets the same treatment by the only means a stroke allows: the same path
drawn twice, card-coloured and fatter underneath.

## The order of the flock

The overview used to follow whatever moved last. With five agents on one
project, each finishing a tool call, that list rearranged itself every few
seconds — and the row you were reaching for was somewhere else by the time
your thumb arrived.

So the list is grouped and it is still. The group is the project: the gateway
reads `worktree.repo_root` off the workspace, which is what puts the
scheduler's `sheep/` worktrees under the repository they were cut from instead
of in a project each; a workspace opened by hand has no worktree record, so its
directory stands in. Inside a project, rows sort by when they were created —
Herdr numbers workspaces as they are opened and never renumbers them, and a
pane's own index orders the several agents one workspace can hold.

One thing overrides that: an agent stopped on a question. It is the only state
that goes nowhere without you, so it rises to the top of its project and
carries its project to the top of the list. Two waiting projects do not fight —
creation order breaks the tie.

None of it moves while a hand is on it. A state change that reorders rows under
a thumb about to tap one is the failure this whole section is about, so the
last drawn order is held through a touch, a swipe, a carried project or a
scroll, and for three seconds after the finger lifts. It used to be held for as
long as the list was open, which was the length of a glance; now that the flock
is the screen the app opens on, that would have been the length of the session,
and the question that rises to the top would never have risen.

Herdr still exposes no timestamps, and `state_change_seq` is still watched: the
phone stamps a wall-clock time whenever it moves — or whenever you open a
project — and that is what the "3m" on a row means. A first sighting is not a
change, so a row seen only sitting still shows no age rather than claiming it
happened the moment the app first looked.

## A finger's own order

The stillness above is a rule about what the *phone* does on its own. Somebody
who wants a different order can hold a row for a moment: the project lifts off
the list to be carried somewhere else, and where it lands is kept in
`localStorage` so the list is right before the next poll rather than after it.

An order made by hand outranks both rules above it — a project put third stays
third, and a question no longer pulls it to the front, because a list somebody
arranged and a list that rearranges itself cannot both be true. Inside a
project the question still rises: the project is not going anywhere either way.
A project the saved order has never seen — made since the last drag — falls
back to when it was created, which is the end.

Herdr is told too, with `workspace.move`, so the laptop's workspace strip
follows the phone instead of arguing with it. It is told only when the project
is a single workspace: a project here is a repository and Herdr reorders
workspaces, and the two line up exactly while nothing has been cut into
worktrees. The rest keep their order on the phone alone rather than have one
drag rewrite a strip nobody asked it to.

One detail that is easy to get backwards: `workspace.move` inserts before
whatever sits at `insert_index` *counting the workspace being moved*, so a
project dropped below where it started lands one slot further along than the
index it ends up at. Off by one there is a project that creeps a place every
time somebody moves it, which is why the arithmetic is a function of its own
with the whole four-by-four of it checked in `tools/test-flock.js`.

## Tabs

A workspace has tabs — the laptop shows them in its tab bar, and the phone used
to show whichever of them had an agent in it. Now every tab is a row, including
the ones running nothing but a shell, which is what you want when the thing you
need is the `npm run dev` two tabs over. A row with no agent says `shell` where
the others say what their agent is doing, and draws the bare ground it has
always drawn for a pane with nobody in it.

Each row is its own sheep, so a project with one agent working and another
waiting on an answer draws both rather than averaging them into one animal.

Herdr keeps two numbers for a tab, and the phone wants the one the desktop's
tab bar draws — which is the label, not `number`. A tab somebody has named is
called that; a tab Herdr has only numbered is called what the laptop calls it,
and lets its pane's title lead instead.

## Renaming

Both labels are Herdr's own — `workspace.rename` writes the name in the
desktop's workspace strip, `tab.rename` the one in its tab bar — so a project
named on the sofa is named on the laptop a moment later. The phone deliberately
keeps no private nickname of its own: a name the machine under the desk knows
nothing about is a name that disagrees with every other way of looking at the
same workspace.

Swipe a row left to reach Rename and Close. A row is a tab, so Rename is
`tab.rename` — except on a workspace holding a single tab, where the name the
row is showing is the workspace's own and renaming the tab would leave the row
saying exactly what it said before. The row is dragged aside by however wide
those buttons actually are rather than by a number written down twice.

## Reading the pane

The phone gets a terminal dump: the pane's last hundred lines, padded to the
desktop's width, with no structure but glyphs. Two agents draw the same handful
of roles differently — Claude Code marks a turn `⏺` and a tool result `⎿`,
Codex uses `•` and `└` — so the parser knows both alphabets, and the block a
line belongs to decides its colour.

The part that has to be right is the foot of the pane, because that is where
the composer, the status bar, and the question an agent is waiting on all live.
Those first two are live UI rather than conversation: what the laptop has typed
is mirrored in a one-line strip above the phone's own composer, and the status
bar is hidden behind a toggle. A prompt must survive both.

Anchor on the composer's own glyph — `❯` in Claude Code, `›` in Codex — and not
on the last pair of horizontal rules. Rules are not a frame you can trust:
Claude Code brackets its input box with them, Codex prints them as turn
separators, and a markdown table's separator row is one too. Taking the last
two of *those* lifted the tail of a Codex answer into the one-line mirror and
dropped the rest — and with Codex framing its approval box in nothing at all,
whatever fell past the final rule was greyed out as status bar and hidden. Both
ways a question vanished, which is the one failure that matters: the sheep goes
red and the phone shows nothing to answer.

So the prompt is found by what it says — numbered choices, and the footer under
them ("Enter to select", "Press enter to confirm or esc to cancel") — rather
than by the furniture around it, and where prompt and chrome overlap the prompt
wins. A numbered list with the composer still under it is prose, not a
question: the composer gives way while an agent waits.

`node tools/test-transcript.js` holds both agents' panes idle, typing, and
waiting.

### When the guessing is wrong

All of the above is inference over a screen dump, and inference that misses
hides something. Most of what the parser drops is padding and furniture, but
not all of it: a caption on a rule sitting directly under another rule is
overwritten by it, a line of the agent's own `=` or `.` is read as a rule and
collapsed to three characters, a run of eight glyphs with no words in it
becomes a hairline, and everything Claude Code prints *below* its input box —
usage warnings, background tasks, errors — is filed under the status bar and
hidden with it.

Rather than chase each of those with another heuristic, there is a way out
from under all of them: **gear → Plain view** draws the tokenised rows as they
arrived, coloured by the terminal's own escape codes and classified as
nothing, with only the right-hand padding gone. The parse still runs — the
keypad, the mode readout and the input mirror are read out of it — but it no
longer decides what you may see. The test asserts the promise directly: every
line, in order, byte for byte.

## The bleat

`web/bleat.wav` is a synthesised "määäh", played once when an agent stops and
wants you — a finished turn or a question — while the app is open. Several
agents finishing in one sweep still get one bleat; eight sheep at once is a
farmyard, not a notification. It reads the same two statuses the push does, so
a pane merely returning to its prompt makes no sound. Turn it off under
**gear → Bleat when an agent needs you**.

There is no sample to license or lose — the sound is generated, and the
generator is committed beside it:

```bash
python3 tools/make-bleat.py     # rewrites web/bleat.wav
```

It is a buzzy glottal source under three formant resonators tuned to an open
`ä`, the first swept up from a closed nasal onset so it opens like "m-ää", with
a falling pitch and the 26 Hz tremolo that makes a bleat sound like a sheep
rather than a synth tone. The upper formants are lifted hard, because a glottal
source rolls off at -6 dB/octave and without that the vowel comes out closer to
"moo".

iOS will not let a page make a sound until it has been touched once, so the
audio context is created and the file decoded on the first interaction.
[Notifications cannot carry it](push.md#custom-sounds-are-not-possible).

## The home screen icon

`web/icon.svg` is the same sheep, in blue on a moonlit pasture. The PNGs beside
it are rasterised from that one file:

```bash
for s in 180 192 512; do
  qlmanage -t -s $s -o /tmp/icons web/icon.svg
  mv /tmp/icons/icon.svg.png web/icon-$s.png
done
```

Three things about iOS are worth knowing before trying to make the icon say
anything:

* **iOS ignores manifest icons and refuses an SVG `apple-touch-icon`.** The
  home screen icon comes from the PNG in `<link rel="apple-touch-icon">`; point
  it at an SVG and iOS falls back to a screenshot of the page.
* **The icon is snapshotted when the app is added, and never fetched again.**
  Changing the PNG, the link or the manifest does nothing to an install that
  already exists — the only way to pick up a new icon, or a new name, is
  long-press → **Remove App** and add it again. There is no API to change an
  installed icon, so it cannot reflect live state: no sheep per agent, no
  colour per status.
* **The badge is the exception.** `navigator.setAppBadge()` works in an
  installed home-screen app (iOS 16.4+) and is the one part of the icon that
  still updates, so it carries the number of agents waiting on you — set while
  the app is open, and again from the push handler while it is closed. It needs
  granted notification permission. Waiting means the same two states a
  notification fires for: a finished turn nobody has looked at, and a question
  on screen. Counting `idle` too kept a number on the icon all day, for panes
  that wanted nothing.

The icon is drawn full bleed with no rounded corners of its own, because iOS
applies its own mask on top.

## The Mac icons

Two of them, and they are not the same drawing for good reason.

The **menu bar** icon is drawn in code, in `menubar/main.m`. A menu bar image
is a *template*: one alpha channel that AppKit tints for the light or dark bar,
so it cannot carry colour, and the head has to be told from the fleece by
cutting the gap out of the silhouette rather than by outlining it.

The **Finder** icon is the phone's icon, wrapped by `menubar/make-icns.py` in
the rounded rectangle macOS expects — unlike iOS, macOS does not mask an app
icon, so a full-bleed square would sit in the Dock as a square tile. Wrapping
the same SVG keeps one sheep to edit rather than two.

If a rebuild seems to change nothing, note that the menu bar icon lives in the
binary: a copy left running keeps drawing its own. `make -C menubar install`
quits any running copy first.

## The console, and why it is not the transcript

The transcript is a reading: the pane parsed into turns, the furniture taken
off, a question lifted out and given its own card with keys under it. That
reading is the whole point of the app, and it is also a guess - and a guess
has failure modes. An agent that opens a full-screen editor, an installer
drawing a progress bar, a TUI with its own layout: none of these are turns,
and no parser makes them into any.

So there is a second view that does not read anything. It attaches to the
pane's terminal over Herdr's client socket and puts the bytes on screen with
[xterm.js](https://xtermjs.org) - the same ANSI, the same colours, the same
redraws, and keystrokes going back. Where the transcript is the app's opinion
of the pane, the console is the pane.

The trade it makes is size. A terminal has a shape, the pane's shape is the
one the desktop gave it, and a phone is narrower than any of them. Three
options existed:

1. **Show it at the pane's size and shrink the font.** Honest, and unreadable
   at 100 columns on a phone: about 6px.
2. **Resize the pane to the phone.** Readable, but the pane runtime is shared
   with whatever is drawing it on the desktop, so the window over there jumps
   to phone size while you read.
3. **Wrap.** Which is what a terminal does with a line too long for it, and
   what makes a diff or a table unreadable.

The handshake forces the choice, because it names a size and Herdr acts on it:
there is no attaching without saying how big. So the phone asks for the size
it can actually show - eleven pixels' worth of columns - and says so in the
header (`59×43 · 11px`), and **Fit** asks again after a rotation. The desktop
window does change shape. That is the cost of the console being the pane
rather than a picture of one, and it is better stated than hidden.

## The changed files

An agent's own account of what it did is a claim. Git holds the other one, and
the phone is a good place to check it: what was touched, how much, and what
the change actually says.

The reading is plumbing rather than porcelain - `status --porcelain=v1 -z`,
`diff --numstat -z`, and a per-file `diff` fetched only when a row is tapped,
because a repository an agent has been working in for an hour is not something
to send to a phone in one piece. `-z` matters more than it looks: the text
format quotes paths with spaces, quotes or newlines in C style, and unquoting
them correctly is a small parser nobody needs. NUL-separated output has no
quoting at all.

Untracked files have no diff to ask git for, so they are counted by reading
them and rendered against `/dev/null` - an agent's brand new file is the thing
you most want to look at, and "no diff available" would be the wrong answer.

Side by side is two independently scrolling columns rather than one grid: a
grid sized to its content puts the right-hand column past the edge of a phone,
because the longest line in the file decides where it starts. Each column
mirrors the other's horizontal scroll, so a line and its replacement stay
opposite each other. A run of removals pairs one-to-one with the run of
additions that replaced it, and the shorter side is padded - which is what
keeps everything after a lopsided edit level.

## Where it went: the tokens page

The strip on the flock answers "can I start something now". It cannot answer
"where did the week go", because a percentage of a window that resets every
five hours has no memory. That is the page behind the chart icon in the flock's
header: tokens over time, by hour or by day, stacked by model.

**Nothing is recorded for it.** Both agents already write every turn down —
Claude Code keeps a JSONL per session under `~/.claude/projects/`, with
`message.usage` on each assistant entry; Codex keeps a rollout under
`~/.codex/sessions/` with `token_count` events — so `gateway/tokens.py` reads
those and the page has a month of history the day it ships rather than starting
from zero. It is the same argument as `quota.py` reading what the agent noted:
the cheapest source is the one already on disk.

Reading it is the part that needs care, and three quirks of somebody else's
file format can silently double or halve a week:

- **Claude Code writes the same assistant message three times** as it streams.
  A message is counted once, keyed on its request and message id, with the last
  few hundred ids per file remembered — bounded, unlike a set of every id ever
  seen, so a session running all week costs the same as a fresh one.
- **A log is appended to between one reading and the next.** Each file's totals
  are cached against the offset they were read to, so a pass reads only what
  arrived. A file that got *shorter* is not the file we were reading: it is
  re-read from the top and what was tallied from it is thrown away, or the new
  session's tokens land on top of the old one's.
- **Codex reports cached input inside the input it was part of**, so the cached
  part is taken back out; added as it stands, the same tokens would be counted
  once as fresh input and once as a cache read. Where a rollout carries only a
  running total for the session, a turn is the difference from the total before
  it.

A cold scan of ~130MB of logs is about two seconds; every pass after it is a
handful of new lines, and the result is memoised for a minute because the page
polls while somebody is looking at it.

**The projects are the flock's projects.** A log entry carries only its `cwd`,
so the repository is found the way the list groups: up to the checkout, and
through a linked worktree's `.git` file to the repository it was cut from. A
Herdr worktree is read off its path as well (`~/.herdr/worktrees/<repo>/…`),
because the checkout is deleted the moment its branch lands — without that, the
biggest project on the page comes apart into a column per merged branch.

### What the page draws

Local hours and local days. The gateway counts in UTC because it cannot know
which day that was for whoever is looking; the phone is what turns 23:30 UTC
into this morning. Every bucket in the range is drawn, including the empty
ones: a chart that plots only the days that happened puts Friday next to Monday
and calls it a week.

Colour follows the model, in name order, never its rank. Which model is biggest
changes with the range, and a legend that repainted itself when you tapped
"24h" is one nobody can learn. Past five models there is no sixth hue — the
smallest fold into one grey "other", counted once. The legend under the chart
is also the reading: every model in the range is always listed, dimmed rather
than dropped when the bucket you are touching did not use it.

There is no tooltip. A tooltip on a phone is a tooltip under a finger, so the
reading is parked in a fixed line under the chart, and the hit target is the
whole column's slot rather than the bar in it — an empty hour is worth picking
too, because "nothing, at 14:00" is an answer.

The number the page leads with is **every token sent to a model, cache reads
included**: that is what the window is priced on, and it is nine tenths cache
on a working day. The four tiles under the chart are what it was made of, which
is where anybody who wanted the other number finds it.
