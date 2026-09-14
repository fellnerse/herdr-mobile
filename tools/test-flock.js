#!/usr/bin/env node
/* Overview ordering tests: node tools/test-flock.js
 *
 * The list is the thing you reach into with a thumb, so what is being tested
 * here is mostly that it holds still: sheep stay under their project, a
 * project stays where it was created, and the only thing that ever moves a row
 * is an agent asking you a question.
 *
 * Sliced out of app.js between two anchors, like the other suites, with the
 * picker element stubbed.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  /* ----------------------------------------------------------- The flock ---";
const TO = "  // Opening a project is activity too";

/* The row templates live further down app.js, past the picker plumbing. They
   are sliced separately so this suite can ask what a row says without a DOM. */
function loadRows() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf("  /* What is still owed to each pane");
  const to = src.indexOf("  async function createWorkspace() {");
  if (from < 0 || to < 0) throw new Error(`row anchors moved in ${SRC}`);
  const PRELUDE = `
    const state = { activePaneId: null, groups: [], agents: [], queue: [],
                    swiping: false, listSignature: null };
    const elAgentList = { innerHTML: "", querySelector: () => null };
    const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const knownStatus = (s) => s || "unknown";
    const sheepSvg = () => "";
    const sheepMarks = (seed) => ({ breed: { id: "test", fleece: "#abcdef", face: "#123456" },
                                    horn: "curl", coat: "woolly", muzzle: false });
    const agoLabel = () => "";
    const wantsInput = (a) => a.status === "blocked";
  `;
  return new Function(`${PRELUDE}${src.slice(from, to)} return { state, agentRowHtml, queuedByPane, queuedLabel };`)();
}

/* The markings that tell two sheep on one project apart. Sliced on its own so
   the hash can be asked directly what it makes of an id. */
function loadMarks() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf("  const POSE = {");
  const to = src.indexOf("  /* Everything a row draws.");
  if (from < 0 || to < 0) throw new Error(`marks anchors moved in ${SRC}`);
  return new Function(
    `${src.slice(from, to)} return { sheepMarks, sheepSvg, eyeOn, BREEDS, HORN_KINDS, COATS, knownStatus };`
  )();
}

function loadFlock(pickerHidden = true) {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  const PRELUDE = `
    const state = { agents: [], groups: [], order: [] };
    const elAgentPicker = { hidden: ${pickerHidden},
                            classList: { contains(name) { return name === "hidden" && elAgentPicker.hidden; } } };
  `;
  return new Function(
    `${PRELUDE}${src.slice(from, to)}
     return { state, elAgentPicker, orderAgents, groupByProject, bornAt, wantsInput, projectKey };`
  )();
}

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

/* A row as the gateway sends it. `project` is the repository Herdr says the
   workspace belongs to, so a worktree cut from it carries the same one. */
function row(pane, ws, project, status, extra = {}) {
  return {
    pane_id: pane,
    workspace_id: pane.split(":")[0],
    workspace_number: ws,
    project,
    project_name: project.split("/").pop(),
    status,
    has_agent: true,
    ...extra,
  };
}

function order(agents, pickerHidden = true, held = []) {
  const f = loadFlock(pickerHidden);
  f.state.agents = agents;
  f.state.order = held;
  f.orderAgents();
  return f;
}

// -- grouping ---------------------------------------------------------------

{
  const f = order([
    row("wA:p1", 1, "/p/api", "idle"),
    row("wB:p1", 2, "/p/web", "idle"),
    row("wC:p1", 3, "/p/api", "working"),
  ]);
  check("one group per project", f.state.groups.map((g) => g.key), ["/p/api", "/p/web"]);
  check("the project names the group", f.state.groups[0].name, "api");
  check("a project's sheep are together",
        f.state.groups[0].agents.map((a) => a.pane_id), ["wA:p1", "wC:p1"]);
}

