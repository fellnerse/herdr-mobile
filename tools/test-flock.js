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
   are sliced separately so this suite can ask what a row says without a DOM.
   The slice starts at the signature rather than at the first row template,
   because drawing the list is guarded by it: a rebuild that the signature does
   not notice is a heading that never changes. */
function loadRows() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf("  function agentListSignature() {");
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
  // What a tab is called is tested on its own further down; a row is asked
  // here with the real thing rather than a stub that could agree with nothing.
  const { tabName, tabNumber } = loadFlock();
  return new Function(
    "tabName",
    "tabNumber",
    `${PRELUDE}${src.slice(from, to)}
     return { state, elAgentList, agentRowHtml, renderAgentList, agentListSignature,
              queuedByPane, queuedLabel };`
  )(tabName, tabNumber);
}

/* The markings that tell two sheep on one project apart. Sliced on its own so
   the hash can be asked directly what it makes of an id. */
function loadMarks() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf("  const POSE = {");
  const to = src.indexOf("  /* Everything a row draws.");
  if (from < 0 || to < 0) throw new Error(`marks anchors moved in ${SRC}`);
  return new Function(
    `${src.slice(from, to)} return { sheepMarks, sheepSvg, eyeOn, hornOn, rimFor, isLight, BREEDS, MARKS, HORNS, HORN_KINDS, HEAD_AT, COATS, knownStatus };`
  )();
}

/* The usage strip above the flock. Sliced on its own so the wording can be
   asked for directly: it is the one part of the overview that is words rather
   than sheep, and wrong words there read as a wrong number. */
function loadUsage(quota) {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf("  /* How much subscription is left, per agent");
  const to = src.indexOf("  // Which chat a prompt is queued for");
  if (from < 0 || to < 0) throw new Error(`usage anchors moved in ${SRC}`);
  return new Function("quota", `
    const escapeHtml = (s) => String(s);
    const state = { quota };
    ${src.slice(from, to)}
    return { quotaHtml, windowLabel, resetLabel };`)(quota);
}

function loadFlock(pickerHidden = true) {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  const PRELUDE = `
    const state = { agents: [], groups: [], order: [], customOrder: [] };
    const elAgentPicker = { hidden: ${pickerHidden},
                            classList: { contains(name) { return name === "hidden" && elAgentPicker.hidden; } } };
    const store = {};
    const readPref = (name) => (name in store ? store[name] : null);
    const savePref = (key, value) => { store[key.replace("sheepit.", "")] = value; };
  `;
  return new Function(
    `${PRELUDE}${src.slice(from, to)}
     return { state, store, elAgentPicker, orderAgents, groupByProject, bornAt, wantsInput,
              projectKey, tabName, tabNumber, reorder, insertIndexFor, loadOrder, saveOrder };`
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

function order(agents, pickerHidden = true, held = [], custom = []) {
  const f = loadFlock(pickerHidden);
  f.state.agents = agents;
  f.state.order = held;
  f.state.customOrder = custom;
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

// -- another one of these ---------------------------------------------------

/* The plus on a project heading cuts a worktree, and which of the project's
   workspaces it cuts from decides where the new branch starts. */
{
  const f = order([
    row("wS:p1", 7, "/p/api", "working", { repo: true, main_checkout: false }),
    row("wA:p1", 1, "/p/api", "working", { repo: true, main_checkout: true }),
  ]);
  check("a worktree is cut from the project's own checkout", f.state.groups[0].from, "wA");
}

// Whichever order the rows arrive in: the checkout wins, not the first row.
{
  const f = order([
    row("wA:p1", 1, "/p/api", "working", { repo: true, main_checkout: true }),
    row("wS:p1", 7, "/p/api", "working", { repo: true, main_checkout: false }),
  ]);
  check("and not from a worktree that arrived after it", f.state.groups[0].from, "wA");
}

/* The checkout is not always open - a project you only ever work on in
   worktrees is the normal case for the scheduler - and Herdr resolves any of
   them to the same repository, so there is still something to cut from. */
{
  const f = order([row("wS:p1", 7, "/p/api", "working", { repo: true, main_checkout: false })]);
  check("a project open only as worktrees can still be cut from",
        f.state.groups[0].from, "wS");
}

// A directory Herdr knows no repository for has no worktree to give.
{
  const f = order([row("wH:p1", 1, "/p/notes", "idle")]);
  check("a project that is not a repository offers nothing", f.state.groups[0].from, "");
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

// -- an order a finger gave --------------------------------------------------

/* Everything above is what the phone does when left to itself. A list somebody
   arranged by hand is a different promise: the project stays where it was put,
   and it is worth more than the rules that would otherwise move it. */
{
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/web", "working"),
    row("wC:p1", 3, "/p/cli", "working"),
  ], true, [], ["/p/cli", "/p/api", "/p/web"]);
  check("a dragged order outranks creation order",
        f.state.groups.map((g) => g.key), ["/p/cli", "/p/api", "/p/web"]);
}

{
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wB:p1", 2, "/p/web", "blocked"),
  ], true, [], ["/p/api", "/p/web"]);
  check("and a question no longer drags a project to the front",
        f.state.groups.map((g) => g.key), ["/p/api", "/p/web"]);
  check("though it still rises inside its own project",
        f.state.groups[1].agents.map((a) => a.pane_id), ["wB:p1"]);
}

