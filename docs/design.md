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
being a sheet and becomes a 380px column on the left that nothing closes: the
chat opens beside it, the back chevron and the X have nothing left to do and go
away, and the transcript and composer hold to a column of their own rather than
running the width of a monitor. Everything below that width still stacks, which
is what a phone and a narrow window both want. The breakpoint lives in
`style.css`; `app.js` knows only that closing the flock is not a thing there.

Everything else the app opens goes in that same right-hand column: the console,
the changed files, the tokens page and the settings. They are full-screen views
on a phone, where a half-view of a terminal or a diff is no view at all, and on
a Mac they start where the flock ends — one column saying what there is, the
other showing whatever you asked to see of it, and nothing covering the list.
Two of those views are a reading of one pane, so picking another row underneath
one re-aims it rather than leaving it showing the pane you walked away from: the
console re-attaches, the diff re-reads the new pane's working tree, and a
headless chat, which is not a pane at all, closes both. The tokens page and the
settings belong to no pane and sit still. The console is also the one view that
used to stop the poll while it was up; now it only takes the transcript out of
the loop, because the flock beside it has to stay alive.

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
| Unknown ⚪ | grey spine | no animal — a black terminal with a sheep on it |

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
it at all draws none of those postures: it is a black terminal screen with a
`>_` on it and a small white sheep standing beside the prompt — the only sheep
in the flock with no breed, no colour and nothing to be doing, which is what a
project's plain shell tab shows beside its siblings. The prompt is what makes
it a terminal rather than a dark card, and the animal is what keeps it in the
same list as the rest. Bare ground was the first answer and it said the wrong
thing: an empty field is an agent that has spent its window, and that is what
the grass is for. A shell has not run out of anything. Its status badge says
Idle or Working; the drawing already shows that it is a shell.

Herdr has no `agent_status` for a pane with no agent in it — that is an agent's own
lifecycle, and a shell has none — so `mark_shell_busy` in `server.py` guesses
it the same way the composer is read: off the last line of the shell's own
scrollback, on whether it ends in the glyph a prompt hands the terminal back
with. A guess, not a reading — a command whose own output happens to end in
`$` reads the same as one still running. The standard status badge shows
Working when this signal says busy, and Idle otherwise. The `>_` prompt stays
still.

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

Off unless you ask for it: **Show machine load** in Settings, saved on the
phone (`sheepit.machine`) and off on a fresh install, because the strip answers
a question about the laptop rather than about the agents and most glances at the
flock are not asking it. While it is off the phone asks for the usage windows
with `?machine=0` and the gateway does not read a single counter — the strip
disappearing and the work behind it stopping are the same switch. Turning it on
takes a poll to show numbers: rates need a previous pass to measure against.

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

Project headings stay in creation order unless somebody drags them. Agent
activity sorts rows inside a project, so a waiting sheep remains easy to find
without moving the project underneath the user's thumb. The badge and pushes
still surface questions and finished turns independently.

The last drawn row order is held through a touch, a swipe, a carried project or
a scroll, and for three seconds after the finger lifts.

Herdr still exposes no timestamps, and `state_change_seq` is still watched: the
phone stamps a wall-clock time whenever it moves — or whenever you open a
project — and that is what the "3m" on a row means. A first sighting is not a
change, so a row seen only sitting still shows no age rather than claiming it
happened the moment the app first looked.

## A finger's own order

The stillness above is a rule about what the *phone* does on its own. Somebody
who wants a different order can hold a row for a moment: the project lifts off
the list to be carried somewhere else, and where it lands is saved by the
gateway so desktop and mobile share the same order.

An order made by hand outranks creation order. A project the saved order has
never seen joins at the end and stays there until somebody moves it, including
one created through the flock's global **+ New** action.

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

A workspace has tabs — the laptop shows them in its tab bar — and the overview
groups by the workspace rather than by them: a pen, which for everything the
scheduler cuts is one pen per worktree. This is a change from listing a row per
tab, and the reason is what the rows could *do*: every action a swipe revealed
acted on the workspace, so closing what looked like one tab stopped the whole
branch and took its neighbours with it. A pen can offer Close and Remove
honestly.

A pen with one tab in it — the common case — is one row, and its sheep is
hashed from the workspace rather than from the pane, so a worktree keeps one
face for as long as it is open.

A pen with more than one **hangs them out**: the worktree's title on a quiet
line of its own, and a sheep per tab indented underneath it, joined to the
title by a bracket down the left. Standing in front of them instead was honest
about Close and dishonest about everything else — the row drew whichever tab
needed you most, so the second agent in a worktree was the words `2 tabs` in
the corner of the first one's row, and the only way to it was the strip above
somebody else's transcript. The count stays, on the title, because it is what
makes Close read as stopping more than one thing.