// A worktree the scheduler cut belongs to the repository it came from, not to
// a project of its own - that is the whole reason the key is the repo root.
{
  const f = order([
    row("wA:p1", 1, "/p/api", "working", { cwd: "/p/api" }),
    row("wS:p1", 7, "/p/api", "working", { cwd: "/home/.herdr/worktrees/api/sheep-task-4" }),
  ]);
  check("a sheep worktree sits under its repository", f.state.groups.length, 1);
}

// Nothing from the gateway: an older one, or a pane Herdr knows nothing about.
{
  const f = order([
    { pane_id: "wA:p1", workspace_id: "wA", workspace_number: 1, status: "idle",
      has_agent: true, cwd: "/p/api" },
  ]);
  check("the directory stands in for a missing project", f.state.groups[0].key, "/p/api");
}

// -- order inside a project -------------------------------------------------

{
  const f = order([
    row("wC:p1", 3, "/p/api", "working"),
    row("wA:p1", 1, "/p/api", "done"),
    row("wB:p1", 2, "/p/api", "idle"),
  ]);
  check("creation order, whatever the agents are doing",
        f.state.groups[0].agents.map((a) => a.pane_id), ["wA:p1", "wB:p1", "wC:p1"]);
}

{
  const f = order([
    row("wA:p1", 1, "/p/api", "done"),
    row("wB:p1", 2, "/p/api", "working"),
    row("wC:p1", 3, "/p/api", "blocked"),
  ]);
  check("a question comes first",
        f.state.groups[0].agents.map((a) => a.pane_id), ["wC:p1", "wA:p1", "wB:p1"]);
}

// Several agents in one workspace: the pane index orders them.
{
  const f = order([
    row("wA:p3", 1, "/p/api", "working"),
    row("wA:p1", 1, "/p/api", "working"),
    row("wA:p2", 1, "/p/api", "working"),
  ]);
  check("panes of one workspace keep their own order",
        f.state.groups[0].agents.map((a) => a.pane_id), ["wA:p1", "wA:p2", "wA:p3"]);
}

// A pane with no agent in it cannot be asking anything, whatever it reports.
{
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/api", "blocked", { has_agent: false }),
  ]);
  check("an empty pasture does not jump the queue",
        f.state.groups[0].agents.map((a) => a.pane_id), ["wA:p1", "wB:p1"]);
}

// -- order of the projects themselves ---------------------------------------

{
  const f = order([
    row("wB:p1", 2, "/p/web", "working"),
    row("wA:p1", 1, "/p/api", "done"),
  ]);
  check("projects in the order they were created",
        f.state.groups.map((g) => g.key), ["/p/api", "/p/web"]);
}

{
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/web", "blocked"),
    row("wC:p1", 3, "/p/cli", "done"),
  ]);
  check("a project with a question floats",
        f.state.groups.map((g) => g.key), ["/p/web", "/p/api", "/p/cli"]);
}

// Two waiting projects do not fight: creation order breaks the tie.
{
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/web", "blocked"),
    row("wC:p1", 3, "/p/cli", "blocked"),
  ]);
  check("waiting projects keep creation order between them",
        f.state.groups.map((g) => g.key), ["/p/web", "/p/cli", "/p/api"]);
}

// -- holding still under the thumb ------------------------------------------

{
  const agents = [
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/web", "blocked"),
  ];
  // The list somebody is reading was drawn before the question appeared.
  const f = order(agents, false, ["wA:p1", "wB:p1"]);
  check("an open picker does not reshuffle",
        f.state.agents.map((a) => a.pane_id), ["wA:p1", "wB:p1"]);
  check("and still draws its groups", f.state.groups.map((g) => g.key), ["/p/api", "/p/web"]);
}

