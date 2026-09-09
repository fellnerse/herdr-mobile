#!/usr/bin/env node
/* Transcript parser tests: node tools/test-transcript.js
 *
 * The parser is the one part of the phone that guesses. It reads a terminal
 * dump with no structure beyond glyphs and rules, and the failure it keeps
 * finding is the worst one there is: an agent stops to ask a question and the
 * phone shows nothing, so the sheep goes red and stays red.
 *
 * The fixtures below are the two agents' panes, hand-cut to the parts that
 * mattered: an idle pane, and a pane waiting on an answer. Both are padded to
 * a terminal width because the real ones are.
 *
 * app.js is a browser script with no exports, so the parser is sliced out of
 * it between two anchors and evaluated on its own. It touches no DOM; the one
 * function it borrows from the rest of the file is stubbed.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  const RE_RULE_GLYPH";
const TO = "  function renderTranscript(text)";

/* The slice reaches past the parser to renderNumberKeys, because the keypad
   is the other half of reading a prompt: getting optionCount right and then
   drawing the wrong number of keys still leaves a choice nobody can press.
   Everything it touches is a DOM node or a sibling function; both are stubs. */
const PRELUDE = `
  function escapeHtml(s) { return s; }
  const state = { numberKeys: 0 };
  const el = () => ({ classList: { toggle() {} }, textContent: "", innerHTML: "" });
  const elTerminalInputRow = el();
  const elTerminalInput = el();
  const elKeysNumbers = el();
`;

function loadParser() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  const body = PRELUDE + src.slice(from, to);
  return new Function(
    `${body}\nreturn { parseTranscript, renderNumberKeys, state, elKeysNumbers };`
  )();
}

const W = 120;
const rule = (label) =>
  label ? `─ ${label} ` .padEnd(W, "─") : "".padEnd(W, "─");
const pad = (s) => s.padEnd(W, " ");

const CLAUDE_IDLE = [
  "⏺ The three stopword filters disagree, which is why the phrase collapses.",
  "",
  "✻ Brewed for 1m 33s",
  "",
  rule(),
  "❯ ",
  rule(),
  pad("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"),
  pad("                                                        ~175k uncached · /clear to start fresh"),
].join("\n");

const CLAUDE_TYPING = [
  "⏺ Ready when you are.",
  "",
  rule("Get this to work in herdr"),
  "❯ have another look at the",
  "  parser                   ",
  rule(),
  pad("  ⏵⏵ plan mode on (shift+tab to cycle)"),
].join("\n");

const CLAUDE_PROMPT = [
  "⏺ Bash(rm -rf build)",
  "",
  rule(),
  "  Bash command                                                        ",
  "                                                                      ",
  "    rm -rf build                                                      ",
  "    Remove the stale build directory                                  ",
  "                                                                      ",
  "  Do you want to proceed?                                             ",
  "  ❯ 1. Yes                                                            ",
  "    2. Yes, and don't ask again for rm commands in /repo               ",
  "    3. No, and tell Claude what to do differently (esc)               ",
  rule(),
  pad("  Enter to select · Esc to cancel"),
  pad("  ⏵⏵ auto mode on (shift+tab to cycle)"),
].join("\n");

const CODEX_IDLE = [
  "• Ran curl -sS --max-time 30 http://127.0.0.1:9200/_cat/indices",
  '  └ {"acknowledged":true}',
  "",
  rule(),
  "",
  "• Created testlocally.md and left it unstaged.",
  "",
  "  It includes checkboxes, steps and expected results.",
  "",
  rule("Worked for 5m 06s"),
  pad(" "),
  pad(""),
  pad("› Ask Codex to do anything"),
  pad(""),
  pad("  gpt-6-astra default · ~/repos/ib-public"),
].join("\n");

/* The one from the bug report: Codex frames a prompt in nothing at all, and
   the last rule above it is a turn separator several messages back. */
const CODEX_PROMPT = [
  rule(),
  "",
  "✔ You approved codex to run curl -sS --max-time 20 https://example.invalid/... this time",
  "",
  "• Ran curl -sS --max-time 20 https://example.invalid/stop.txt | sed -n '1,260p'",
  "  └ | From https://snowballstem.org/algorithms/german/stop.txt",
  "    … +256 lines (ctrl + t to view transcript)",
  "",
  "• Running curl -sS --max-time 20 https://example.invalid/stop.txt | sed -n '260,420p'",
  "",
  "  Would you like to run the following command?",
  "",
  "  Environment: local",
  "",
  "  Reason: May I fetch the remainder of the same stopword file?",
  "",
  "  $ curl -sS --max-time 20 https://example.invalid/stop.txt | sed -n '260,420p'",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `sed` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  pad("  « Press enter to confirm or esc to cancel"),
].join("\n");

/* An autocomplete menu the desktop opened says "Esc to cancel" too, and it
   belongs in the input mirror, not in a prompt card. */
