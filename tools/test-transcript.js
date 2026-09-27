#!/usr/bin/env node
/* Raw transcript tests: node tools/test-transcript.js
 *
 * The phone preserves every pane row and its ANSI colors. Parsing is limited
 * to the live composer mirror, current mode, and keypad option count.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  const RE_SGR";
const TO = "  // Fetch Agent List";

const PRELUDE = `
  function escapeHtml(value) { return String(value).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[c])); }
  const state = { numberKeys: 3, mode: "" };
  const stub = () => ({ classList: { toggle() {} }, textContent: "", innerHTML: "" });
  const elTerminalInputRow = stub();
  const elTerminalInput = stub();
  const elKeysNumbers = stub();
  const elModeCurrent = stub();
  const elHistoryContent = stub();
`;

function loadParser() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  return new Function(`${PRELUDE}${src.slice(from, to)}
    return { parseTranscript, renderTranscript, renderNumberKeys, state,
      elTerminalInput, elKeysNumbers, elHistoryContent };`)();
}

const parser = loadParser();
let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failed++;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const screen = [
  "⏺ The answer stays in the transcript.",
  "────────────────────────────────────────────────────────────────",
  "  ⏵⏵ plan mode on (shift+tab to cycle)",
  "❯ finish this thought",
  "  Enter to select",
].join("\n");
const parsed = parser.parseTranscript(screen);
check("raw row count retained", parsed.rows.length, 5);
check("divider retained as text", parsed.rows[1].text.startsWith("─"), true);
check("status row retained as text", parsed.rows[2].text.includes("plan mode"), true);
check("live composer mirrored", parsed.liveInput, "finish this thought");
check("mode read from status", parsed.mode, "plan");
check("status hint without numbered choices adds no keypad options", parsed.optionCount, 0);

const prompt = [
  "  1. Yes",
  "  2. Yes, always",
  "  3. No",
  "  Enter to select · Esc to cancel",
].join("\n");
check("prompt option count", parser.parseTranscript(prompt).optionCount, 3);

const ansi = parser.parseTranscript("\u001b[38;2;180;180;180mcolored\u001b[0m");
check("ANSI color retained", ansi.rows[0].runs[0].fg, "rgb(180,180,180)");
parser.renderTranscript(screen);
check("only verbatim transcript renderer is used", parser.elHistoryContent.innerHTML.includes("t-transcript"), true);
check("no speaker-class renderer remains", parser.elHistoryContent.innerHTML.includes("t-user"), false);

function keys(count) {
  parser.state.numberKeys = -1;
  parser.renderNumberKeys(count);
  return (parser.elKeysNumbers.innerHTML.match(/data-key="(\d+)"/g) || []).map((m) => m.replace(/\D/g, "")).join("");
}
check("default keypad", keys(0), "123");
check("keypad grows to available options", keys(5), "12345");
check("keypad stops at nine", keys(10), "123456789");

if (failed) process.exit(1);
console.log("raw transcript checks passed");