{
  // A pane that appeared while you were reading joins its own project rather
  // than being stranded below every group.
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/web", "working"),
    row("wA:p2", 1, "/p/api", "working"),
  ], false, ["wA:p1", "wB:p1"]);
  check("a new pane joins its project", f.state.groups.map((g) => g.agents.map((a) => a.pane_id)),
        [["wA:p1", "wA:p2"], ["wB:p1"]]);
}

// -- what the rest of the app reads off the order ----------------------------

{
  const f = order([
    row("wB:p1", 2, "/p/web", "blocked"),
    row("wA:p1", 1, "/p/api", "working"),
  ]);
  check("the flat list follows the groups",
        f.state.agents.map((a) => a.pane_id), ["wB:p1", "wA:p1"]);
  check("and the held order is that list", f.state.order, ["wB:p1", "wA:p1"]);
}

// -- what a row says --------------------------------------------------------

/* The heading names the project, so the row must not spend its headline
   saying it again - what you are looking for is which of a project's agents
   this one is. */
{
  const { agentRowHtml } = loadRows();
  const text = (html, cls) => {
    const m = new RegExp(`<span class="${cls}">([^<]*)</span>`).exec(html);
    return m ? m[1] : null;
  };

  const plain = agentRowHtml(
    { ...row("wA:p1", 1, "/p/api", "working"), name: "api", title: "Rewrite the importer" },
    "api");
  check("the headline is what the agent is doing", text(plain, "agent-row-name"),
        "Rewrite the importer");
  check("and the project is not said twice", text(plain, "agent-row-title"), null);

  // A worktree's label is the one thing the heading did not say.
  const sheep = agentRowHtml(
    { ...row("wS:p1", 7, "/p/api", "working"), name: "sheep #4", title: "Fix the flaky test" },
    "api");
  check("a workspace named something else keeps its name",
        text(sheep, "agent-row-title"), "sheep #4");

  // A pane Herdr has no title for yet: fall back to the label, and say where.
  const fresh = agentRowHtml(
    { ...row("wN:p1", 9, "/p/api", "unknown"), name: "api", title: "", cwd: "/p/api" },
    "api");
  check("a titleless pane falls back to its name", text(fresh, "agent-row-name"), "api");
  check("and says where it is", text(fresh, "agent-row-title"), "/p/api");
}

// -- telling two sheep apart -------------------------------------------------

