#!/usr/bin/env node
/* Draft tests: node tools/test-drafts.js
 *
 * A prompt on a phone gets written in the gaps, and the thing that used to
 * throw it away was switching to another project to see what it was doing.
 * The rules are small but each one is a way to lose somebody's sentence:
 * drafts belong to a pane, an emptied one is gone rather than remembered as
 * "", a sent one is gone, and the cap drops the oldest rather than the one
 * being typed.
 *
 * Sliced out of app.js between two anchors, like the other suites, with
 * localStorage and the composer stubbed.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  const DRAFTS_KEY";
const TO = "  /* Stamp anything whose sequence moved";

const PRELUDE = `
  const store = {};
  function readPref(name) { return store["sheepit." + name] ?? null; }
  function savePref(key, value) { store[key] = value; }
  const elPromptInput = { value: "", selectionStart: 0, setSelectionRange(a) { this.selectionStart = a; } };
  function autoResizeTextarea() {}
  const state = { activePaneId: null, drafts: {} };
`;

function loadDrafts_() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  return new Function(
    `${PRELUDE}${src.slice(from, to)}
     return { loadDrafts, saveDrafts, rememberDraft, restoreDraft, clearDraft,
              state, store, elPromptInput, MAX_DRAFTS };`
  )();
}

const d = loadDrafts_();

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

function type(text, caret) {
  d.elPromptInput.value = text;
  d.elPromptInput.selectionStart = caret === undefined ? text.length : caret;
  d.rememberDraft();
}

// -- one pane, one draft ----------------------------------------------------

d.state.activePaneId = "w1:p1";
type("half a sentence here", 7);
check("the draft is kept against its pane", d.state.drafts["w1:p1"],
      { text: "half a sentence here", caret: 7 });
check("and written through to storage",
      JSON.parse(d.store["sheepit.drafts"])["w1:p1"].text, "half a sentence here");

// -- switching panes --------------------------------------------------------

d.state.activePaneId = "w2:p1";
d.restoreDraft("w2:p1");
check("another pane starts empty", d.elPromptInput.value, "");
type("a different half-sentence");

d.restoreDraft("w1:p1");
check("the first pane's text comes back", d.elPromptInput.value, "half a sentence here");
check("with the caret where it was", d.elPromptInput.selectionStart, 7);

d.restoreDraft("w2:p1");
check("and so does the second's", d.elPromptInput.value, "a different half-sentence");

// A caret past the end of a draft that shrank underneath it is clamped.
d.state.drafts["w3:p1"] = { text: "short", caret: 99 };
d.restoreDraft("w3:p1");
check("a stale caret is clamped to the text", d.elPromptInput.selectionStart, 5);

// -- emptying and sending ---------------------------------------------------

d.state.activePaneId = "w2:p1";
type("");
check("an emptied composer forgets the draft", "w2:p1" in d.state.drafts, false);
check("and it leaves storage too",
      "w2:p1" in JSON.parse(d.store["sheepit.drafts"]), false);

d.state.activePaneId = "w1:p1";
type("   ");
check("whitespace alone is not a draft", "w1:p1" in d.state.drafts, false);

type("ready to send");
d.clearDraft("w1:p1");
check("a sent prompt is not kept", "w1:p1" in d.state.drafts, false);
d.clearDraft("w1:p1");   // twice is not an error
check("clearing nothing is harmless", "w1:p1" in d.state.drafts, false);

// -- nothing to attach a draft to -------------------------------------------

d.state.activePaneId = null;
const before = JSON.stringify(d.state.drafts);
type("typed with no pane selected");
check("no pane, no draft", JSON.stringify(d.state.drafts), before);

// -- the cap ----------------------------------------------------------------

/* The cap exists so a phone that has visited a hundred panes does not carry a
   hundred drafts forever. What it must never drop is the recent end. */
d.state.drafts = {};
for (let i = 0; i < d.MAX_DRAFTS + 5; i++) {
  d.state.activePaneId = `w${i}:p1`;
  type(`draft ${i}`);
}
const kept = Object.keys(d.state.drafts);
check("the cap holds", kept.length, d.MAX_DRAFTS);
check("the oldest went first", kept[0], "w5:p1");
check("the newest is still there", kept[kept.length - 1], `w${d.MAX_DRAFTS + 4}:p1`);

// Touching an old draft again moves it to the recent end rather than leaving
// it next in line to be dropped.
d.state.activePaneId = "w5:p1";
type("still being written");
const order = Object.keys(d.state.drafts);
check("a touched draft is the newest again", order[order.length - 1], "w5:p1");

// -- a store that cannot be read --------------------------------------------

d.store["sheepit.drafts"] = "{not json";
check("garbage in storage reads as no drafts", d.loadDrafts(), {});
d.store["sheepit.drafts"] = "[1,2,3]";
check("an array is not a draft map", d.loadDrafts(), {});
delete d.store["sheepit.drafts"];
check("nothing stored is no drafts", d.loadDrafts(), {});

// ---------------------------------------------------------------------------

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all draft tests passed");