Which of the tabs the title speaks for is whichever needs you most: a question
first, then a turn that finished and is sitting there, then work in progress,
and a plain shell last. That is the pane tapping the title opens, so a pen you
open lands on the tab that was asking.

The sheep in an opened pen are hashed from their own panes, which is the one
place the workspace hash is deliberately not used: two animals side by side
under one title that were the same animal would say the two tabs were the same
agent. The cost is that a worktree's face changes when its second tab opens,
and it is the right way round — the face that matters is the one telling this
tab from the one below it.

Each half of a pen offers what it can honestly do. The title keeps the
worktree's three — Rename, Close, Remove — and a tab keeps the two a strip
offers it: Rename, which is `tab.rename`, and Close, which closes that tab and
not the branch. Closing is safe there because a pen is only drawn this way while
it has a second tab for Herdr to keep the workspace alive by.

On a desktop every row wears the first two of what its drawer offers as icons —
a pencil and a bin, which arrive when the pointer is on the row. A mouse cannot
swipe, so the drawer behind a row is a gesture it does not have, and these two
are that drawer for this one row. They sit in the corner the `…` used to appear
in, which is the whole of what that hint is replaced by: it said a drawer was
there and did nothing itself. A worktree's pair renames and closes the worktree,
a pen's title the same, a tab inside an opened pen renames and closes that tab,
and a chat gets the bin alone, since Delete is all a chat has. Remove is
deliberately not among them, because it deletes a checkout and should stay
something you aim at — which means a desktop cannot delete a checkout at all,
only close it and leave it on disk. A phone shows no icons and keeps the swipe;
a desktop shows the icons and has no drawer, not even by right-click, which is
the browser's own menu again. Two of anything on a row are two things to hit by
accident, and each pointer only ever sees one of the two ways in.

They arrive above the status badge rather than over it: hovering a row must not
take anything off the row, least of all the status it is there to say. A pen's
title has no badge in its corner and no corner to speak of, so its pair sits at
the end of the name instead.

The strip above the transcript is the other place they live: a chip each, the
one you are reading in the accent colour. It is where a tab is switched without
leaving the chat you are in, and the only place another one is opened. Tap to
switch, hold to rename, `+` to add something beside them, and `×` on the chip
you are in to close that tab alone. The `×` is absent on the last tab, because
Herdr closes the workspace along with it — that is the pen's own Close, where it
says so. The
chips scroll and the `+` does not: Herdr's tab labels are whole sentences, and
a plus that scrolls away with them is a plus nobody knows is there.

A tab running nothing but a shell is still reachable, which is what you want
when the thing you need is the `npm run dev` two tabs over. Herdr keeps two
numbers for a tab, and the phone wants the one the desktop's tab bar draws —
which is the label, not `number`. A tab somebody has named is called that; a
tab Herdr has only numbered is called what the laptop calls it, and lets its
pane's title lead instead.

## What "+" asks

There were four of them, and between them they did four unrelated things
nobody could name from the icon: a bare workspace at the top of the flock, a
worktree on a project heading, a tab in the strip above the transcript, and —
on a page of its own that nothing pointed at — a chat. Two of those are the
same question with a different answer, *another agent on this project, in its
own checkout or not*; the other two are the other same question, *something
new, with a terminal in front of it or a model*.

So there are two, and both of them ask. The sheet is one element with a title,
a body drawn from whichever question is being asked, and a cancel.

**`+ New`, at the top of the flock**, asks chat or terminal. A terminal is
`workspace.create` and needs nothing more said, so it happens on the tap. A
chat needs three answers — which project, what it may do without asking, and
which model — so the same sheet becomes that form, with the last answers filled
in, and the project guessed from the row you were looking at.

**`+` on a project heading, and `+` in the tab strip**, ask worktree or tab.
They are the same sheet: a worktree is its own branch and its own copy of the
tree, a tab is another agent on the branch that is already checked out. What
differs is only what each one knows. The strip knows exactly which worktree a
tab would join, and says so; the heading has to aim at the project's own
checkout, which is the same workspace a branch would be cut from. A worktree
asks for a name and takes a blank answer, which means *you name it* — one tap
and a return key when you have not thought that far. A project with no checkout
of its own open is offered a tab and no worktree, because Herdr resolves a
branch through a workspace and there is none to resolve through.

## The chats among the pens