// A project made since the last drag is in no saved order at all; it goes
// where Herdr has just put it, which is the end.
{
  const f = order([
    row("wA:p1", 1, "/p/api", "working"),
    row("wZ:p1", 9, "/p/new", "blocked"),
    row("wB:p1", 2, "/p/web", "working"),
  ], true, [], ["/p/web", "/p/api"]);
  check("a project the order has never seen lands last",
        f.state.groups.map((g) => g.key), ["/p/web", "/p/api", "/p/new"]);
}

// A project that has since been closed is skipped rather than leaving a hole.
{
  const f = order([
    row("wB:p1", 2, "/p/web", "working"),
    row("wA:p1", 1, "/p/api", "working"),
  ], true, [], ["/p/web", "/p/gone", "/p/api"]);
  check("a closed project leaves no gap",
        f.state.groups.map((g) => g.key), ["/p/web", "/p/api"]);
}

// -- what a drag reports back -------------------------------------------------

/* Herdr counts the workspace being moved when it resolves insert_index, so an
   insertion below where it started is one slot further along. Checked against
   what actually happens to the list: inserting before the entry at that index.
   Off by one here is a project that creeps a place every time it is moved. */
{
  const f = loadFlock();
  const ids = ["a", "b", "c", "d"];
  const herdr = (from, index) => {
    const moved = ids[from];
    const before = ids.slice(0, index).filter((id) => id !== moved);
    const after = ids.slice(index).filter((id) => id !== moved);
    return [...before, moved, ...after];
  };
  for (let from = 0; from < ids.length; from++) {
    for (let to = 0; to < ids.length; to++) {
      check(
        `moving ${ids[from]} to slot ${to} tells Herdr the same thing`,
        herdr(from, f.insertIndexFor(from, to)),
        f.reorder(ids, from, to)
      );
    }
  }
  check("the phone's own reorder", f.reorder(ids, 0, 2), ["b", "c", "a", "d"]);
  check("and back the other way", f.reorder(ids, 3, 1), ["a", "d", "b", "c"]);
}

// -- the order as it is kept --------------------------------------------------

{
  const f = loadFlock();
  f.state.customOrder = ["/p/web", "/p/api"];
  f.saveOrder();
  check("the order survives a reload", f.loadOrder(), ["/p/web", "/p/api"]);

  f.store.order = "{not json";
  check("and nonsense in storage is no order at all", f.loadOrder(), []);
  f.store.order = JSON.stringify(["/p/api", 7, null]);
  check("nor is anything in it that is not a project", f.loadOrder(), ["/p/api"]);
}

// -- what a tab is called -----------------------------------------------------

