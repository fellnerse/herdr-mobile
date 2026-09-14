# The sheep, the sound, and the icons

Notes on the parts of SheepIt that exist to be understood at a glance, and on
the iOS limits that shaped them.

## The flock

The overview draws one sheep per pane, and the split is deliberate: **the sheep
is who, the row is what**.

### The row says what it is doing

| State | Row | Sheep |
|---|---|---|
| Working 🟡 | amber spine | grazing, head down — munching bob |
| Idle 🟢 | green spine | standing, head up |
| Blocked 🔴 | red spine **and a tinted card** | head up, ear pricked — twitch |
| Done 🔵 | blue spine | lying down asleep — slow breathing |
| Unknown ⚪ | grey spine | no sheep — empty pasture |

The spine is five pixels down the left edge of the card, drawn as an inset
shadow so the corner radius clips it and the swipe-to-close underneath does not
have to know about it. It is louder than a coloured animal ever was, and it
stays scannable down a list of projects rather than needing you to look at one
sheep.

Blocked gets the card tinted as well. Posture carries a lot, but posture alone
is weaker than colour for the one state that must never be missed — and with
status off the fleece, a sleeping black sheep and a working black sheep differ
only in pose and in the row around them. That edge has to be unmissable, not a
hairline.

Every animation stops under `prefers-reduced-motion`.

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
  pixels, because it changes the outline.
* **Coat** — woolly (the cloud line), shorn (a smooth, slimmer barrel with more
  daylight under it), or a fringe down over the eyes.
* **Breed** — twelve, near enough to real ones to be nameable: white, Suffolk
  (white with a black face), cream, oatmeal, tan, brown, grey, charcoal, black,
  badger face, spotted, Jacob. Each carries its own face colour, because the
  pairing is what makes it read as an animal and a face has to stay off its own
  fleece to be a face at all.
* **Muzzle** — dark on a pale face, pale on a dark one, or none. The cheapest
  way to tell two of one breed apart.

That is 216 animals, most of which differ in silhouette before they differ in
colour; over the pane ids Herdr actually hands out, two dozen panes come out
with twenty-two distinct sheep. The test asserts that, and that both shape axes
actually vary — a hash that quietly settled on one horn would leave the flock
looking hashed but identical.

### Outlines, and the hole in the row

Everything laid over the body is outlined in the card's own colour: face, ear,
fringe, horn. That was true when the fleece was a status colour and it matters
more now, because a sheep can be black and a black sheep on a dark card is a
hole rather than an animal.

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

None of it moves while the list is open. A state change that reorders rows
under a thumb about to tap one is the failure this whole section is about, so
the last drawn order is held until the picker closes.

Herdr still exposes no timestamps, and `state_change_seq` is still watched: the
phone stamps a wall-clock time whenever it moves — or whenever you open a
project — and that is what the "3m" on a row means. A first sighting is not a
change, so a row seen only sitting still shows no age rather than claiming it
happened the moment the app first looked.

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
