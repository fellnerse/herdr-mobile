#!/usr/bin/env node
/* Attachment tests: node tools/test-attach.js
 *
 * Sending a screenshot is two halves. The gateway's half - where the file
 * lands, what it is called, what git makes of it - is in test-gateway.py. This
 * is the phone's half, and what it has to get right is that the hidden array
 * of attachments and the strip of thumbnails above the composer can never
 * disagree about what is being sent: the array is the attachment, and the
 * pictures are drawn from it.
 *
 * Unlike the suites that slice app.js between anchors, this one loads
 * web/composer.js whole - it is a standalone global with a <script> tag of its
 * own, so there is nothing to cut it out of. Only the browser is stubbed.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "composer.js");

/* The browser, as much of it as composer.js touches. `decode` stands in for
   createImageBitmap so a test can choose an image's size, or refuse it the way
   Safari refuses a HEIC. Revoked object URLs are recorded: a thumbnail that
   outlives its entry is a leak the strip cannot show. */
function load({ decode = () => ({ width: 800, height: 600 }) } = {}) {
  const src = fs.readFileSync(SRC, "utf8");
  const revoked = [];
  let nextUrl = 0;

  const URLStub = {
    createObjectURL: () => `blob:${++nextUrl}`,
    revokeObjectURL: (url) => revoked.push(url),
  };
  const documentStub = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob(cb, type) { cb({ type, size: 4096 }); },
    }),
  };
  const createImageBitmap = async (file) => {
    const box = decode(file);
    if (!box) throw new Error("cannot decode");
    return { ...box, close() {} };
  };
  const windowStub = {};

  new Function("window", "document", "URL", "createImageBitmap", "navigator", src)(
    windowStub, documentStub, URLStub, createImageBitmap, {}
  );
  return { composer: windowStub.SheepItComposer, revoked };
}

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// A clipboard or a drag, in the two shapes browsers hand them over in.
const asItems = (...types) => ({
  items: types.map((type) => ({
    kind: type === null ? "string" : "file",
    type: type || "text/plain",
    getAsFile: () => (type === null ? null : { type, name: "x", size: 4096 }),
  })),
  files: [],
});
const asFiles = (...types) =>
  ({ items: [], files: types.map((type) => ({ type, name: "x", size: 4096 })) });

/* The strip's element, and a click on one of its × buttons. */
function stripEl() {
  const el = {
    innerHTML: "", hidden: false, fire: null,
    classList: { toggle: (_, on) => { el.hidden = on; } },
    addEventListener: (_, fn) => { el.fire = fn; },
  };
  return el;
}
const drop = (el, i) =>
  el.fire({ target: { closest: () => ({ dataset: { drop: String(i) } }) } });