/* Herdr numbers a tab before anybody names it, and the phone should agree with
   the laptop's tab bar - which draws the label, not the internal number. */
{
  const f = loadFlock();
  check("a name somebody typed is a name", f.tabName({ tab_label: "deploy" }), "deploy");
  check("a number is not", f.tabName({ tab_label: "2" }), "");
  check("and neither is Herdr's own wording", f.tabName({ tab_label: "Tab 3" }), "");
  check("a tab nobody has touched has no name", f.tabName({}), "");

  check("the number is the one the tab bar draws",
        f.tabNumber({ tab_label: "2", tab_number: 3 }), "2");
  check("falling back to Herdr's own when the label is a name",
        f.tabNumber({ tab_label: "deploy", tab_number: 3 }), "3");
  check("and to nothing at all when there is nothing",
        f.tabNumber({}), "");
}

// -- what a tab's row says ----------------------------------------------------

/* Every tab is a row now, shells included - which is the point: the row you
   want at 11pm is often the one running the dev server, and it has no agent,
   no title and nothing to say for itself but its name. */
{
  const { agentRowHtml } = loadRows();
  const text = (html, cls) => {
    const m = new RegExp(`<span class="${cls}">([^<]*)</span>`).exec(html);
    return m ? m[1] : null;
  };
  const tab = (extra) => ({
    ...row("wA:p2", 1, "/p/api", "unknown", { has_agent: false, name: "api", title: "" }),
    ...extra,
  });

  const shell = agentRowHtml(tab({ tab_label: "2", tab_number: 2, cwd: "/p/api" }), "api");
  check("a tab with no agent is called what the laptop calls it",
        text(shell, "agent-row-name"), "tab 2");
  check("and says so instead of a status it does not have",
        /<span class="agent-row-ago">shell<\/span>/.test(shell), true);
  check("with no status badge on it", /status-badge/.test(shell), false);

  const named = agentRowHtml(tab({ tab_label: "dev server", tab_number: 2 }), "api");
  check("a tab somebody named is called that", text(named, "agent-row-name"), "dev server");

  const busy = agentRowHtml(
    tab({ tab_label: "dev server", tab_number: 2, has_agent: true, status: "working",
          title: "Rewrite the importer" }),
    "api");
  check("an agent's own headline still leads", text(busy, "agent-row-name"),
        "Rewrite the importer");
  check("and the tab's name is the small line", text(busy, "agent-row-title"), "dev server");
  check("a tab with an agent says what it is doing", /status-working/.test(busy), true);

  // Each row draws its own sheep, so two tabs of one project are two animals.
  const other = agentRowHtml(
    tab({ pane_id: "wA:p3", tab_label: "3", tab_number: 3, has_agent: true, status: "blocked",
          title: "Which of these three?" }),
    "api");
  check("and each row wears the status of its own tab",
        [/sheep-wrap working/.test(busy), /sheep-wrap blocked/.test(other)], [true, true]);
}

// -- what a project's heading offers -----------------------------------------

/* The heading is the only thing on this screen that names a project, so it is
   where "another one of these" has to live. */
{
  const r = loadRows();
  const group = (extra) => ({
    key: "/p/api", name: "api", from: "wA",
    agents: [{ ...row("wA:p1", 1, "/p/api", "working"), name: "api", title: "Rewrite it" }],
    ...extra,
  });
  const draw = (g) => {
    r.state.groups = [g];
    r.state.listSignature = null;
    r.renderAgentList();
    return r.elAgentList.innerHTML;
  };

  const repo = draw(group());
  check("a repository's heading offers another worktree",
        /class="agent-group-add"/.test(repo), true);
  check("and says which project it would cut",
        /data-action="worktree" data-project="\/p\/api"/.test(repo), true);
  check("a project with nothing to cut from does not",
        /agent-group-add/.test(draw(group({ from: "" }))), false);

  /* The list is redrawn only when its signature moves, so a project that
     becomes a repository - its checkout opened on the laptop a moment ago -
     has to be a change the signature notices. */
  r.state.groups = [group()];
  const withPlus = r.agentListSignature();
  r.state.groups = [group({ from: "" })];
  check("the plus is part of what redraws the list",
        withPlus === r.agentListSignature(), false);
}

