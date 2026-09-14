#!/usr/bin/env node
/* Attachment tests: node tools/test-attach.js
 *
 * Sending a screenshot is two halves. The gateway's half - where the file
 * lands, what it is called, what git makes of it - is in test-gateway.py. This
 * is the phone's half, and what it has to get right is that the composer's
 * text and the strip of thumbnails above it can never disagree about what is
 * being sent: the text is the attachment, and the pictures are drawn from it.
 *
 * Sliced out of app.js between two anchors, like the other suites, with the
 * composer and the network stubbed.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  // Long edge of what gets uploaded.";
const TO = "  /* ------------------------------------------------------------- Queue --- */";

function load() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  const PRELUDE = `
    const state = { activePaneId: "wA:p1" };
    const drawn = [];
    const elPromptInput = {
      value: "", selectionStart: 0,
      setSelectionRange(a) { this.selectionStart = a; },
      focus() {}, addEventListener() {},
    };
    const listener = { addEventListener() {} };
    const elAttachStrip = { ...listener, innerHTML: "", classList: { add() {}, remove() {} } };
    const elBtnAttach = { ...listener, classList: { toggle() {} }, disabled: false };
    const elAttachInput = { ...listener, click() {} };
    const elConsoleView = { classList: { contains: () => true } };
    const document = { addEventListener() {}, activeElement: null };
    const URL = { createObjectURL: () => "blob:stub", revokeObjectURL() {} };
    const escapeHtml = (s) => String(s);
    function autoResizeTextarea() {}
    function rememberDraft() {}
    function triggerHaptic() {}
  `;
  return new Function(
    `${PRELUDE}${src.slice(from, to)}
     return { imagesIn, insertAttachment, attachedPaths, dropAttachment,
              renderAttachments, attachUrls, elPromptInput, elAttachStrip };`
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

// A clipboard or a drag, in the two shapes browsers hand them over in.
const asItems = (...types) => ({
  items: types.map((type) => ({
    kind: type === null ? "string" : "file",
    type: type || "text/plain",
    getAsFile: () => (type ? { type, name: "x" } : null),
  })),
  files: [],
});
const asFiles = (...types) => ({ items: [], files: types.map((type) => ({ type })) });

// -- what came in on the clipboard -------------------------------------------

{
  const a = load();

  check("an image among the items is found",
        a.imagesIn(asItems("image/png")).length, 1);
  check("Safari's files list is read too",
        a.imagesIn(asFiles("image/jpeg")).length, 1);
  check("both lists together are not counted twice",
        a.imagesIn({ items: asItems("image/png").items, files: [{ type: "image/png" }] }).length, 1);

  /* Pasting text has to stay pasting text. Claiming a paste that carries no
     picture would swallow every prompt anybody ever copied. */
  check("plain text is left alone", a.imagesIn(asItems(null)).length, 0);
  check("a non-image file is not an image", a.imagesIn(asFiles("application/pdf")).length, 0);
  check("nothing at all is nothing", a.imagesIn(null).length, 0);

  // Several screenshots at once are several attachments.
  check("two images are two", a.imagesIn(asItems("image/png", "image/heic")).length, 2);
}

// -- the path in the composer ------------------------------------------------

{
  const a = load();

  a.insertAttachment(".sheepit/one.png");
  check("the path goes in as an @mention",
        a.elPromptInput.value, "@.sheepit/one.png ");
  check("and the caret follows it",
        a.elPromptInput.selectionStart, "@.sheepit/one.png ".length);

  // Typed text, then a paste: the two must not run together into one token.
  a.elPromptInput.value = "why is this";
  a.elPromptInput.selectionStart = "why is this".length;
  a.insertAttachment(".sheepit/two.png");
  check("a space is kept from the word before it",
        a.elPromptInput.value, "why is this @.sheepit/two.png ");

  // Pasting into the middle of a sentence puts it where the caret was, with
  // one space on each side rather than two on the right.
  a.elPromptInput.value = "before after";
  a.elPromptInput.selectionStart = 6;
  a.insertAttachment(".sheepit/three.png");
  check("it lands at the caret", a.elPromptInput.value, "before @.sheepit/three.png after");
}

// -- the strip follows the text ----------------------------------------------

{
  const a = load();
  a.elPromptInput.value = "look at @.sheepit/a.png and @.sheepit/b.png please";
  check("every attached path is found",
        a.attachedPaths(), [".sheepit/a.png", ".sheepit/b.png"]);

  /* The text is the attachment. Deleting the path by hand has to take the
     picture with it, or the strip promises something that is not being sent. */
  a.elPromptInput.value = "look at @.sheepit/a.png please";
  check("and only those still in the text", a.attachedPaths(), [".sheepit/a.png"]);

  // Nothing that merely looks like one counts.
  a.elPromptInput.value = "read @src/app.js and .sheepit/nope.png";
  check("a path without the @ is not an attachment", a.attachedPaths(), []);

  // Tapping x is the same as deleting the text, because it does exactly that.
  a.elPromptInput.value = "one @.sheepit/a.png two @.sheepit/b.png";
  a.attachUrls.set(".sheepit/a.png", "blob:a");
  a.dropAttachment(".sheepit/a.png");
  check("dropping one leaves the other", a.attachedPaths(), [".sheepit/b.png"]);
  check("and forgets its thumbnail", a.attachUrls.has(".sheepit/a.png"), false);
}

// -- what the strip draws ----------------------------------------------------

{
  const a = load();
  a.elPromptInput.value = "@.sheepit/20260914-1203-a4f1.png";
  a.attachUrls.set(".sheepit/20260914-1203-a4f1.png", "blob:stub");
  a.renderAttachments();
  check("a chip per attachment",
        (a.elAttachStrip.innerHTML.match(/attach-chip/g) || []).length, 1);
  check("with the picture the phone already has",
        a.elAttachStrip.innerHTML.includes('src="blob:stub"'), true);
  check("named by its file rather than its path",
        a.elAttachStrip.innerHTML.includes(">20260914-1203-a4f1.png<"), true);

  a.elPromptInput.value = "";
  a.renderAttachments();
  check("an empty composer draws nothing", a.elAttachStrip.innerHTML, "");
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all attachment tests passed");
