#!/usr/bin/env node
/* Focus tests: node tools/test-focus.js
 *
 * The first tap on send, or on back, while the keyboard was up only ever put
 * the keyboard away: the tap blurred the text box, the layout grew back, and
 * the button moved out from under the finger before the click landed. Fixed
 * once for the send button alone, then for every button - and it came back
 * anyway, for a tap on the edge of send that iOS lands in the gap beside it.
 *
 * What has to hold is that nothing in the dock around the composer takes
 * focus from the text box, that a button anywhere keeps it through its click,
 * and that a button outside the dock lets it go afterwards. Like test-attach,
 * this loads web/composer.js whole against a stubbed page; the page here is a
 * small tree shaped like index.html's, with a selector matcher just big enough
 * for the selectors keepFocus uses.
 */

const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "web");

/* ---- A page, as much of one as keepFocus touches. */
function matchesOne(el, sel) {
  sel = sel.trim();
  const nots = [];
  sel = sel.replace(/:not\(([^)]*)\)/g, (_, inner) => { nots.push(inner); return ""; });
  const m = sel.match(/^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+=[\w-]+\])*)$/);
  if (!m) throw new Error("selector the stub cannot read: " + sel);
  const [, tag, classes, attrs] = m;
  if (tag && el.tag !== tag) return false;
  for (const c of classes.split(".").filter(Boolean)) if (!el.classes.includes(c)) return false;
  for (const a of attrs.match(/\[[\w-]+=[\w-]+\]/g) || []) {
    const [, k, v] = a.match(/\[([\w-]+)=([\w-]+)\]/);
    if (el.attrs[k] !== v) return false;
  }
  return !nots.some((n) => matchesOne(el, n));
}

function el(tag, { classes = [], attrs = {} } = {}, ...children) {
  const node = {
    tag, classes, attrs, parent: null, children,
    matches(sel) { return sel.split(",").some((s) => matchesOne(node, s)); },
    closest(sel) {
      for (let n = node; n; n = n.parent) if (n.matches(sel)) return n;
      return null;
    },
    contains(other) {
      for (let n = other; n; n = n.parent) if (n === node) return true;
      return false;
    },
    blur() { if (page.doc.activeElement === node) page.doc.activeElement = page.body; },
  };
  children.forEach((c) => { c.parent = node; });
  return node;
}

let page;
function build() {
  const back = el("button", { attrs: { id: "back" } });
  const sendIcon = el("svg");
  const send = el("button", { classes: ["btn-send"] }, sendIcon);
  const attach = el("button", { classes: ["btn-attach"] });
  const actions = el("div", { classes: ["prompt-actions"] }, attach, send);
  const input = el("textarea", { classes: ["prompt-input"] });
  const chip = el("button", { classes: ["complete-chip"] });
  const dock = el("footer", { classes: ["input-dock"] },
    el("div", { classes: ["complete-bar"] }, chip),
    el("div", { classes: ["prompt-form", "composer"] }, input, actions));
  const rename = el("input", { attrs: { type: "text" } });
  const save = el("button", { attrs: { id: "save" } });
  const sheet = el("div", { classes: ["sheet"] }, rename, save);
  const xtermBox = el("textarea", { classes: ["xterm-helper-textarea"] });
  const key = el("button", { classes: ["console-key"] });
  const term = el("div", { classes: ["xterm"] }, xtermBox);
  const body = el("body", {}, el("header", {}, back), dock, sheet, term, key);

  const listeners = {};
  const doc = {
    activeElement: body,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const later = [];
  page = { doc, body, back, send, sendIcon, attach, actions, input, chip, dock, rename, save, xtermBox, key, later };

  const src = fs.readFileSync(path.join(WEB, "composer.js"), "utf8");
  const windowStub = {};
  new Function("window", "document", "URL", "createImageBitmap", "navigator", src)(
    windowStub, doc, {}, async () => ({}), {}
  );
  windowStub.SheepItComposer.keepFocus(doc, (fn) => later.push(fn));

  /* A tap as the browser sends it; true when its default - the blur - was
     cancelled. `click` runs the queued afterwards too. */
  page.fire = (type, target) => {
    let prevented = false;
    for (const fn of listeners[type] || []) fn({ target, preventDefault() { prevented = true; } });
    if (type === "click") page.later.splice(0).forEach((fn) => fn());
    return prevented;
  };
  return page;
}

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${expected}\n  actual   ${actual}`);
}

/* A whole tap: down, and if the blur was not cancelled, the blur, then the
   click. Returns whether the text box still has focus afterwards. */
function tap(p, target) {
  const held = p.fire("pointerdown", target) && p.fire("mousedown", target);
  if (!held && target !== p.doc.activeElement) p.doc.activeElement = p.body;
  p.fire("click", target);
  return p.doc.activeElement;
}

{
  const p = build();
  p.doc.activeElement = p.input;
  check("send keeps focus on pointerdown", p.fire("pointerdown", p.send), true);
  check("send keeps focus on mousedown", p.fire("mousedown", p.send), true);
  check("a tap on send's icon is a tap on send", p.fire("pointerdown", p.sendIcon), true);
  check("send leaves the keyboard up", tap(p, p.send), p.input);
}
{
  const p = build();
  p.doc.activeElement = p.input;
  // The regression: iOS lands a tap on send's edge in the gap beside it.
  check("a tap in the gap beside send keeps focus", p.fire("pointerdown", p.actions), true);
  check("so does one on the dock itself", p.fire("pointerdown", p.dock), true);
  check("a completion keeps the keyboard up", tap(p, p.chip), p.input);
  check("attach keeps the keyboard up", tap(p, p.attach), p.input);
}
{
  const p = build();
  p.doc.activeElement = p.input;
  check("tapping the text box itself is left alone", p.fire("pointerdown", p.input), false);
}
{
  const p = build();
  p.doc.activeElement = p.input;
  check("back keeps focus until its click lands", p.fire("pointerdown", p.back), true);
  check("and lets the keyboard go after it", tap(p, p.back), p.body);
}
{
  const p = build();
  p.doc.activeElement = p.rename;
  check("a sheet's own button keeps its field focused for the click", p.fire("pointerdown", p.save), true);
}
{
  const p = build();
  p.doc.activeElement = p.input;
  p.fire("pointerdown", p.back);
  p.doc.activeElement = p.rename; // what the click opened took focus itself
  p.fire("click", p.back);
  check("focus moved by the click is not taken back", p.doc.activeElement, p.rename);
}
{
  const p = build();
  check("nothing is held while nobody is typing", p.fire("pointerdown", p.back), false);
}
{
  const p = build();
  p.doc.activeElement = p.xtermBox;
  check("the console's key bar is left to itself", p.fire("pointerdown", p.key), false);
}

/* And the page these stubs stand in for: send must actually sit inside the
   dock, and app.js must actually switch this on. */
{
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const dock = html.slice(html.indexOf('class="input-dock"'), html.indexOf("</footer>"));
  check("index.html: the send button is inside .input-dock", dock.includes('id="btn-send"'), true);
  check("index.html: the composer is inside .input-dock", dock.includes('id="prompt-input"'), true);
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  check("app.js: keepFocus is switched on for the page", app.includes("SheepItComposer.keepFocus(document)"), true);
  check("app.js: no button-only focus guard of its own", /addEventListener\("pointerdown", \(e\) => \{\s*if \(typingIn\(\)/.test(app), false);
}

if (failures) {
  console.log(`\n${failures} focus test(s) failed`);
  process.exit(1);
}
console.log("all focus tests passed");
