#!/usr/bin/env node
/* Diff rendering tests: node tools/test-diff.js
 *
 * The changed-files view reads a patch and draws it twice: unified, which
 * keeps the file's order, and side by side, which has to decide which removal
 * a given addition replaced. That pairing is the only judgement in it, and
 * getting it wrong puts a line opposite the wrong line - which reads as a
 * change nobody made.
 *
 * As with the transcript tests, app.js is a browser script with no exports,
 * so the functions are sliced out between two anchors and evaluated alone.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  function statusLabel(file)";
const TO = "  elBtnChanges.addEventListener";

const PRELUDE = `
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  const state = { diffSplit: false, activePaneId: "w1:p1", changedFiles: {} };
  const el = () => ({
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, textContent: "", innerHTML: "",
    querySelectorAll: () => [], addEventListener() {},
  });
  const elChangesList = el();
  const elChangesSub = el();
  const elChangesCount = el();
  const elChangesView = el();
  const elBtnDiffLayout = el();
  function savePref() {}
  function triggerHaptic() {}
`;

function loadDiff() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  return new Function(
    `${PRELUDE}${src.slice(from, to)}
     return { parsePatch, numberedRows, renderPatch, renderUnifiedRows,
              renderSplitRows, statusLabel, imageSides, imageDiffHtml,
              imageUrl, state };`
  )();
}

const d = loadDiff();

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

// ---------------------------------------------------------------------------

const PATCH = [
  "diff --git a/gateway/server.py b/gateway/server.py",
  "index da48382..0ac6834 100755",
  "--- a/gateway/server.py",
  "+++ b/gateway/server.py",
  "@@ -18,6 +18,8 @@ from http import HTTPStatus",
  " from http.server import ThreadingHTTPServer",
  " ",
  " import push",
  "+import gitdiff",
  "+import wsproto",
  " ",
  "@@ -40,7 +42,7 @@ def call_herdr_rpc(method):",
  " def call_herdr_rpc(method):",
  '-    """Old docstring."""',
  '+    """New docstring."""',
  "     pass",
  "\\ No newline at end of file",
].join("\n");

// -- the parse --------------------------------------------------------------

const hunks = d.parsePatch(PATCH);
check("two hunks", hunks.length, 2);
check("hunk heading", hunks[0].heading, "from http import HTTPStatus");
check("preamble is not a hunk line", hunks[0].lines.length, 6);
check(
  "kinds in order",
  hunks[0].lines.map((l) => l.kind),
  ["ctx", "ctx", "ctx", "add", "add", "ctx"]
);
check(
  '"\\ No newline" is not a context line',
  hunks[1].lines.map((l) => l.kind),
  ["ctx", "del", "add", "ctx"]
);

// -- line numbers -----------------------------------------------------------

const rows = d.numberedRows(hunks[0]);
check(
  "old numbers skip additions",
  rows.map((r) => r.oldNo),
  [18, 19, 20, null, null, 21]
);
check(
  "new numbers count them",
  rows.map((r) => r.newNo),
  [18, 19, 20, 21, 22, 23]
);
const rows2 = d.numberedRows(hunks[1]);
check(
  "a replacement advances both sides once",
  rows2.map((r) => [r.oldNo, r.newNo]),
  [[40, 42], [41, null], [null, 43], [42, 44]]
);

// -- side by side -----------------------------------------------------------

/* The pairing is what this file exists for: a run of removals sits opposite
   the run of additions that replaced it, one to one, and the shorter side is
   padded rather than sliding the rest of the file out of line. */
function sides(html) {
  return [...html.matchAll(/<div class="diff-side ([a-z]+)">(?:<span class="diff-no">([^<]*)<\/span>)?/g)]
    .map((m) => `${m[1]}:${m[2] || ""}`);
}

const replacement = d.renderSplitRows(rows2);
const columns = replacement.split('<div class="diff-col">');
check("two columns", columns.length - 1, 2);
// One line replaced by one line: they sit opposite each other, no padding.
check("left column is the old file", sides(columns[1]), ["ctx:40", "del:41", "ctx:42"]);
check("right column is the new one", sides(columns[2]), ["ctx:42", "add:43", "ctx:44"]);