{
  const m = loadMarks();
  const key = (id) => {
    const marks = m.sheepMarks(id);
    return `${marks.breed.id}|${marks.horn}|${marks.coat}|${marks.muzzle}`;
  };

  /* A sheep that changes shape is not an identity, it is noise. The same pane
     has to be the same animal across a reload and a restart. */
  check("the same pane is the same sheep", key("wJ:p1"), key("wJ:p1"));

  /* Pane ids differ in one character - "wE:p1" against "wJ:p1" - which is
     exactly where a weak hash hands the whole flock one shape. */
  const ids = [];
  for (const w of ["wE", "wJ", "wM", "wP", "w11", "w12", "w13", "w2", "w3", "w4", "wA", "wB"]) {
    ids.push(`${w}:p1`, `${w}:p2`);
  }
  check("a plausible herd is nearly all distinct",
        new Set(ids.map(key)).size >= ids.length - 2, true);
  check("and grazes every breed in the book",
        new Set(ids.map((id) => m.sheepMarks(id).breed.id)).size, m.BREEDS.length);

  /* Silhouette before colour: what you recognise at this size is whether it
     has horns and whether it has been shorn, so both have to actually vary. */
  check("horns vary", new Set(ids.map((id) => m.sheepMarks(id).horn)).size, 3);
  check("coats vary", new Set(ids.map((id) => m.sheepMarks(id).coat)).size, 3);

  /* Identity is the animal; status is the row it stands in. Neither may be
     read off the other - which is the whole reason the fleece could stop
     being a status colour. */
  const working = m.sheepSvg("working", "wJ:p1");
  const blocked = m.sheepSvg("blocked", "wJ:p1");
  const breed = m.sheepMarks("wJ:p1").breed;
  check("the same sheep whatever it is doing",
        [working, blocked].map((svg) => svg.includes(breed.face)), [true, true]);
  check("and no status colour anywhere on it",
        [working, blocked].some((svg) => /#e3b341|#f85149|#3fb950|#58a6ff/.test(svg)), false);

  // A face has to stay off its own fleece, or it is not a face.
  for (const b of m.BREEDS) {
    if (b.face === b.fleece) failures.push(`FAIL ${b.id} has a face the colour of its fleece`);
  }

  /* An eye is the opposite of the face it sits in: a dark pupil on a
     black-faced Suffolk is not a subtle eye, it is no eye. */
  check("a dark face gets a pale eye", m.eyeOn("#2c3242"), "#e8edf6");
  check("a pale face gets a dark eye", m.eyeOn("#ccd4e1"), "#12161f");

  // Nobody home is nobody to tell apart.
  const empty = m.sheepSvg("unknown", "wJ:p1");
  check("an empty pasture is no animal at all",
        [empty.includes("sheep-horn"), empty.includes("sheep-face")], [false, false]);
}

// -- the row wears the status ------------------------------------------------

/* With the fleece carrying identity, the row has to carry status - and
   `blocked` is the one that must never be missed, so it gets the tint as well
   as the spine. */
{
  const rows = loadRows();
  const of = (status) => rows.agentRowHtml(
    { ...row("wA:p1", 1, "/p/api", status), name: "api", title: "Rewrite it" }, "api");

  check("a working row is marked working", of("working").includes("agent-row st-working"), true);
  check("a blocked row is marked blocked", of("blocked").includes("agent-row st-blocked"), true);
  check("an empty pane is marked unknown", of("unknown").includes("agent-row st-unknown"), true);
  check("the pill still says it too", of("blocked").includes("status-badge status-blocked"), true);

  /* The fleece colour on the wrapper is the breed's, not the status's. Two
     rows in different states must paint the same sheep. */
  const fleece = (html) => /style="color:(#[0-9a-f]{6})"/.exec(html)[1];
  check("the same sheep in either state", fleece(of("working")), fleece(of("done")));
}

// -- what is still owed ------------------------------------------------------

/* A queue you have to open the queue to see is a queue you forget you left
   running. The count belongs on the sheep it is stacked behind. */
{
  const rows = loadRows();
  rows.state.queue = [
    { id: 1, pane_id: "wA:p1", state: "waiting" },
    { id: 2, pane_id: "wA:p1", state: "waiting" },
    { id: 3, pane_id: "wA:p1", state: "failed" },
    { id: 4, pane_id: "wB:p1", state: "waiting" },
  ];
  const counts = rows.queuedByPane();
  check("waiting and failed are counted apart",
        counts.get("wA:p1"), { waiting: 2, failed: 1 });
  check("a pane with nothing queued is absent", counts.get("wC:p1"), undefined);
  check("both are said", rows.queuedLabel(counts.get("wA:p1")), "2 queued · 1 failed");
  check("a plain queue says one thing", rows.queuedLabel(counts.get("wB:p1")), "1 queued");
  check("nothing owed says nothing", rows.queuedLabel(undefined), "");

  const html = rows.agentRowHtml(
    { ...row("wA:p1", 1, "/p/api", "working"), name: "api", title: "Rewrite it" },
    "api", counts.get("wA:p1"));
  check("the row wears the count", html.includes("2 queued · 1 failed"), true);
  check("and marks it as wanting a person", html.includes("agent-row-queued failed"), true);

  const quiet = rows.agentRowHtml(
    { ...row("wC:p1", 2, "/p/api", "working"), name: "api", title: "Rewrite it" },
    "api", counts.get("wC:p1"));
  check("a sheep with an empty queue says nothing",
        quiet.includes("agent-row-queued"), false);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all flock tests passed");
