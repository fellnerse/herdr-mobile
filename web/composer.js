/* Shared composer pieces: the attachment strip, used identically by the plain
   view's composer and the in-page chat renderer in app.js. Both
   keep attachments as a hidden [{name, url}] array and a strip of thumbnails -
   never a path spliced into the visible text - so what the strip shows and
   what gets sent can never disagree. What differs between the two views is
   only what "name" ends up meaning (a chat's upload name vs. a pane's
   `.sheepit/...` path) and how it is folded into the outgoing message; this
   file knows neither. No build step: a plain global, loaded with a <script>
   tag like everything else under web/. */
(function () {
  "use strict";

  // Long edge of what gets uploaded, and the size below which a screenshot
  // goes up untouched - re-encoding it would cost the crispness that is
  // usually the point of sending one.
  const MAX_EDGE = 1600;
  const KEEP_AS_IS = 1.2 * 1024 * 1024;

  /* Scale an image down before it goes anywhere. Everything here is allowed to
     fail: if the browser will not decode it, the original bytes are still a
     perfectly good upload. */
  async function shrinkImage(file) {
    const isPng = file.type === "image/png";
    try {
      const bitmap = await createImageBitmap(file);
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1, MAX_EDGE / longest);
      if (scale === 1 && file.size <= KEEP_AS_IS && /^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
        bitmap.close();
        return file;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const type = isPng ? "image/png" : "image/jpeg";
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
      return blob || file;
    } catch (err) {
      return file; // HEIC on a browser that will not decode it, say
    }
  }

  /* Images out of a clipboard or a drag, which arrive in the same shape from
     both: a list of items that may be files, and a list of files that may be
     images. Safari fills one, some browsers fill the other, and a screenshot
     copied on a phone can arrive as either - so read both and take whatever is
     actually a picture. */
  function imagesIn(transfer) {
    if (!transfer) return [];
    const found = [];
    for (const item of transfer.items || []) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      // iOS sometimes leaves the MIME type empty on a pasted screenshot.
      // The decoder in createAttachStrip checks those files before upload.
      if (file && ((item.type || file.type || "").startsWith("image/")
          || ["", "application/octet-stream"].includes(item.type || file.type || ""))) found.push(file);
    }
    if (found.length) return found;
    for (const file of transfer.files || []) {
      if ((file.type || "").startsWith("image/")
          || !file.type || file.type === "application/octet-stream") found.push(file);
    }
    return found;
  }

  async function clipboardImages() {
    if (!navigator.clipboard?.read) return [];
    const images = [];
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        if (type.startsWith("image/")) {
          const blob = await item.getType(type);
          images.push(blob.type ? blob : new Blob([blob], { type }));
        }
      }
    }
    return images;
  }

  /* Shared textarea sizing. Each view chooses its own height limit and owns
     the layout changes that follow the measured height. */
  function resizeTextarea(el, maxHeight = Infinity) {
    el.style.height = "auto";
    const height = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${height}px`;
    return height;
  }

  /* Persistence mechanics for text kept against a scope (a pane or a chat).
     The view supplies storage and textarea policy; this module owns ordering,
     caret restoration, the cap, and safe handling of unavailable storage. */
  function createDraftStore({ getDrafts, setDrafts, read, write, input, resize, limit = 40 }) {
    function load() {
      try {
        const value = JSON.parse(read() || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch (_) { return {}; }
    }
    function save() {
      let drafts = getDrafts();
      const entries = Object.entries(drafts);
      if (entries.length > limit) {
        drafts = Object.fromEntries(entries.slice(-limit));
        setDrafts(drafts);
      }
      try { write(JSON.stringify(drafts)); } catch (_) { /* storage is optional */ }
    }
    function remember(scope) {
      if (!scope) return;
      const drafts = getDrafts();
      const text = input.value;
      if (text.trim()) {
        delete drafts[scope];
        drafts[scope] = { text, caret: input.selectionStart ?? text.length };
      } else if (drafts[scope]) delete drafts[scope];
      else return;
      save();
    }
    function restore(scope) {
      const draft = getDrafts()[scope];
      input.value = draft ? draft.text : "";
      resize();
      if (!draft) return;
      const caret = Math.min(draft.caret ?? draft.text.length, draft.text.length);
      try { input.setSelectionRange(caret, caret); } catch (_) { /* unfocused */ }
    }
    function clear(scope) {
      const drafts = getDrafts();
      if (!scope || !drafts[scope]) return;
      delete drafts[scope];
      save();
    }
    return { load, save, remember, restore, clear };
  }

  /* The send history behind the composer's recall button. */
  function createRecallHistory({ getHistory, setHistory, read, write, input,
    getScope, getRecall, setRecall, maxEntries = 20, maxScopes = 40,
    resize, rememberDraft, haptic, showButton }) {
    function load() {
      try {
        const value = JSON.parse(read() || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch (_) { return {}; }
    }
    function save() {
      const history = getHistory();
      const entries = Object.entries(history);
      if (entries.length > maxScopes) setHistory(Object.fromEntries(entries.slice(-maxScopes)));
      try { write(JSON.stringify(getHistory())); } catch (_) { /* storage is optional */ }
    }
    function forScope(scope) { return (scope && getHistory()[scope]) || []; }
    function rememberSent(scope, text) {
      if (!scope || !text.trim()) return;
      const history = getHistory();
      const list = forScope(scope).slice();
      if (list[list.length - 1] !== text) list.push(text);
      delete history[scope];
      history[scope] = list.slice(-maxEntries);
      save();
    }
    function reset() { setRecall({ at: -1, text: null }); }
    function sync() {
      let recall = getRecall();
      if (recall.text !== null && input.value !== recall.text) {
        recall = { at: -1, text: null };
        setRecall(recall);
      }
      showButton(forScope(getScope()).length > 0 && (recall.text !== null || !input.value.trim()));
    }
    function previous() {
      const list = forScope(getScope());
      const recall = getRecall();
      const next = recall.at < 0 ? list.length - 1 : recall.at - 1;
      if (next < 0) return;
      haptic();
      const text = list[next];
      setRecall({ at: next, text });
      input.value = text;
      try { input.setSelectionRange(text.length, text.length); } catch (_) { /* unfocused */ }
      resize();
      rememberDraft();
    }
    return { load, save, forScope, rememberSent, reset, sync, previous };
  }

  /* Queue strips share their display and action wiring while each view keeps
     its own copy and styling of a queue row. `renderRow` and `onAction` are
     the view's send contract. */
  function createQueueStrip(el, renderRow, onAction) {
    function render(rows, before = "") {
      el.classList.toggle("hidden", !rows.length && !before);
      el.innerHTML = before + rows.map(renderRow).join("");
    }
    el.addEventListener("click", (event) => {
      const button = event.target.closest("[data-composer-action]");
      if (button) onAction(button.dataset.composerAction, button.dataset.composerId);
    });
    return { render };
  }

  function bindSubmit(form, send) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send(event);
    });
  }

  /* One strip, one hidden array behind it. `upload(blob)` does whatever a view
     needs to hand the gateway the bytes and must resolve to the string that
     names the result there (a chat's attachment name, a pane's inbox path);
     `onError(message)` hears about an upload that failed. Nothing here reads
     the composer's text box - folding an entry's `name` into a message, or
     into a request field, is each view's own job. */
  function createAttachStrip(el, upload, onError, onChange) {
    let attached = [];
    let generation = 0;

    function draw() {
      el.classList.toggle("hidden", !attached.length);
      el.innerHTML = attached
        .map(
          (a, i) =>
            `<span class="thumb${a.name ? "" : " loading"}"><img src="${a.url}" alt="">` +
            `<button type="button" data-drop="${i}" aria-label="Remove">×</button></span>`
        )
        .join("");
      if (onChange) onChange(attached);
    }

    async function add(files, scope) {
      const started = generation;
      for (const file of files || []) {
        if (started !== generation) return;
        if (file.type && !file.type.startsWith("image/")
            && file.type !== "application/octet-stream") continue;
        const blob = await shrinkImage(file);
        if (started !== generation) return;
        if (!blob.type.startsWith("image/")) {
          if (onError) onError("The clipboard did not contain a readable photo");
          continue;
        }
        const entry = { name: null, url: URL.createObjectURL(blob) };
        attached.push(entry);
        draw();
        try {
          const name = await upload(blob, scope);
          if (started !== generation) return;
          entry.name = name;
          draw();
        } catch (err) {
          attached = attached.filter((a) => a !== entry);
          URL.revokeObjectURL(entry.url);
          draw();
          if (onError) onError(err.message);
        }
      }
    }

    function clear() {
      generation++;
      attached.forEach((a) => URL.revokeObjectURL(a.url));
      attached = [];
      draw();
    }

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-drop]");
      if (!btn) return;
      const [gone] = attached.splice(+btn.dataset.drop, 1);
      if (gone) URL.revokeObjectURL(gone.url);
      draw();
    });

    return {
      get list() {
        return attached;
      },
      add,
      clear,
      draw,
    };
  }

  window.SheepItComposer = {
    MAX_EDGE, KEEP_AS_IS, shrinkImage, imagesIn, clipboardImages, resizeTextarea,
    createDraftStore, createRecallHistory, createQueueStrip, bindSubmit, createAttachStrip,
  };
})();