A headless chat is the same Claude Code spending the same subscription in the
same checkout as the panes around it, and it used to live on a list of its own
that nothing pointed at — so a chat left holding a permission prompt was a
question nobody saw for a day. It is a row in the flock now, under the project
its directory names, with a speech bubble over its sheep's rump. The bubble
sits there rather than by the head because the head moves with every pose, and
a mark that jumps around the animal is one you have to find each time.

What it is *not* is a pane. It has no workspace, no tab strip, no transcript
and no pane id Herdr would recognise, so it never enters the list of panes that
the badge, the bleat and the selection all walk. It is hung on its project
after the grouping and given a pen of its own at the end of that project's
rows, below the worktrees, which are the only rows that have one. A project
whose panes are all closed still gets a heading if a chat is running in it,
because a chat you cannot see is a chat you cannot stop.

Its status is the same vocabulary the panes use, with one deliberate gap: a
question waiting on you is `blocked` and a turn in flight is `working`, but
there is no `done`. Nothing marks a chat as read, so a chat that answered last
Tuesday would sit at the top of its project asleep forever; a chat between
turns is idle, and the push is what tells you it finished. Its drawer offers
Delete and nothing else — Rename, Close and Remove all belong to a worktree,
and it has none.

## Renaming

Both labels are Herdr's own — `workspace.rename` writes the name in the
desktop's workspace strip, `tab.rename` the one in its tab bar — so a project
named on the sofa is named on the laptop a moment later. The phone deliberately
keeps no private nickname of its own: a name the machine under the desk knows
nothing about is a name that disagrees with every other way of looking at the
same workspace.

Swipe a row left to reach Rename and Close. A row that stands for a worktree —
one with a single tab in it, or the title above a pen that has its tabs out — is
`workspace.rename`, and every button in that drawer names the same workspace:
Rename used to be handed a pane and rename the tab behind it, which on a
two-tab worktree renamed something the row was not even showing. A row that is
one tab of an opened pen renames that tab instead, the same `tab.rename` that
holding its chip in the strip calls. A pointer reaches the title's Rename by the
pencil on it rather than by the drawer. Either row is dragged aside by however
wide its own buttons actually are rather than by a number written down twice.

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

## The pane views

The shared header keeps the **Chat / Normal / Console** switcher. Opening a
pane from the flock starts in Console; Chat is an explicit choice when that
pane has a resolvable session log. Normal shows the pane's screen as a verbatim
transcript. It does not classify turns or hide status rows, so it remains a
faithful reading of any agent or plain shell. The switcher changes the view of
the selected pane without opening a second page.

Chat reads Claude Code's session log and renders its structured messages,
tools and permissions in the same app document. Codex panes use the same chat
surface, reading their rollout log and mapping a blocked approval to the
terminal's yes/no keys. Headless Codex chats are not part of this view. Console
attaches to the pane's terminal and sends raw keystrokes. These views expose
different sources: Chat shows recorded session events, Normal shows the latest
screen, and Console is the live terminal.

## The console, and why it is not the transcript

Normal is a reading of the pane's screen, shown verbatim. A full-screen editor,
an installer drawing a progress bar, or a TUI with its own layout stays exactly
as the pane drew it; there is no parser trying to turn those rows into chat
turns.

So there is a second view that does not read anything. It attaches to the
pane's terminal over Herdr's client socket and puts the bytes on screen with
[xterm.js](https://xtermjs.org) - the same ANSI, the same colours, the same
redraws, and keystrokes going back. Where the transcript is the app's opinion
of the pane, the console is the pane.

Console also has a small text composer for sending a line without opening the
software keyboard over xterm. Its `@` suggestions come from the selected pane's
working directory, and submit encodes the text as terminal bytes followed by a
carriage return. The terminal itself still receives individual keys directly.

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

### A picture is not a patch

`Binary files a/icon.png and b/icon.png differ` is true and useless. A changed
screenshot, icon or diagram has exactly one question behind it - what does it
look like now, and what did it look like before - so an image row is drawn
rather than parsed: HEAD on one side, the working tree on the other, from
`/api/agents/{pane}/image?path=…&side=work|head`.

Only the sides that exist are drawn. A new file has no before, a deleted one
has no after, and a rename fetches its before under the name the file used to
have. The extension decides what counts as a picture rather than the bytes,
because the browser is the thing that has to recognise them; SVG is
deliberately not on the list, since it is text and its diff is worth reading.

Each picture sits on a checkerboard and says its own pixel size once the
browser knows it. The checkerboard is what distinguishes a transparent corner
from one the colour of your theme, and the size is the one number a patch
would have told you. The gateway serves those bytes under
`default-src 'none'; sandbox` and `nosniff`: it is the only route that answers
with a file somebody else wrote.

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
