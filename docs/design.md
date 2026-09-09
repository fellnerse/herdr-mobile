# The sheep, the sound, and the icons

Notes on the parts of SheepIt that exist to be understood at a glance, and on
the iOS limits that shaped them.

## The flock

The project list draws one sheep per project. Colour carries the status, and so
does the posture — a silhouette needs no legend:

| State | Sheep | Motion |
|---|---|---|
| Working 🟡 | grazing, head down | munching bob |
| Idle 🟢 | standing, head up | still |
| Blocked 🔴 | head up, ear pricked | twitch |
| Done 🔵 | lying down asleep | slow breathing |
| Unknown ⚪ | no sheep — empty pasture | none |

Idle stands rather than sleeps on purpose: it is the state that most wants
answering, so it must not look like the dormant one. The pane with no agent at
all is the empty pasture. Every animation stops under
`prefers-reduced-motion`.

The sheep is inline SVG so the fleece can inherit each row's colour, which is
also why the face and ear are pale with a card-coloured outline: a dark muzzle
disappears into the dark card and leaves a headless blob.

## Sorting by recency

Herdr exposes no timestamps, but every pane carries a `state_change_seq` that
only grows. The gateway passes it through and the phone stamps a wall-clock
time whenever it moves — or whenever you open a project. Both live in
`localStorage`, so the order is *this phone's* rather than the server's
workspace numbering, and it survives a reload.

A first sighting is not a change. Rows seen only sitting still sort by
sequence but show no age, rather than claiming everything happened the moment
the app first looked. The order is also held steady while the list is open, so
a state change cannot slide a row out from under the thumb about to tap it.

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

`web/bleat.wav` is a synthesised "määäh", played once when an agent stops
working while the app is open. Several agents finishing in one sweep still get
one bleat; eight sheep at once is a farmyard, not a notification. Turn it off
under **gear → Bleat when an agent finishes**.

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
  granted notification permission.

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