const CLAUDE_MENU = [
  "⏺ Ready when you are.",
  "",
  rule(),
  "❯ /he                    ",
  "  /help    Show help     ",
  "  /hooks   Configure hooks",
  "  Esc to cancel          ",
  rule(),
  pad("  ⏵⏵ auto mode on (shift+tab to cycle)"),
].join("\n");

/* A numbered list an agent wrote is not a prompt: the composer is still under
   it, which is the tell - it gives way to the question while an agent waits. */
const CODEX_PROSE_LIST = [
  "• Three things to try, in order:",
  "",
  "  1. Reindex media_v4 with the shared analyzer.",
  "  2. Drop the local filter.",
  "  3. Re-run the fixture test.",
  "",
  rule("Worked for 2m 11s"),
  pad("› Ask Codex to do anything"),
  pad("  gpt-6-astra default · ~/repos/ib-public"),
].join("\n");

/* Codex, mid-run, echoing the instruction it was given. Its composer is gone
   while it works, so the lowest line starting with the composer glyph is
   something the agent printed - and taking it for the composer swallowed
   every line under it. */
const CODEX_QUOTED_LINE = [
  "• Reading the transcript you pasted:",
  "› deploy the staging cluster and drop the old index",
  "  That is the instruction I am acting on. Starting now.",
  "  I will report back when the reindex finishes.",
  pad("  Esc to interrupt"),
].join("\n");

/* A numbered list an agent wrote while working. No composer under it - Codex
   hides its own - and no footer either, which is the tell: a prompt always
   says how to answer it. */
const CODEX_WORKING_LIST = [
  "• Ran rg -n 'analyzer' src/",
  "",
  "  Three things to try, in order:",
  "  1. Reindex media_v4 with the shared analyzer.",
  "  2. Drop the local filter.",
  "  3. Re-run the fixture test.",
  pad("  Esc to interrupt"),
].join("\n");

/* A markdown table mid-answer. Its separator row is a rule like any other, so
   anchoring the input box on the last pair of rules lifted the sentence under
   the table into the one-line mirror and dropped the rest of the answer. */
const CODEX_TABLE = [
  "• Compared the two analyzers:",
  "",
  "  Field        Old        New",
  "  ──────────── ────────── ──────────────",
  "  analyzer     german     german_light",
  "  stopwords    231        0",
  "",
  "  Both Personen documents survive the change.",
  pad("  Esc to interrupt"),
].join("\n");

/* A prompt with more choices than the pad ships with, and more than there are
   number keys to press. */
const CLAUDE_TEN = [
  "⏺ Which index should I rebuild?",
  "",
  rule(),
  "  Select an index                                                     ",
  ...Array.from({ length: 10 }, (_, i) =>
    `  ${i === 0 ? "❯" : " "} ${i + 1}. media_v${i + 1}                              `
  ),
  rule(),
  pad("  Enter to select · Esc to cancel"),
].join("\n");

/* Every real pane arrives coloured, and the glyph match runs on what is left
   after the escape sequences are stripped. Same prompt as CLAUDE_PROMPT, as
   the terminal actually sends it. */
const sgr = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const CLAUDE_ANSI = [
  sgr("1;38;2;215;119;87", "⏺") + " Bash(rm -rf build)",
  "",
  sgr("2", rule()),
  "  Bash command                                                        ",
  "                                                                      ",
  "    " + sgr("38;2;180;180;180", "rm -rf build") + "                    ",
  "    Remove the stale build directory                                  ",
  "                                                                      ",
  "  Do you want to proceed?                                             ",
  "  " + sgr("38;2;97;175;239", "❯ 1. Yes") + "                           ",
  "    2. Yes, and don't ask again for rm commands in /repo               ",
  "    3. No, and tell Claude what to do differently (esc)               ",
  sgr("2", rule()),
  pad("  " + sgr("2", "Enter to select · Esc to cancel")),
].join("\n");

const parser = loadParser();
const parseTranscript = parser.parseTranscript;

let failed = 0;
function check(name, cond, detail) {
  if (cond) return;
  failed++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}

// What the phone actually draws: rules are hairlines and the status bar is
// behind a toggle that defaults to off.
function visible(parsed, cls) {
  return parsed.blocks
    .filter((b) => (cls ? b.cls === cls : b.cls !== "rule" && b.cls !== "status"))
    .map((b) => (b.rows || []).map((r) => r.text).join("\n"))
    .join("\n");
}