const thumbs = (el) => (el.innerHTML.match(/class="thumb/g) || []).length;
const loading = (el) => (el.innerHTML.match(/class="thumb loading"/g) || []).length;

async function main() {

// -- what came in on the clipboard -------------------------------------------

{
  const { composer } = load();
  const { imagesIn } = composer;

  check("an image among the items is found", imagesIn(asItems("image/png")).length, 1);
  check("Safari's files list is read too", imagesIn(asFiles("image/jpeg")).length, 1);
  check("both lists together are not counted twice",
        imagesIn({ items: asItems("image/png").items, files: [{ type: "image/png" }] }).length, 1);

  /* Pasting text has to stay pasting text. Claiming a paste that carries no
     picture would swallow every prompt anybody ever copied. */
  check("plain text is left alone", imagesIn(asItems(null)).length, 0);
  check("a non-image file is not an image", imagesIn(asFiles("application/pdf")).length, 0);
  check("nothing at all is nothing", imagesIn(null).length, 0);

  // Several screenshots at once are several attachments.
  check("two images are two", imagesIn(asItems("image/png", "image/heic")).length, 2);

  /* iOS leaves the type off a pasted screenshot often enough that refusing
     those would be refusing the commonest paste there is. They are taken on
     spec and checked once the decoder has had a look. */
  check("a screenshot with no MIME type is still taken", imagesIn(asFiles("")).length, 1);
  check("and one that arrives as raw bytes",
        imagesIn(asItems("application/octet-stream")).length, 1);
}

// -- shrinking it before it goes up ------------------------------------------

{
  const { composer } = load({ decode: () => ({ width: 3200, height: 1600 }) });
  const big = { type: "image/png", size: 5 * 1024 * 1024 };
  const out = await composer.shrinkImage(big);
  check("an oversized screenshot is re-encoded, not sent whole", out === big, false);
  check("and a png stays a png", out.type, "image/png");
}

{
  const { composer } = load({ decode: () => ({ width: 800, height: 600 }) });
  const small = { type: "image/png", size: 100 * 1024 };
  check("one already small enough goes up untouched",
        (await composer.shrinkImage(small)) === small, true);
}

{
  // HEIC on a browser that will not decode it: the original bytes still upload.
  const { composer } = load({ decode: () => null });
  const heic = { type: "image/heic", size: 100 * 1024 };
  check("an image the browser cannot read is sent as it came",
        (await composer.shrinkImage(heic)) === heic, true);
}

// -- the strip follows the array ---------------------------------------------

{
  const { composer } = load();
  const el = stripEl();
  const strip = composer.createAttachStrip(el, async () => ".sheepit/a.png", () => {});

  await strip.add(asFiles("image/png").files);
  check("one file is one entry", strip.list.length, 1);
  check("and one thumbnail", thumbs(el), 1);
  check("the strip is no longer hidden", el.hidden, false);
  check("named by what the upload called it", strip.list[0].name, ".sheepit/a.png");
  check("and is no longer loading", loading(el), 0);
}

{
  /* The picture is on screen before the upload finishes - waiting for the
     round trip to show a screenshot you just pasted reads as a dropped paste. */
  const { composer } = load();
  const el = stripEl();
  let finish;
  const strip = composer.createAttachStrip(
    el, () => new Promise((r) => { finish = r; }), () => {});

  const adding = strip.add(asFiles("image/png").files);
  await tick();
  check("the thumbnail is up while the upload is still going", thumbs(el), 1);
  check("and says so", loading(el), 1);
  finish(".sheepit/b.png");
  await adding;
  check("then settles", loading(el), 0);
}

{
  // An upload that fails takes its thumbnail with it, or the strip promises
  // something that is not being sent.
  const { composer, revoked } = load();
  const el = stripEl();
  const errors = [];
  const strip = composer.createAttachStrip(
    el, async () => { throw new Error("disk full"); }, (m) => errors.push(m));

  await strip.add(asFiles("image/png").files);
  check("a failed upload leaves nothing attached", strip.list.length, 0);
  check("and nothing drawn", thumbs(el), 0);
  check("the strip hides itself again", el.hidden, true);
  check("the reason is passed on", errors, ["disk full"]);
  check("and the thumbnail is released", revoked.length, 1);
}

{
  const { composer, revoked } = load();
  const el = stripEl();
  let n = 0;
  const strip = composer.createAttachStrip(el, async () => `n${++n}.png`, () => {});

  await strip.add(asFiles("image/png", "image/jpeg").files);
  check("two files are two entries", strip.list.length, 2);

  drop(el, 0);
  check("tapping × drops that one", strip.list.length, 1);
  check("and leaves the other", strip.list[0].name, "n2.png");
  check("the one it drew is released", revoked, ["blob:1"]);

  strip.clear();
  check("clearing empties it", strip.list.length, 0);
  check("and releases the rest", revoked, ["blob:1", "blob:2"]);
  check("and hides the strip", el.hidden, true);
}

{
  /* Sending while an upload is in flight clears the strip. The upload that
     lands afterwards belongs to a message already gone, and must not come
     back as an attachment on the next one. */
  const { composer } = load();
  const el = stripEl();
  let finish;
  const strip = composer.createAttachStrip(
    el, () => new Promise((r) => { finish = r; }), () => {});

  const adding = strip.add(asFiles("image/png").files);
  await tick();
  check("it is attached to begin with", strip.list.length, 1);
  strip.clear();
  finish(".sheepit/late.png");
  await adding;
  check("an upload that lands after a send does not reattach", strip.list.length, 0);
  check("and draws nothing", thumbs(el), 0);
}

{
  // A pdf dragged onto the composer is not a screenshot.
  const { composer } = load();
  const el = stripEl();
  const strip = composer.createAttachStrip(el, async () => "nope", () => {});
  await strip.add(asFiles("application/pdf").files);
  check("a file that is not an image is not attached", strip.list.length, 0);
}

{
  /* A file with no type reaches the decoder on spec; if what comes back is
     not an image after all, it is refused with a reason rather than uploaded. */
  const { composer } = load({ decode: () => null });
  const el = stripEl();
  const errors = [];
  const strip = composer.createAttachStrip(
    el, async () => "nope", (m) => errors.push(m));
  await strip.add([{ type: "", size: 4096 }]);
  check("something that only looked like a photo is refused", strip.list.length, 0);
  check("and says why", errors, ["The clipboard did not contain a readable photo"]);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("all attachment tests passed");

}

main();
