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

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all flock tests passed");
