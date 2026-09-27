#!/usr/bin/env node
/* Structured chat event fixtures. Run with: node tools/test-chat.js */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
const from = src.indexOf("  function resultText(content) {");
const to = src.indexOf("  /* A message that starts with a command", from);
if (from < 0 || to < 0) throw new Error("chat event fold anchors moved in web/app.js");
const build = new Function(`${src.slice(from, to)}\nreturn build;`)();

let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failures++;
  console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}

const items = build([
  { type: "prompt", text: "Read the file" },
  { type: "assistant", content: [
    { type: "text", text: "I’ll inspect it." },
    { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
  ] },
  { type: "tool_results", content: [{ tool_use_id: "tool-1", content: "contents", is_error: false }] },
  { type: "ask", request_id: "ask-1", tool: "Bash", input: { command: "git status" }, suggestions: [{}] },
  { type: "answered", request_id: "ask-1", behavior: "allow" },
  { type: "result", duration_ms: 1250, cost: 0.004 },
], { kind: "pane", status: "idle", running: false, pending: [] });

check("prompt and assistant text become messages", items.slice(0, 2).map((it) => [it.kind, it.text]), [
  ["user", "Read the file"], ["assistant", "I’ll inspect it."],
]);
check("tool result joins its invocation", [items[2].kind, items[2].result, items[2].state], ["tool", "contents", "ok"]);
check("permission request retains its answer", [items[3].kind, items[3].answered, items[3].open], ["ask", "allow", false]);
check("turn cost and duration are shown", items[4], { kind: "meta", text: "1.3s · $0.004" });

const pending = build([
  { type: "ask", request_id: "ask-2", tool: "Bash", input: { command: "pwd" } },
], { kind: "headless", running: true, pending: ["ask-2"] });
check("pending permission remains actionable", [pending[0].kind, pending[0].open], ["ask", true]);

const blocked = build([], { kind: "pane", status: "blocked", running: false, pending: [] });
check("unlogged pane prompt is called out", blocked[0], { kind: "meta", text: "waiting on something in the terminal" });

if (failures) process.exit(1);
console.log("all chat event tests passed");