function run(name, text, expect) {
  const p = parseTranscript(text);
  const shown = visible(p);
  for (const needle of expect.shows || []) {
    check(`${name}: shows ${JSON.stringify(needle)}`, shown.includes(needle));
  }
  for (const needle of expect.hides || []) {
    check(`${name}: hides ${JSON.stringify(needle)}`, !shown.includes(needle));
  }
  if ("liveInput" in expect) {
    check(
      `${name}: liveInput`,
      p.liveInput === expect.liveInput,
      `got ${JSON.stringify(p.liveInput)}, want ${JSON.stringify(expect.liveInput)}`
    );
  }
  if ("optionCount" in expect) {
    check(
      `${name}: optionCount`,
      p.optionCount === expect.optionCount,
      `got ${p.optionCount}, want ${expect.optionCount}`
    );
  }
  if ("mode" in expect) {
    check(`${name}: mode`, p.mode === expect.mode, `got ${JSON.stringify(p.mode)}`);
  }
  if (expect.select) {
    const sel = visible(p, "select");
    for (const needle of expect.select) {
      check(`${name}: prompt card holds ${JSON.stringify(needle)}`, sel.includes(needle));
    }
  }
}

run("claude idle", CLAUDE_IDLE, {
  shows: ["The three stopword filters disagree"],
  hides: ["auto mode on"], // the status bar is behind a toggle
  liveInput: "",
  optionCount: 0,
  mode: "auto",
});

run("claude typing", CLAUDE_TYPING, {
  shows: ["Ready when you are."],
  hides: ["have another look at the"], // mirrored above the composer instead
  liveInput: "have another look at the parser",
  mode: "plan",
});

run("claude prompt", CLAUDE_PROMPT, {
  shows: ["Do you want to proceed?", "1. Yes", "3. No, and tell Claude"],
  liveInput: "",
  optionCount: 3,
  select: ["Do you want to proceed?", "Enter to select"],
});

run("claude menu", CLAUDE_MENU, {
  shows: ["Ready when you are."],
  hides: ["/help", "Esc to cancel"],
  liveInput: "/he /help Show help /hooks Configure hooks Esc to cancel",
  optionCount: 0,
});

run("codex idle", CODEX_IDLE, {
  shows: ["Created testlocally.md", "It includes checkboxes"],
  hides: ["Ask Codex to do anything", "gpt-6-astra"],
  liveInput: "",
  optionCount: 0,
});

run("codex prompt", CODEX_PROMPT, {
  shows: [
    "Would you like to run the following command?",
    "Reason: May I fetch the remainder",
    "1. Yes, proceed (y)",
    "3. No, and tell Codex what to do differently (esc)",
  ],
  liveInput: "",
  optionCount: 3,
  select: ["Would you like to run the following command?", "1. Yes, proceed (y)"],
});

run("codex prose list", CODEX_PROSE_LIST, {
  shows: ["Reindex media_v4", "Re-run the fixture test."],
  hides: ["Ask Codex to do anything"],
  liveInput: "",
  optionCount: 0,
});

run("codex quoted line", CODEX_QUOTED_LINE, {
  shows: [
    "deploy the staging cluster and drop the old index",
    "That is the instruction I am acting on.",
    "I will report back when the reindex finishes.",
  ],
  liveInput: "", // the glyph is the agent quoting, not an input to mirror
  optionCount: 0,
});

run("codex working list", CODEX_WORKING_LIST, {
  shows: ["Three things to try", "1. Reindex media_v4", "3. Re-run the fixture test."],
  optionCount: 0, // no footer, so no prompt and no keys to press it with
  liveInput: "",
});

run("codex table", CODEX_TABLE, {
  shows: [
    "analyzer     german     german_light",
    "Both Personen documents survive the change.",
  ],
  liveInput: "",
  optionCount: 0,
});

run("claude ten options", CLAUDE_TEN, {
  shows: ["Select an index", "10. media_v10"],
  optionCount: 10,
  select: ["1. media_v1", "10. media_v10"],
});

run("claude prompt in colour", CLAUDE_ANSI, {
  shows: ["Do you want to proceed?", "rm -rf build", "3. No, and tell Claude"],
  liveInput: "",
  optionCount: 3,
  select: ["Do you want to proceed?", "Enter to select"],
});

/* The keypad. optionCount is only half the job: the pad still has to draw the
   keys the prompt lists, and never one the agent cannot act on. */
function keys(count) {
  parser.state.numberKeys = -1; // renderNumberKeys skips a redraw it has done
  parser.renderNumberKeys(count);
  return (parser.elKeysNumbers.innerHTML.match(/data-key="(\d+)"/g) || []).map((m) =>
    m.replace(/\D/g, "")
  );
}

check("keypad: no prompt keeps the three it ships with", keys(0).join("") === "123");
check("keypad: two choices still leave three keys", keys(2).join("") === "123");
check("keypad: five choices, five keys", keys(5).join("") === "12345");
check(
  "keypad: ten choices stop at nine - a tenth is not one keypress",
  keys(10).join("") === "123456789",
  `got ${keys(10).join("")}`
);

console.log(failed ? `\n${failed} failed` : "all transcript tests passed");
process.exit(failed ? 1 : 0);