// Two removals replaced by one addition: the second removal faces a pad, and
// the context line after them stays level on both sides.
const uneven = d.numberedRows(
  d.parsePatch(["@@ -1,3 +1,2 @@", "-one", "-two", "+merged", " tail"].join("\n"))[0]
);
const unevenColumns = d.renderSplitRows(uneven).split('<div class="diff-col">');
check("uneven left", sides(unevenColumns[1]), ["del:1", "del:2", "ctx:3"]);
check("uneven right", sides(unevenColumns[2]), ["add:1", "pad:", "ctx:2"]);

// -- unified ----------------------------------------------------------------

d.state.diffSplit = false;
const unified = d.renderPatch(PATCH);
check("unified draws every line", (unified.match(/class="diff-line/g) || []).length, 10);
check("unified has no columns", unified.includes("diff-col"), false);

d.state.diffSplit = true;
const split = d.renderPatch(PATCH);
check("split draws columns", (split.match(/class="diff-col"/g) || []).length, 4);
d.state.diffSplit = false;

// A patch with nothing in it is a real answer for a mode change or a rename.
check(
  "an empty patch says so",
  d.renderPatch("diff --git a/x b/x\nsimilarity index 100%\n").includes("No textual change"),
  true
);

// -- escaping ---------------------------------------------------------------

/* File contents reach the DOM as HTML here, so a line of code that looks like
   markup has to arrive as text. */
const hostile = d.renderPatch(
  ['@@ -1,1 +1,1 @@', '-<script>alert(1)</script>', '+<img onerror="x">'].join("\n")
);
check("no live tag from the old side", hostile.includes("<script>"), false);
check("no live tag from the new side", hostile.includes('<img onerror'), false);
check("the text is still there", hostile.includes("&lt;script&gt;alert(1)"), true);

// -- status words -----------------------------------------------------------

check("untracked reads as new", d.statusLabel({ untracked: true, index_status: "?", worktree_status: "?" }), "new");
check("modified", d.statusLabel({ index_status: "", worktree_status: "M" }), "modified");
check("deleted", d.statusLabel({ index_status: "D", worktree_status: "" }), "deleted");
check("renamed", d.statusLabel({ index_status: "R", worktree_status: "" }), "renamed");

// -- pictures ---------------------------------------------------------------

/* A patch for a PNG says "Binary files differ", so an image is drawn instead:
   HEAD on one side, the working tree on the other, and only the sides that
   still exist. */
{
  const modified = d.imageDiffHtml({
    path: "web/icon.png", old_path: "", untracked: false,
    index_status: "", worktree_status: "M", image: "image/png",
  });
  check("a modified image shows both sides",
        (modified.match(/diff-shot-img/g) || []).length, 2);
  check("the before comes from HEAD", modified.includes("side=head"), true);
  check("the after comes from the working tree", modified.includes("side=work"), true);
  check("and they sit side by side", modified.includes("diff-images two"), true);
}

{
  const added = d.imageDiffHtml({
    path: "shot.png", old_path: "", untracked: true,
    index_status: "?", worktree_status: "?", image: "image/png",
  });
  check("a new image has no before",
        (added.match(/diff-shot-img/g) || []).length, 1);
  check("only the working tree", added.includes("side=work"), true);
  check("staged and new is still new",
        d.imageSides({ untracked: false, index_status: "A", worktree_status: "" }),
        { before: false, after: true });
}

{
  const gone = d.imageDiffHtml({
    path: "old.png", old_path: "", untracked: false,
    index_status: "", worktree_status: "D", image: "image/png",
  });
  check("a deleted image has no after", gone.includes("side=work"), false);
  check("but it still has a before", gone.includes("side=head"), true);
}

// A rename's before is the name the file used to have.
{
  const moved = d.imageDiffHtml({
    path: "img/new.png", old_path: "img/old.png", untracked: false,
    index_status: "R", worktree_status: "", image: "image/png",
  });
  check("the before is fetched under the old name",
        moved.includes(encodeURIComponent("img/old.png")), true);
  check("and the after under the new one",
        moved.includes(encodeURIComponent("img/new.png")), true);
}

// A path is a path, not markup, and it reaches the DOM as an attribute.
{
  const hostile = d.imageDiffHtml({
    path: 'a"><img src=x onerror=alert(1)>.png', old_path: "", untracked: true,
    index_status: "?", worktree_status: "?", image: "image/png",
  });
  check("a hostile path cannot break out of the src",
        hostile.includes("onerror=alert(1)>"), false);
}

// ---------------------------------------------------------------------------

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all diff tests passed");
