#!/usr/bin/env node
/* The queue above the composer: node tools/test-queue.js
 *
 * What is waiting to go to a chat is drawn in that chat, over the box it was
 * typed into. The thing being tested is mostly what it refuses to draw: another
 * chat's prompts, a prompt already delivered, or itself when there is nothing
 * waiting - an empty strip sitting above the keyboard is a permanent tax on the
 * smallest screen in the house.
 *
 * Sliced out of app.js between two anchors, like the other suites, with the
 * dock's elements stubbed.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  /* What is waiting to go to this chat";
const TO = "  elChatQueue.addEventListener";

function loadQueue(state) {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);

  const el = {
    innerHTML: "",
    hidden: false,
    classList: {
      add(name) { if (name === "hidden") el.hidden = true; },
      remove(name) { if (name === "hidden") el.hidden = false; },
      contains(name) { return name === "hidden" && el.hidden; },
    },
  };
  const composer = { value: "", focused: false, focus() { this.focused = true; } };
  const sent = [];
  const PRELUDE = `
    const escapeHtml = (s) => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const QUEUE_WORD = { waiting: "queued", failed: "failed" };
    const triggerHaptic = () => {};
    const autoResizeTextarea = () => {};
    const saveDraft = () => {};
    const fetchHistory = () => {};
    const elBtnSend = {};
    const fetch = async (url, opts) => {
      sent.push(url);
      return { json: async () => ({ ok: true }) };
    };
    const fetchQueue = async () => {};
    const alert = (message) => { sent.push("alert: " + message); };
    const resetLabel = (iso) => (iso ? "19.9." : "");
  `;
  const mod = new Function(
    "elChatQueue", "state", "elPromptInput", "sent",
    `${PRELUDE}${src.slice(from, to)}
     return { renderChatQueue, queuedFor, queueAction, editQueued };`
  )(el, state, composer, sent);
  return { ...mod, el, composer, sent, state };
}

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

const waiting = (id, pane, prompt) => ({ id, pane_id: pane, state: "waiting", prompt });

/* The settling grace lives up in the queue's plumbing rather than in the strip
   that draws it, so it is sliced separately. */
const SETTLE_FROM = "  /* A prompt that is about to go out immediately";
const SETTLE_TO = "  function quotaIsStale() {";

function loadSettle(state) {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(SETTLE_FROM);
  const to = src.indexOf(SETTLE_TO);
  if (from < 0 || to < 0) throw new Error(`settle anchors moved in ${SRC}`);
  const PRELUDE = `
    const setTimeout = () => {};
    const fetchQueue = async () => {};
  `;
  return new Function(
    "state",
    `${PRELUDE}${src.slice(from, to)}
     return { stillOwed, holdBack, QUEUE_SETTLE_MS };`
  )(state);
}

// -- what it refuses to draw yet --------------------------------------------

/* Typing into a free chat is the ordinary case, and there the prompt is gone
   within the second. Drawing it as "queued" in the meantime is a chip that
   appears and vanishes, which reads as a failure of the thing you just sent. */
{
  const state = { settling: new Map() };
  const s = loadSettle(state);
  s.holdBack(21);
  check("a prompt just accepted is not owed yet",
        s.stillOwed([waiting(21, "w3:p1", "go")]).length, 0);
  check("but one queued a moment ago is",
        s.stillOwed([waiting(21, "w3:p1", "go")], Date.now() + s.QUEUE_SETTLE_MS + 1).length,
        1);
}

/* Nothing else is hidden: a prompt the gateway never accepted, and every
   prompt that was already sitting there, are drawn the moment they are read. */
{
  const state = { settling: new Map() };
  const s = loadSettle(state);
  s.holdBack(22);
  const failed = { id: 22, pane_id: "w3:p1", state: "failed", prompt: "go" };
  check("a failure is not held back", s.stillOwed([failed]).length, 1);
  check("nor is a prompt nobody just typed",
        s.stillOwed([waiting(23, "w3:p1", "older")]).length, 1);
  check("and a delivered one is still gone",
        s.stillOwed([{ id: 24, pane_id: "w3:p1", state: "sent", prompt: "done" }]).length, 0);
}

// -- what it draws ----------------------------------------------------------