// -- a row with something waiting behind it ----------------------------------

/* A prompt typed and not yet handed over is the row's state as much as the
   agent's: an agent working with two prompts stacked behind it is a different
   thing to look at than one that is merely working. The counting is checked
   further down; this is the row actually carrying it. */
{
  const rows = loadRows();
  const busy = () => ({ ...row("wA:p1", 1, "/p/api", "working"), name: "api",
                        title: "Rewrite the importer" });
  const drawn = (queue) => {
    rows.state.queue = queue;
    return rows.agentRowHtml(busy(), "api", rows.queuedByPane().get("wA:p1"));
  };

  check("a chat with nothing waiting says nothing",
        /agent-row-queued/.test(drawn([])), false);

  const waiting = drawn([
    { id: 1, pane_id: "wA:p1", state: "waiting" },
    { id: 2, pane_id: "wA:p1", state: "waiting" },
  ]);
  /* What the agent is doing is already the spine and the pose, so the one word
     beside the row is the more useful one: an agent that finished with a prompt
     still waiting is not "done", it is one prompt from starting again. */
  check("two waiting prompts are the row's word", />2 queued</.test(waiting), true);
  check("and the agent's own word steps aside", /status-working/.test(waiting), false);
  check("drawn as work you stacked rather than work it is doing",
        /status-badge status-queued/.test(waiting), true);

  // Another chat's queue is not this row's business.
  check("a prompt for another chat is not drawn here",
        /agent-row-queued/.test(drawn([{ id: 3, pane_id: "wB:p1", state: "waiting" }])), false);

  // One that could not be delivered is not waiting for a window; it is waiting
  // for you, and the row marks it apart.
  const failed = drawn([
    { id: 4, pane_id: "wA:p1", state: "waiting" },
    { id: 5, pane_id: "wA:p1", state: "failed" },
  ]);
  check("a failed prompt is said as well", />1 queued · 1 failed</.test(failed), true);
  check("in red, because it is waiting for you rather than for a window",
        /status-badge status-failed/.test(failed), true);

  /* Except when the agent has stopped on a question. Nothing is ever delivered
     into that, and it is the state that must never be buried under a count. */
  const asking = (queue) => {
    rows.state.queue = queue;
    return rows.agentRowHtml(
      { ...row("wA:p1", 1, "/p/api", "blocked"), name: "api", title: "Which of these?" },
      "api", rows.queuedByPane().get("wA:p1"));
  };
  check("a question outranks the queue behind it",
        /status-blocked">blocked</.test(asking([{ id: 6, pane_id: "wA:p1", state: "waiting" }])),
        true);
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

  /* Lightness alone cannot separate the dark end of the palette: at 44 pixels
     charcoal, black and a dark badger grey are one animal three times. Hue can
     - a brown sheep is nobody's black sheep - so the rule is about dark
     *neutrals* specifically, and at most one of those may be a plain colour.
     The rest have to carry a pattern, which is what stops a fourth dark grey
     being quietly added later. */
  const shade = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
    return {
      light: r * 0.299 + g * 0.587 + b * 0.114,
      chroma: Math.max(r, g, b) - Math.min(r, g, b),
    };
  };
  const plainDark = m.BREEDS.filter((b) => {
    const { light, chroma } = shade(b.fleece);
    return light < 110 && chroma < 45 && !b.mark;
  });
  check("only one plain dark neutral", plainDark.map((b) => b.id), ["black"]);

  // A pattern with no second colour is a pattern nobody can see.
  for (const b of m.BREEDS) {
    if (b.mark && !b.patch) failures.push(`FAIL ${b.id} has a pattern and no colour for it`);
    if (b.mark && !m.MARKS[b.mark]) failures.push(`FAIL ${b.id} wears a pattern nothing draws`);
  }

  /* The pattern is clipped to the body, and a clip is referenced by id - so
     two sheep drawn into one list must not share one, or the second wears the
     first one's shape. */
  const idOf = (svg) => (/<clipPath id="([^"]+)"/.exec(svg) || [])[1];
  const patterned = m.BREEDS.find((b) => b.mark).id;
  const seedFor = ["wA:p1", "wB:p1", "wC:p1", "wD:p1", "wE:p1", "wF:p1", "wG:p1", "wH:p1"]
    .find((id) => m.sheepMarks(id).breed.mark);
  if (seedFor) {
    const first = m.sheepSvg("idle", seedFor);
    const second = m.sheepSvg("idle", seedFor);
    check("a pattern is clipped to the body", first.includes("clip-path=\"url(#"), true);
    check("and no two drawings share a clip", idOf(first) === idOf(second), false);
  } else {
    failures.push(`FAIL no test seed draws a patterned breed (${patterned})`);
  }

  // A face has to stay off its own fleece, or it is not a face.
  for (const b of m.BREEDS) {
    if (b.face === b.fleece) failures.push(`FAIL ${b.id} has a face the colour of its fleece`);
  }

  /* An eye is the opposite of the face it sits in: a dark pupil on a
     black-faced Suffolk is not a subtle eye, it is no eye. */
  check("a dark face gets a pale eye", m.eyeOn("#2c3242"), "#e8edf6");
  check("a pale face gets a dark eye", m.eyeOn("#ccd4e1"), "#12161f");

  /* The same rule for horns, and it is the one the first version broke: bone
     drawn on a white fleece is a horn nobody can see. */
  check("a pale sheep gets a dark horn", m.hornOn("#eef1f6"), "#4a4235");
  check("a dark sheep gets a bone one", m.hornOn("#2f3543"), "#e4d9bd");
  for (const b of m.BREEDS) {
    if (m.hornOn(b.fleece) === b.fleece) failures.push(`FAIL ${b.id} wears an invisible horn`);
  }

  /* The rim is what keeps a dark animal off a dark card - so a dark breed must
     carry its own, and a pale one must not (it would outline a white sheep in
     white). The card colour cannot separate anything from the card. */
  const CARD = "#181c26";
  for (const b of m.BREEDS) {
    const rim = m.rimFor(b.fleece);
    if (m.isLight(b.fleece) && rim) failures.push(`FAIL ${b.id} is pale and rimmed anyway`);
    if (!m.isLight(b.fleece) && !rim) failures.push(`FAIL ${b.id} is dark with no rim`);
    if (rim === CARD) failures.push(`FAIL ${b.id} is rimmed in the card's own colour`);
  }
  check("a dark sheep's rim is lighter than it is",
        m.isLight("#2f3543"), false);

  /* A horn that does not leave the fleece changes no outline, and an outline is
     the whole reason horns are the first cue. This has now been got wrong
     twice - once by drawing them inside the silhouette, once by keeping the
     same placement for the poses where the head is *down*, where curling up
     off a lowered skull curls straight into the body. So the placements are
     read out of the drawing and checked, rather than trusted.

     The body shapes below mirror the woolly coat in `sheepBody`; they are the
     silhouette the horn has to escape. */
  const BODY = [[11.5, 16, 7.5], [18, 11, 8], [25.5, 11.5, 7.5], [31, 16, 7]];
  const BARREL = [5, 13, 32, 26];

  function hornPoints(path, [bx, by, rotate]) {
    const nums = path.slice(1).trim().split(/[c\s,]+/).filter(Boolean).map(Number);
    let [x, y] = [nums[0], nums[1]];
    const local = [[x, y]];
    for (let i = 2; i + 5 < nums.length; i += 6) {
      const [x1, y1, x2, y2, x3, y3] = nums.slice(i, i + 6);
      const p = [[x, y], [x + x1, y + y1], [x + x2, y + y2], [x + x3, y + y3]];
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const u = 1 - t;
        local.push([
          u ** 3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t ** 3 * p[3][0],
          u ** 3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t ** 3 * p[3][1],
        ]);
      }
      [x, y] = p[3];
    }
    const rad = (rotate * Math.PI) / 180;
    return local.map(([lx, ly]) => [
      bx + lx * Math.cos(rad) - ly * Math.sin(rad),
      by + lx * Math.sin(rad) + ly * Math.cos(rad),
    ]);
  }

  const inFleece = ([x, y], dy) =>
    BODY.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy - dy) ** 2 <= r * r) ||
    (x >= BARREL[0] && x <= BARREL[2] && y - dy >= BARREL[1] && y - dy <= BARREL[3]);

  for (const [pose, at] of Object.entries(m.HEAD_AT)) {
    const dy = pose === "sleep" ? 5 : 0;
    for (const kind of ["curl", "spiral"]) {
      const pts = hornPoints(m.HORNS[kind], at.horn);
      const outside = pts.filter((p) => !inFleece(p, dy)).length / pts.length;
      if (outside < 0.5) {
        failures.push(`FAIL a ${kind} horn on a ${pose}ing sheep is ${Math.round(outside * 100)}% outside the fleece`);
      }
      if (pts.some(([x, y]) => x < 0 || x > 44 || y < 0 || y > 34)) {
        failures.push(`FAIL a ${kind} horn on a ${pose}ing sheep leaves the canvas`);
      }
    }
  }

  /* Every cue has to change the drawing, and this is the one that went wrong:
     the horns were there in the markup and invisible on the sheep. Find two
     seeds that differ in exactly one axis and check the pictures differ too. */
  const twinsDiffering = (axis) => {
    const seeds = [];
    for (let i = 0; i < 4000; i++) seeds.push(`w${i}:p1`);
    for (const a of seeds) {
      const x = m.sheepMarks(a);
      for (const b of seeds) {
        const y = m.sheepMarks(b);
        if (a === b || x[axis] === y[axis]) continue;
        const rest = ["breed", "horn", "coat", "muzzle"].filter((k) => k !== axis);
        if (rest.every((k) => x[k] === y[k])) return [a, b];
      }
    }
    return null;
  };

  for (const axis of ["horn", "coat"]) {
    const pair = twinsDiffering(axis);
    if (!pair) {
      failures.push(`FAIL no two seeds differ only in ${axis}`);
      continue;
    }
    const [a, b] = pair;
    const strip = (svg) => svg.replace(/id="fleece-\d+"|url\(#fleece-\d+\)/g, "");
    check(`${axis} changes the animal`, strip(m.sheepSvg("idle", a)) === strip(m.sheepSvg("idle", b)), false);
  }

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
  check("in the place the status word had", html.includes("status-badge status-failed"), true);
  check("and the status word steps aside for it", /status-working/.test(html), false);

  const quiet = rows.agentRowHtml(
    { ...row("wC:p1", 2, "/p/api", "working"), name: "api", title: "Rewrite it" },
    "api", counts.get("wC:p1"));
  check("a sheep with an empty queue says nothing",
        quiet.includes("agent-row-queued"), false);
}

// -- what is left to spend ---------------------------------------------------

/* A window is a percentage and a time, and the time is half the answer: "87%"
   means something different on Tuesday than it does an hour before it resets.
   The strip says both, in as few characters as will still carry them. */
{
  const soon = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const gone = new Date(Date.now() - 3600 * 1000).toISOString();
  const week = new Date(Date.now() + 5 * 86400 * 1000).toISOString();

  const u = loadUsage({
    threshold: 85,
    agents: [{
      agent: "claude", ok: true, blocked: false, buckets: [
        { name: "five_hour", utilization: 74, resets_at: soon, spent: false, warning: false, expired: false },
        { name: "seven_day", utilization: 9, resets_at: week, spent: false, warning: false, expired: false },
        { name: "seven_day_opus", utilization: 0, resets_at: null, spent: false, warning: false, expired: false },
      ],
    }],
  });

  const html = u.quotaHtml();
  check("the agent is named", /class="usage-agent">Claude</.test(html), true);
  /* Both windows run out independently, so both get a bar: a five hour window
     that is fine says nothing about a weekly one that is nearly gone. */
  check("every window it has gets its own bar",
        (html.match(/class="usage-bar"/g) || []).length, 2);
  check("each filled to its own mark",
        [/width:74%/.test(html), /width:9%/.test(html)], [true, true]);
  check("and labelled with which window it is",
        [/class="usage-label">5h</.test(html), /class="usage-label">week</.test(html)],
        [true, true]);
  // A plan slot this account does not use is not a window at zero percent.
  check("an empty slot is not drawn", /opus/.test(html), false);

  check("five hours is 5h", u.windowLabel("five_hour"), "5h");
  check("seven days is a week", u.windowLabel("seven_day"), "week");
  check("and a window Codex invents later still reads", u.windowLabel("3_hour"), "3h");

  /* A reset you could sit and wait for is a time - the small hours of tomorrow
     included, which is where a five hour window started in the evening lands.
     A reset days away is a date. */
  const hours = (n) => new Date(Date.now() + n * 3600 * 1000).toISOString();
  check("a reset in three hours is a time",
        /^\d{1,2}[:.]\d{2}/.test(u.resetLabel(hours(3))), true);
  check("so is one in the small hours of tomorrow",
        /^\d{1,2}[:.]\d{2}/.test(u.resetLabel(hours(9))), true);
  check("a reset next week carries its date", /^\d{1,2}\.\d{1,2}\./.test(u.resetLabel(week)), true);
  check("and nothing is nothing", u.resetLabel(null), "");

  /* A window with anything left in it is yours to spend, so there is nothing
     to explain and nothing to warn about - the bar says it. */
  check("a window that has room says nothing else", /quota-note/.test(html), false);
  check("and no threshold is ever explained", /80%|85%/.test(html), false);
  check("nor is the word resets spent on it", /resets/.test(html), false);

  // A window that has already come back is not at the percentage it was: the
  // strip must not draw a full bar for a wall that is gone.
  const rolled = loadUsage({
    threshold: 85,
    agents: [{
      agent: "codex", ok: true, blocked: false, buckets: [
        { name: "five_hour", utilization: 98, resets_at: gone, spent: false, warning: true, expired: true },
        { name: "seven_day", utilization: 40, resets_at: week, spent: false, warning: false, expired: false },
      ],
    }],
  }).quotaHtml();
  check("an expired window shows no percentage",
        /class="usage-window past">[\s\S]*?class="usage-pct">—/.test(rolled), true);
  check("and draws an empty bar rather than the old one", /width:0%/.test(rolled), true);
  check("the window still running keeps its own", /width:40%/.test(rolled), true);

  const out = loadUsage({
    threshold: 85,
    agents: [{
      agent: "claude", ok: true, blocked: true, resume_at: soon, buckets: [
        { name: "five_hour", utilization: 100, resets_at: soon, spent: true, warning: true, expired: false },
        { name: "seven_day", utilization: 40, resets_at: week, spent: false, warning: false, expired: false },
      ],
    }],
  }).quotaHtml();
  /* A window with nothing left says so on the time it comes back, which is the
     only part worth reading - and says nothing else. A sentence underneath was
     both noise and, when it was wrong, alarming. */
  check("a window with nothing left is marked out",
        /class="usage-window out"/.test(out), true);
  check("the window that still has room is not marked",
        (out.match(/usage-window out/g) || []).length, 1);
  check("and nothing is said underneath", /quota-note/.test(out), false);
  check("its bar is full", /class="usage-window out">[\s\S]*?width:100%/.test(out), true);

  // An agent nobody can price keeps delivering, so the strip does not shout.
  const unknown = loadUsage({
    threshold: 85,
    agents: [{ agent: "gemini", ok: false, error: "no usage to read for gemini", buckets: [] }],
  }).quotaHtml();
  check("an unreadable agent explains itself quietly",
        /usage-detail muted">no usage to read for gemini/.test(unknown), true);
  check("and is not drawn as blocked", /blocked/.test(unknown), false);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all flock tests passed");
