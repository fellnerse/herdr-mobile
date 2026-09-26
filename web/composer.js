/* Shared composer pieces: the attachment strip, used identically by the plain
   view's composer (index.html/app.js) and a chat's (chat.html/chat.js). Both
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
      if (item.kind !== "file" || !(item.type || "").startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) found.push(file);
    }
    if (found.length) return found;
    for (const file of transfer.files || []) {
      if ((file.type || "").startsWith("image/")) found.push(file);
    }
    return found;
  }

  /* Shared textarea sizing. Each view chooses its own height limit and owns
     the layout changes that follow the measured height. */
  function resizeTextarea(el, maxHeight = Infinity) {
    el.style.height = "auto";
    const height = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${height}px`;
    return height;
  }

  /* One strip, one hidden array behind it. `upload(blob)` does whatever a view
     needs to hand the gateway the bytes and must resolve to the string that
     names the result there (a chat's attachment name, a pane's inbox path);
     `onError(message)` hears about an upload that failed. Nothing here reads
     the composer's text box - folding an entry's `name` into a message, or
     into a request field, is each view's own job. */
  function createAttachStrip(el, upload, onError, onChange) {
    let attached = [];

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

    async function add(files) {
      for (const file of files || []) {
        if (!file.type.startsWith("image/")) continue;
        const blob = await shrinkImage(file);
        const entry = { name: null, url: URL.createObjectURL(blob) };
        attached.push(entry);
        draw();
        try {
          entry.name = await upload(blob);
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

  window.SheepItComposer = { MAX_EDGE, KEEP_AS_IS, shrinkImage, imagesIn, resizeTextarea, createAttachStrip };
})();
