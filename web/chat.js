/* Chat: talk to Claude Code as messages rather than as a terminal.
 *
 * The gateway (gateway/chat.py) keeps one headless `claude` per chat and hands
 * back its stream as a list of events; this page long-polls that list by index
 * and folds it into a conversation. The fold is redone from the top on every
 * batch - chats are short - but only the messages whose markup changed are
 * put back into the page, so a streaming answer does not redraw the image
 * above it or fold up a tool card somebody opened.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const embedded = window.parent !== window;
  const elList = $("list-view"), elChat = $("chat-view");
  const elMessages = $("messages"), elInput = $("input");
  const elSend = $("btn-send"), elStop = $("btn-stop");
  const elStrip = $("attach-strip"), elAttachInput = $("attach-input");

  let current = null;          // the open chat's summary
  let events = [];
  let epoch = "";
  let poll = null;             // AbortController of the running long poll
  let drawn = [];              // the markup of each message now on the page
  let attached = [];           // [{name, url}] waiting to go with the next message
  const openTools = new Set(); // tool cards somebody unfolded
  const picks = new Map();     // request_id -> {question: Set(labels)}
  let commands = null;         // [{name, description, hint}] for the open chat's project

  /* iOS: follow the visual viewport, so the composer rides the keyboard. */
  function fitViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement.style;
    root.setProperty("--app-height", (vv ? vv.height : window.innerHeight) + "px");
    root.setProperty("--app-offset", (vv ? vv.offsetTop : 0) + "px");
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitViewport);
    window.visualViewport.addEventListener("scroll", fitViewport);
  } else {
    window.addEventListener("resize", fitViewport);
  }
  fitViewport();
  // The keyboard's closing animation outlasts its last resize event: measure
  // again once it has settled, or the offset from the open keyboard sticks.
  document.addEventListener("focusout", () => {
    setTimeout(() => { window.scrollTo(0, 0); fitViewport(); }, 300);
  });

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
    return data;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shortDir = (p) => (p || "").split("/").slice(-2).join("/");
  const imageUrl = (name) => `/api/chat/image?id=${encodeURIComponent(current.id)}&name=${encodeURIComponent(name)}`;

  function ago(t) {
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  /* ---- A little markdown: fences, headings, bullets, tables, `code`, **bold**, links. */
  // Code spans and links are set aside as \u0000n\u0000 while the rest is
  // rewritten, so a URL inside a sentence in backticks stays text and one
  // inside a link is not linked twice. Only http(s): the href comes from the agent.
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  function inline(s) {
    const held = [];
    const hold = (html) => "\u0000" + (held.push(html) - 1) + "\u0000";
    return esc(s)
      // ...unless the code is nothing but a URL, which is there to be opened.
      .replace(/`([^`\n]+)`/g, (_, c) => hold(/^https?:\/\/[\w-]+(\.[\w-]+)+(:\d+)?(\/[^\s…]*)?$/.test(c) ? link(c, "<code>" + c + "</code>") : "<code>" + c + "</code>"))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => hold(link(u, t)))
      .replace(/https?:\/\/[^\s<]+/g, (u) => {
        const tail = u.match(/[.,;:!?)\]]*$/)[0];
        u = u.slice(0, u.length - tail.length);
        return hold(link(u, u)) + tail;
      })
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  }
  function markdown(text) {
    const out = [];
    const parts = String(text).split(/^```[^\n]*\n?/m);
    parts.forEach((part, i) => {
      if (i % 2) { out.push("<pre><code>" + esc(part.replace(/\n$/, "")) + "</code></pre>"); return; }
      let para = [], list = [], rows = [];
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const flush = () => {
        if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>");
        if (list.length) out.push("<ul>" + list.map((l) => "<li>" + inline(l) + "</li>").join("") + "</ul>");
        if (rows.length) {
          // The |---| line under the head says which row the head is.
          const body = rows.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
          const head = rows.length > 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1]) ? body.shift() : null;
          out.push(`<div class="table"><table>` +
            (head ? "<thead><tr>" + cells(head).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead>" : "") +
            "<tbody>" + body.map((r) => "<tr>" + cells(r).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
            "</tbody></table></div>");
        }
        para = []; list = []; rows = [];
      };
      for (const line of part.split("\n")) {
        const h = line.match(/^(#{1,3})\s+(.*)/);
        const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
        if (/^\s*\|.*\|\s*$/.test(line)) { if (para.length || list.length) flush(); rows.push(line); continue; }
        if (rows.length) flush();
        if (!line.trim()) flush();
        else if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
        else if (li) { if (para.length) flush(); list.push(li[1]); }
        else { if (list.length) flush(); para.push(line); }
      }
      flush();
    });
    return out.join("");
  }

  /* ---- Tools: one line saying what, unfolding to the input and the result. */
  function toolArg(name, input) {
    input = input || {};
    const pick = input.command || input.file_path || input.pattern || input.url ||
      input.description || input.query || input.path;
    if (pick) return String(pick);
    const first = Object.values(input).find((v) => typeof v === "string");
    return first || "";
  }
  function resultText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((b) => b.text || (b.type ? `[${b.type}]` : "")).join("\n");
    return content == null ? "" : JSON.stringify(content, null, 2);
  }

  /* ---- The conversation, folded out of the event list. */
  function build(evts, chat) {
    const running = !!(chat && chat.running);
    const pending = new Set((chat && chat.pending) || []);
    const items = [];
    const tools = {};
    const asks = {};
    let live = "";
    for (const ev of evts) {
      switch (ev.type) {
        case "prompt": items.push({ kind: "user", text: ev.text, images: ev.images || [] }); break;
        case "delta": live += ev.text; break;
        case "assistant":
          for (const b of ev.content || []) {
            if (b.type === "text") { items.push({ kind: "assistant", text: b.text }); live = ""; }
            // A question is drawn as the ask below, not as a tool call.
            else if (b.type === "tool_use" && b.name !== "AskUserQuestion") {
              const t = { kind: "tool", id: b.id, name: b.name, input: b.input };
              tools[b.id] = t; items.push(t);
            }
          }
          break;
        case "tool_results":
          for (const r of ev.content || []) {
            const t = tools[r.tool_use_id];
            if (t) { t.result = resultText(r.content); t.error = r.is_error; }
          }
          break;
        case "ask": {
          const a = { kind: "ask", id: ev.request_id, tool: ev.tool, input: ev.input || {},
            description: ev.description, always: (ev.suggestions || []).length > 0,
            open: pending.has(ev.request_id) };
          asks[ev.request_id] = a; items.push(a);
          break;
        }
        case "answered": {
          const a = asks[ev.request_id];
          if (a) { a.answered = ev.behavior; a.answers = ev.answers; }
          break;
        }
        case "result": {
          if (ev.is_error && ev.text) items.push({ kind: "error", text: ev.text });
          const bits = [];
          if (ev.duration_ms) bits.push((ev.duration_ms / 1000).toFixed(1) + "s");
          if (ev.cost) bits.push("$" + ev.cost.toFixed(3));
          if (bits.length) items.push({ kind: "meta", text: bits.join(" · ") });
          live = "";
          break;
        }
        case "interrupted": items.push({ kind: "meta", text: "interrupted" }); live = ""; break;
        case "exit": items.push({ kind: ev.code ? "error" : "meta", text: ev.text }); live = ""; break;
        case "error": items.push({ kind: "error", text: ev.text }); break;
      }
    }
    // A pane stopped on something the log does not show: a trust prompt, a menu.
    if (chat && chat.kind === "pane" && chat.status === "blocked" && !pending.size) {
      items.push({ kind: "meta", text: "waiting on something in the terminal" });
    }
    if (live) items.push({ kind: "assistant", text: live, live: true });
    else if (running && !pending.size && items.length && items[items.length - 1].kind !== "tool") items.push({ kind: "typing" });
    for (const t of Object.values(tools)) t.state = t.result === undefined ? (running ? "" : "stale") : (t.error ? "err" : "ok");
    return items;
  }

  /* A message that starts with a command reads as one: the command is a chip. */
  function userText(text) {
    const m = text.match(/^\/([\w:.-]+)(\s[\s\S]*)?$/);
    return m ? `<span class="cmd">/${esc(m[1])}</span>${esc(m[2] || "")}` : esc(text);
  }

  function askHtml(it) {
    if (it.tool === "AskUserQuestion") {
      const chosen = picks.get(it.id) || {};
      const qs = it.input.questions || [];
      const body = qs.map((q, qi) => {
        const answer = it.answers && it.answers[q.question];
        const opts = (q.options || []).map((o) => {
          const on = answer ? answer.split(", ").includes(o.label) : (chosen[q.question] || new Set()).has(o.label);
          return `<button type="button" class="opt${on ? " on" : ""}" data-ask="${esc(it.id)}" data-q="${qi}" data-label="${esc(o.label)}"${it.open ? "" : " disabled"}>` +
            `<b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ""}</button>`;
        }).join("");
        return `<div class="q"><div class="q-text">${esc(q.question)}${q.multiSelect ? " <em>(pick any)</em>" : ""}</div>${opts}</div>`;
      }).join("");
      // One single-choice question answers itself on tap; anything more needs a send.
      const needsSend = qs.length > 1 || qs.some((q) => q.multiSelect);
      const foot = it.open
        ? (needsSend ? `<div class="ask-actions"><button type="button" class="btn primary" data-act="answers" data-ask="${esc(it.id)}">Send answers</button>` +
          `<button type="button" class="btn" data-act="deny" data-ask="${esc(it.id)}">Skip</button></div>` : "")
        : `<div class="ask-state">${it.answered === "deny" ? "skipped" : it.answered ? "answered" : "no longer open"}</div>`;
      return `<div class="ask">${body}${foot}</div>`;
    }
    const arg = toolArg(it.tool, it.input);
    const detail = it.tool === "ExitPlanMode" ? markdown(it.input.plan || "") :
      `<pre>${esc(it.input.command || it.input.content || JSON.stringify(it.input, null, 2))}</pre>`;
    const foot = it.open
      ? `<div class="ask-actions"><button type="button" class="btn primary" data-act="allow" data-ask="${esc(it.id)}">Allow</button>` +
        (it.always ? `<button type="button" class="btn" data-act="always" data-ask="${esc(it.id)}">Always</button>` : "") +
        `<button type="button" class="btn danger" data-act="deny" data-ask="${esc(it.id)}">Deny</button></div>`
      : `<div class="ask-state">${{ allow: "allowed", always: "allowed for this session", deny: "denied" }[it.answered] || "no longer open"}</div>`;
    return `<div class="ask${it.open ? " open" : ""}"><div class="ask-head">${it.tool === "ExitPlanMode" ? "Proceed with this plan?" : `Allow <b>${esc(it.tool)}</b>?`}</div>` +
      (arg && it.tool !== "ExitPlanMode" ? `<div class="ask-arg">${esc(it.description || arg)}</div>` : "") +
      `<details><summary>details</summary>${detail}</details>${foot}</div>`;
  }

  function itemHtml(it) {
    switch (it.kind) {
      case "user":
        return `<div class="msg user">` +
          (it.images.length ? `<div class="imgs">${it.images.map((n) => `<img src="${esc(imageUrl(n))}" alt="">`).join("")}</div>` : "") +
          (it.text ? userText(it.text) : "") + `</div>`;
      case "assistant": return `<div class="msg assistant">${markdown(it.text)}</div>`;
      case "error": return `<div class="msg error">${esc(it.text)}</div>`;
      case "meta": return `<div class="msg meta">${esc(it.text)}</div>`;
      case "typing": return `<div class="msg"><span class="typing"><i></i><i></i><i></i></span></div>`;
      case "ask": return `<div class="msg">${askHtml(it)}</div>`;
      case "tool": {
        const input = JSON.stringify(it.input || {}, null, 2);
        return `<details class="msg tool ${it.state}" data-id="${esc(it.id)}"${openTools.has(it.id) ? " open" : ""}>` +
          `<summary><span class="state"></span><span class="name">${esc(it.name)}</span>` +
          `<span class="arg">${esc(toolArg(it.name, it.input))}</span></summary>` +
          `<pre>${esc(input)}</pre>` +
          (it.result !== undefined ? `<pre>${esc(it.result)}</pre>` : "") +
          `</details>`;
      }
    }
    return "";
  }

  function render() {
    const running = !!(current && current.running);
    const nearBottom = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 80;
    const html = build(events, current).map(itemHtml);
    if (!html.length) html.push(current && current.kind === "pane"
      ? `<div class="empty">${current.claude ? "Nothing in this session yet." : "There is no Claude Code in this pane."}</div>`
      : `<div class="empty">Ask Claude anything about ${esc(shortDir(current && current.cwd))}.</div>`);
    // Put back only what changed: the rest keeps its node, its image, its scroll.
    html.forEach((h, i) => {
      if (drawn[i] === h) return;
      const tpl = document.createElement("template");
      tpl.innerHTML = h;
      const node = tpl.content.firstElementChild;
      const old = elMessages.children[i];
      old ? elMessages.replaceChild(node, old) : elMessages.appendChild(node);
    });
    while (elMessages.children.length > html.length) elMessages.lastElementChild.remove();
    drawn = html;
    if (nearBottom) elMessages.scrollTop = elMessages.scrollHeight;
    elStop.classList.toggle("hidden", !running);
  }

  elMessages.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.matches && d.matches("details.tool")) d.open ? openTools.add(d.dataset.id) : openTools.delete(d.dataset.id);
  }, true);

  /* ---- Answering: permission buttons and AskUserQuestion's options. */
  function askEvent(id) { return events.find((e) => e.type === "ask" && e.request_id === id); }

  async function answer(id, behavior, answers) {
    try {
      const data = await api("/api/chat/answer", { id: current.id, request_id: id, behavior, answers });
      current = data.chat;
      render();
    } catch (err) { alert(err.message); }
  }

  elMessages.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-ask]");
    if (!btn || btn.disabled) return;
    const id = btn.dataset.ask;
    if (btn.dataset.act === "answers") {
      const chosen = picks.get(id) || {};
      const answers = {};
      for (const [q, set] of Object.entries(chosen)) if (set.size) answers[q] = [...set].join(", ");
      answer(id, "allow", answers);
      return;
    }
    if (btn.dataset.act) { answer(id, btn.dataset.act); return; }
    // An option.
    const ev = askEvent(id);
    const qs = (ev && ev.input.questions) || [];
    const q = qs[+btn.dataset.q];
    if (!q) return;
    const chosen = picks.get(id) || {};
    const set = chosen[q.question] || new Set();
    if (q.multiSelect) set.has(btn.dataset.label) ? set.delete(btn.dataset.label) : set.add(btn.dataset.label);
    else { set.clear(); set.add(btn.dataset.label); }
    chosen[q.question] = set;
    picks.set(id, chosen);
    if (qs.length === 1 && !q.multiSelect) answer(id, "allow", { [q.question]: btn.dataset.label });
    else render();
  });

  /* ---- The long poll: ask for what is past our index, wait if nothing is. */
  async function follow(chatId) {
    const ctrl = new AbortController();
    poll = ctrl;
    let since = 0;
    while (!ctrl.signal.aborted) {
      try {
        const qs = `id=${encodeURIComponent(chatId)}&since=${since}&epoch=${epoch}&wait=${since ? 1 : 0}`;
        const res = await fetch("/api/chat/events?" + qs, { cache: "no-store", signal: ctrl.signal });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        if (data.from === 0) events = [];
        events = events.concat(data.events);
        epoch = data.epoch;
        since = data.next;
        current = data.chat;
        $("chat-title").textContent = current.title || "New chat";
        render();
      } catch (e) {
        if (ctrl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /* Coming back to a page iOS froze: the poll in flight may be long dead. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && current) { const c = current; if (poll) poll.abort(); events = []; epoch = ""; follow(c.id); }
  });

  function openChat(chat) {
    if (poll) poll.abort();
    current = chat; events = []; epoch = ""; drawn = []; openTools.clear(); picks.clear();
    commands = null; hideMenu();
    loadCommands(chat.id);
    elMessages.innerHTML = "";
    clearAttached();
    $("chat-title").textContent = chat.title || "New chat";
    const pane = chat.kind === "pane";
    $("chat-sub").textContent = pane
      ? [shortDir(chat.cwd), chat.model || "claude", "herdr pane"].join(" · ")
      : [shortDir(chat.cwd), chat.model || "default", chat.mode].join(" · ");
    $("btn-delete").classList.toggle("hidden", pane);
    $("btn-transcript").classList.toggle("hidden", !pane);
    if (pane) $("btn-transcript").href = "/#" + chat.id;
    // In the desktop app's frame the flock is beside it, so there is no back.
    $("btn-back").classList.toggle("hidden", pane && embedded);
    elList.classList.add("hidden");
    elChat.classList.remove("hidden");
    if (location.hash !== "#" + chat.id) history.replaceState(null, "", "#" + chat.id);
    render();
    follow(chat.id);
  }

  function showList() {
    if (poll) poll.abort();
    poll = null; current = null;
    history.replaceState(null, "", location.pathname);
    elChat.classList.add("hidden");
    elList.classList.remove("hidden");
    loadList();
  }

  /* A push names the chat in the hash; the page may already be open. */
  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const c = listData.chats.find((x) => x.id === id);
    if (current && current.id === id) return;
    if (c) openChat(c);
    else if (id.startsWith("pane:")) openById(id);
    else if (id) loadList();
  });

  /* A Herdr pane is not in the list: the main app links to it by id. */
  async function openById(id) {
    try { openChat((await api(`/api/chat/events?id=${encodeURIComponent(id)}`)).chat); }
    catch (e) { alert(e.message); location.href = "/"; }
  }

  /* ---- The list and the new-chat form. */
  let listData = { chats: [], dirs: [], modes: [] };
  async function loadList() {
    try { listData = await api("/api/chat"); } catch (e) { return; }
    const cwd = $("new-cwd"), mode = $("new-mode");
    if (!cwd.options.length || cwd.options.length !== listData.dirs.length) {
      let keep = cwd.value;
      try { keep = keep || localStorage.getItem("chat.cwd"); } catch (_) {}
      cwd.innerHTML = listData.dirs.map((d) => `<option value="${esc(d.cwd)}">${esc(d.name)} — ${esc(shortDir(d.cwd))}</option>`).join("");
      if (keep && listData.dirs.some((d) => d.cwd === keep)) cwd.value = keep;
    }
    if (!mode.options.length) {
      mode.innerHTML = listData.modes.map((m) => `<option>${esc(m)}</option>`).join("");
      let saved = null;
      try { saved = localStorage.getItem("chat.mode"); } catch (_) {}
      mode.value = saved || "auto";
    }
    const list = $("chat-list");
    list.innerHTML = listData.chats.length ? listData.chats.map((c) => {
      const state = c.pending.length ? " asking" : c.running ? " running" : "";
      return `<li data-id="${esc(c.id)}"><div class="main"><span class="t"><span class="dot${state}"></span>${esc(c.title || "New chat")}</span>` +
        `<span class="s">${esc(shortDir(c.cwd))} · ${esc(c.model || "default")} · ${ago(c.updated || c.created)}</span></div>` +
        `<button type="button" class="row-del${c.id === armed ? " armed" : ""}" data-del="${esc(c.id)}" aria-label="Delete chat">` +
        (c.id === armed ? "Delete" : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>`) +
        `</button></li>`;
    }).join("") : `<li class="empty">No chats yet.</li>`;
    if (!current && location.hash.length > 1) {
      const id = decodeURIComponent(location.hash.slice(1));
      const c = listData.chats.find((x) => x.id === id);
      if (c) openChat(c);
      else if (id.startsWith("pane:")) openById(id);
    }
  }

  /* Delete from the list takes two taps: the first arms the row's button,
     the second deletes. Tapping anywhere else disarms it. */
  let armed = null;
  $("chat-list").addEventListener("click", async (e) => {
    const del = e.target.closest("button[data-del]");
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      if (armed !== id) { armed = id; loadList(); return; }
      armed = null;
      await api("/api/chat/delete", { id }).catch((err) => alert(err.message));
      loadList();
      return;
    }
    if (armed) { armed = null; loadList(); return; }
    const li = e.target.closest("li[data-id]");
    const c = li && listData.chats.find((x) => x.id === li.dataset.id);
    if (c) openChat(c);
  });

  $("new-chat").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { cwd: $("new-cwd").value, mode: $("new-mode").value, model: $("new-model").value };
    try { localStorage.setItem("chat.cwd", body.cwd); localStorage.setItem("chat.mode", body.mode); } catch (_) {}
    try {
      const data = await api("/api/chat/new", body);
      openChat(data.chat);
      elInput.focus();
    } catch (err) { alert(err.message); }
  });

  /* ---- Images: scaled down on the phone, kept by the gateway, sent inline. */
  const MAX_EDGE = 1600;
  const KEEP_AS_IS = 1.2 * 1024 * 1024;

  async function shrinkImage(file) {
    const isPng = file.type === "image/png";
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size <= KEEP_AS_IS && /^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
        bitmap.close();
        return file;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((r) => canvas.toBlob(r, isPng ? "image/png" : "image/jpeg", 0.86));
      return blob || file;
    } catch (err) {
      return file;
    }
  }

  function drawStrip() {
    elStrip.classList.toggle("hidden", !attached.length);
    elStrip.innerHTML = attached.map((a, i) =>
      `<span class="thumb${a.name ? "" : " loading"}"><img src="${esc(a.url)}" alt="">` +
      `<button type="button" data-drop="${i}" aria-label="Remove">×</button></span>`).join("");
  }
  function clearAttached() {
    attached.forEach((a) => URL.revokeObjectURL(a.url));
    attached = [];
    drawStrip();
  }

  async function attachFiles(files) {
    if (!current) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const blob = await shrinkImage(file);
      const entry = { name: null, url: URL.createObjectURL(blob) };
      attached.push(entry);
      drawStrip();
      try {
        const res = await fetch(`/api/chat/upload?id=${encodeURIComponent(current.id)}`, {
          method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        entry.name = data.name;
      } catch (err) {
        attached = attached.filter((a) => a !== entry);
        alert("Could not attach it — " + err.message);
      }
      drawStrip();
    }
  }

  $("btn-attach").addEventListener("click", () => elAttachInput.click());
  elAttachInput.addEventListener("change", () => { attachFiles([...elAttachInput.files]); elAttachInput.value = ""; });
  elStrip.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-drop]");
    if (!b) return;
    const [gone] = attached.splice(+b.dataset.drop, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    drawStrip();
  });
  elInput.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); attachFiles(files); }
  });

  /* ---- Skills and slash commands. Claude Code runs them itself when a message
     starts with one, so all this does is help type the name: `/` opens the
     list, what follows filters it, a tap puts `/name ` into the composer. */
  const elMenu = $("slash-menu");
  let browsing = false; // opened from the button, over text already typed

  async function loadCommands(id) {
    try {
      const data = await api(`/api/chat/commands?id=${encodeURIComponent(id)}`);
      if (current && current.id === id) { commands = data.commands; updateMenu(); }
    } catch (e) { commands = []; }
  }

  // The name being typed, or null when the composer is not starting a command.
  function slashQuery() {
    if (browsing) return "";
    const before = elInput.value.slice(0, elInput.selectionEnd == null ? elInput.value.length : elInput.selectionEnd);
    const m = before.match(/^\/([^\s]*)$/);
    return m ? m[1].toLowerCase() : null;
  }

  function matches(q) {
    const all = commands || [];
    if (!q) return all;
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const within = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return starts.concat(within);
  }

  function hideMenu() { browsing = false; elMenu.classList.add("hidden"); }

  function updateMenu() {
    const q = slashQuery();
    if (q === null) { hideMenu(); return; }
    const found = commands ? matches(q) : null;
    elMenu.classList.remove("hidden");
    if (!found) { elMenu.innerHTML = `<div class="slash-empty">Loading skills…</div>`; return; }
    if (!found.length) { elMenu.innerHTML = `<div class="slash-empty">No skill or command called /${esc(q)}</div>`; return; }
    elMenu.innerHTML = found.map((c) => {
      const src = c.description.match(/\s*\(([^()]+)\)\s*$/);
      const desc = src ? c.description.slice(0, src.index) : c.description;
      return `<button type="button" class="slash-item" data-cmd="${esc(c.name)}">` +
        `<span class="slash-name">/${esc(c.name)}${c.hint ? ` <i>${esc(c.hint)}</i>` : ""}` +
        (src ? `<em>${esc(src[1])}</em>` : "") + `</span>` +
        (desc ? `<span class="slash-desc">${esc(desc)}</span>` : "") + `</button>`;
    }).join("");
    elMenu.scrollTop = 0;
  }

  function pickCommand(name) {
    const value = elInput.value;
    elInput.value = browsing ? `/${name} ${value}` : `/${name} ` + value.replace(/^\/\S*\s?/, "");
    hideMenu();
    elInput.focus();
    const caret = name.length + 2;
    try { elInput.setSelectionRange(caret, caret); } catch (_) {}
    grow();
  }

  elMenu.addEventListener("mousedown", (e) => e.preventDefault()); // keep the keyboard up
  elMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cmd]");
    if (b) pickCommand(b.dataset.cmd);
  });
  $("btn-slash").addEventListener("click", () => {
    if (!elMenu.classList.contains("hidden")) { hideMenu(); return; }
    if (!elInput.value.trim()) { elInput.value = "/"; elInput.focus(); updateMenu(); return; }
    browsing = true;
    updateMenu();
  });
  elInput.addEventListener("input", () => { browsing = false; updateMenu(); });
  elInput.addEventListener("click", () => { if (!browsing) updateMenu(); });

  /* ---- Composer. A message sent while Claude is still busy waits its turn
     inside Claude Code, the way typing ahead in the terminal does. */
  function grow() {
    elInput.style.height = "auto";
    elInput.style.height = elInput.scrollHeight + "px";
  }
  elInput.addEventListener("input", grow);
  elInput.addEventListener("keydown", (e) => {
    if (!elMenu.classList.contains("hidden")) {
      const first = elMenu.querySelector("button[data-cmd]");
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && first) {
        e.preventDefault();
        pickCommand(first.dataset.cmd);
        return;
      }
      if (e.key === "Escape") { hideMenu(); return; }
    }
    // Enter sends on a keyboard with a shift key; the phone's return is a newline.
    if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = elInput.value;
    if (attached.some((a) => !a.name)) return; // still uploading
    const images = attached.map((a) => a.name);
    if ((!text.trim() && !images.length) || !current) return;
    elSend.disabled = true;
    try {
      const data = await api("/api/chat/send", { id: current.id, text, images });
      current = data.chat;
      elInput.value = ""; grow();
      hideMenu();
      clearAttached();
      elMessages.scrollTop = elMessages.scrollHeight;
      render();
    } catch (err) { alert(err.message); }
    elSend.disabled = false;
  });
  elStop.addEventListener("click", () => current && api("/api/chat/stop", { id: current.id }).catch(() => {}));
  // Inside the desktop app, the transcript is the same pane in the parent.
  $("btn-transcript").addEventListener("click", (e) => {
    if (!embedded) return;
    e.preventDefault();
    parent.postMessage({ sheepit: "transcript" }, location.origin);
  });

  // A pane was opened from the flock, and goes back to it.
  $("btn-back").addEventListener("click", () => {
    if (current && current.kind === "pane") location.href = "/";
    else showList();
  });
  $("btn-delete").addEventListener("click", async () => {
    if (!current || !confirm("Delete this chat? The Claude Code session itself stays.")) return;
    await api("/api/chat/delete", { id: current.id }).catch(() => {});
    showList();
  });

  setInterval(() => { if (!current && !document.hidden) loadList(); }, 5000);
  loadList();
})();