{
  const q = loadQueue({
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [
      waiting(7, "w3:p1", "Rewrite the importer to stream"),
      waiting(8, "wN:p1", "somebody else's prompt"),
    ],
  });
  q.renderChatQueue();

  check("the chat's own prompt is drawn",
        /Rewrite the importer to stream/.test(q.el.innerHTML), true);
  check("another chat's is not",
        /somebody else/.test(q.el.innerHTML), false);
  check("with all three things you can do to it",
        ["edit", "send", "delete"].map((a) => q.el.innerHTML.includes(`data-queue-${a}="7"`)),
        [true, true, true]);
  check("and what it is waiting as", />queued</.test(q.el.innerHTML), true);
  check("the strip is showing", q.el.hidden, false);
}

// An empty strip above the keyboard is a permanent tax on the screen.
{
  const q = loadQueue({ activePaneId: "w3:p1", queueSignature: null, queue: [] });
  q.renderChatQueue();
  check("nothing waiting draws nothing at all", q.el.innerHTML, "");
  check("and the strip gets out of the way", q.el.hidden, true);
}

// A delivered prompt belongs to the transcript now, not to the queue.
{
  const q = loadQueue({
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [{ id: 9, pane_id: "w3:p1", state: "sent", prompt: "already gone" }],
  });
  q.renderChatQueue();
  check("a delivered prompt is not still waiting", q.el.hidden, true);
}

// One that could not be delivered says why, since nothing will retry it.
{
  const q = loadQueue({
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [{ id: 10, pane_id: "w3:p1", state: "failed", prompt: "and add a test",
              last_error: "pane is gone" }],
  });
  q.renderChatQueue();
  check("a failed prompt says so", />failed</.test(q.el.innerHTML), true);
  check("and says what happened", /pane is gone/.test(q.el.innerHTML), true);
  check("and marks itself for the eye", /chat-queued attention/.test(q.el.innerHTML), true);
}

// A prompt is text somebody typed; it reaches the page through innerHTML.
{
  const q = loadQueue({
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [waiting(11, "w3:p1", '<img src=x onerror="alert(1)">')],
  });
  q.renderChatQueue();
  check("a prompt cannot bring its own markup",
        /<img/.test(q.el.innerHTML), false);
}

// -- why it is still sitting there ------------------------------------------

/* A queue that holds without saying so is indistinguishable from one that is
   broken, which is exactly how it looked when a window ran out and nothing in
   the chat mentioned it. */
{
  const out = {
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [waiting(20, "w3:p1", "after the reset then")],
    agents: [{ pane_id: "w3:p1", agent: "codex" }],
    quota: { agents: [{ agent: "codex", blocked: true, resume_at: "2026-09-19T08:14:00Z" }] },
  };
  const q = loadQueue(out);
  q.renderChatQueue();
  check("a held prompt says which agent is out",
        /Codex has nothing left until 19\.9\./.test(q.el.innerHTML), true);
  check("and stops there - the buttons under it say the rest",
        /goes anyway|Send now goes/.test(q.el.innerHTML), false);

  // The same chat with room left says nothing: a queue waiting its turn behind
  // a busy agent is working exactly as intended.
  const fine = loadQueue({
    ...out,
    queueSignature: null,
    quota: { agents: [{ agent: "codex", blocked: false }] },
  });
  fine.renderChatQueue();
  check("a window with room says nothing", /chat-queue-note/.test(fine.el.innerHTML), false);

  // Another agent's wall is not this chat's problem.
  const other = loadQueue({
    ...out,
    queueSignature: null,
    quota: { agents: [{ agent: "claude", blocked: true, resume_at: "2026-09-19T08:14:00Z" }] },
  });
  other.renderChatQueue();
  check("and neither is another agent's",
        /chat-queue-note/.test(other.el.innerHTML), false);
}

// -- taking one back --------------------------------------------------------

/* Editing is not a form: the text goes back into the composer, where the
   keyboard already is, and the row goes with it. Sending it again queues it
   again, and nothing is lost in between because a composer full of text is a
   draft. */
{
  const q = loadQueue({
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [waiting(12, "w3:p1", "Rewrite the importer")],
  });
  q.renderChatQueue();
  q.editQueued(12);
  check("editing puts the prompt back in the composer",
        q.composer.value, "Rewrite the importer");
  check("with the caret in it", q.composer.focused, true);
  check("and takes the queued row away",
        q.sent.includes("/api/queue/12/delete"), true);
}

{
  const q = loadQueue({
    activePaneId: "w3:p1",
    queueSignature: null,
    queue: [waiting(13, "w3:p1", "now please")],
  });
  q.queueAction(13, "send");
  check("send now asks for exactly that", q.sent, ["/api/queue/13/send"]);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all queue tests passed");
