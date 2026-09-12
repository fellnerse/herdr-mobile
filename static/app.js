// Herdr Mobile Client Application

(function () {
  let state = {
    agents: [],
    activePaneId: null,
    historyText: "",
    linesCount: 100,
    showStatusBar: false,
    showKeys: true,
    mode: "",
    isUserScrolledUp: false,
    pollInterval: 2000,
    timer: null,
    isSending: false,
  };

  // DOM Elements
  const elConn = document.getElementById("conn-indicator");
  const elBtnRefresh = document.getElementById("btn-refresh");
  const elAgentSelect = document.getElementById("agent-select");
  const elAgentSelectDot = document.getElementById("agent-select-dot");
  const elAgentSelectName = document.getElementById("agent-select-name");
  const elAgentPicker = document.getElementById("agent-picker");
  const elAgentList = document.getElementById("agent-list");
  const elBtnClosePicker = document.getElementById("btn-close-picker");
  const elBtnNewWorkspace = document.getElementById("btn-new-workspace");
  const elAgentTitle = document.getElementById("agent-title-text");
  const elAgentCwd = document.getElementById("agent-cwd-text");
  const elAgentStatus = document.getElementById("agent-status-badge");
  const elHistoryContainer = document.getElementById("history-container");
  const elHistoryContent = document.getElementById("history-content");
  const elBtnScrollBottom = document.getElementById("btn-scroll-bottom");
  const elPromptForm = document.getElementById("prompt-form");
  const elPromptInput = document.getElementById("prompt-input");
  const elTerminalInput = document.getElementById("terminal-input");
  const elCompleteBar = document.getElementById("complete-bar");
  const elTerminalInputRow = document.getElementById("terminal-input-row");
  const elBtnAdopt = document.getElementById("btn-adopt");
  const elBtnCycleMode = document.getElementById("btn-cycle-mode");
  const elBtnKeys = document.getElementById("btn-keys");
  const elKeysBar = document.getElementById("keys-bar");
  const elModeCurrent = document.getElementById("mode-current");
  const elBtnSend = document.getElementById("btn-send");
  const elBtnCtrlC = document.getElementById("btn-ctrl-c");
  const elBtnEsc = document.getElementById("btn-esc");
  const elBtnCopy = document.getElementById("btn-copy");
  const elLinesSelect = document.getElementById("lines-select");
  const elBtnSettings = document.getElementById("btn-settings");
  const elBtnCloseSheet = document.getElementById("btn-close-sheet");
  const elSheet = document.getElementById("settings-sheet");
  const elSheetBackdrop = document.getElementById("sheet-backdrop");
  const elToggleStatusBar = document.getElementById("toggle-statusbar");
  const elTogglePush = document.getElementById("toggle-push");
  const elPushHint = document.getElementById("push-hint");

  // Haptic feedback helper
  function triggerHaptic(type = "light") {
    if (navigator.vibrate) {
      if (type === "warning") navigator.vibrate([30, 50, 30]);
      else navigator.vibrate(12);
    }
  }

  // Set Connection Status
  function setConnected(connected) {
    elConn.classList.toggle("connected", connected);
    elConn.classList.toggle("disconnected", !connected);
  }

  /* ---------------------------------------------------------------------
   * Transcript parsing
   *
   * The pane text is a stripped terminal dump padded to the desktop's
   * terminal width, so it carries artefacts that read badly on a phone:
   * full-width horizontal rules around the input box (which wrap into
   * several lines of dashes) and status-bar lines padded with long runs of
   * spaces. Classify each line by its leading marker so it can be coloured,
   * and turn the noise into structure rather than text.
   * ------------------------------------------------------------------- */

  const RE_RULE_GLYPH = /[─━┄┅┈┉═—–_=]/g;
  const RE_SGR = /\x1b\[([0-9;]*)m/g;

  /* Split one ANSI line into styled runs, carrying the SGR state in `st` so
     attributes opened on an earlier line keep applying. Only colours the
     terminal actually sets are emitted; everything else inherits the block's
     own colour, which keeps the speaker roles readable. */
  function ansiRuns(line, st) {
    const runs = [];
    let last = 0;
    const push = (text) => {
      if (!text) return;
      runs.push({ text, fg: st.fg, bg: st.bg, bold: st.bold, italic: st.italic, underline: st.underline });
    };

    RE_SGR.lastIndex = 0;
    let m;
    while ((m = RE_SGR.exec(line)) !== null) {
      push(line.slice(last, m.index));
      last = m.index + m[0].length;
      applySgr(m[1], st);
    }
    push(line.slice(last));
    return runs;
  }

  function applySgr(paramText, st) {
    const parts = (paramText || "0").split(";").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (code === 0) {
        st.fg = null; st.bg = null; st.bold = false; st.italic = false; st.underline = false;
      } else if (code === 1) st.bold = true;
      else if (code === 3) st.italic = true;
      else if (code === 4) st.underline = true;
      else if (code === 22) st.bold = false;
      else if (code === 23) st.italic = false;
      else if (code === 24) st.underline = false;
      else if (code === 39) st.fg = null;
      else if (code === 49) st.bg = null;
      else if ((code === 38 || code === 48) && parts[i + 1] === 2) {
        const rgb = `rgb(${parts[i + 2] | 0},${parts[i + 3] | 0},${parts[i + 4] | 0})`;
        if (code === 38) st.fg = rgb; else st.bg = rgb;
        i += 4;
      } else if ((code === 38 || code === 48) && parts[i + 1] === 5) {
        const c = xterm256(parts[i + 2] | 0);
        if (code === 38) st.fg = c; else st.bg = c;
        i += 2;
      } else if (code >= 30 && code <= 37) st.fg = ANSI_16[code - 30];
      else if (code >= 90 && code <= 97) st.fg = ANSI_16[code - 90 + 8];
      else if (code >= 40 && code <= 47) st.bg = ANSI_16[code - 40];
    }
  }

  const ANSI_16 = [
    "#484f58", "#ff7b72", "#3fb950", "#e3b341", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
    "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
  ];

  /* xterm-256: the first 16 reuse our palette, 16-231 are a 6x6x6 cube and
     232-255 are greys. Shell panes (fish, ls, git) colour with these. */
  function xterm256(n) {
    if (n < 16) return ANSI_16[n];
    if (n < 232) {
      const i = n - 16;
      const lv = [0, 95, 135, 175, 215, 255];
      return `rgb(${lv[Math.floor(i / 36) % 6]},${lv[Math.floor(i / 6) % 6]},${lv[i % 6]})`;
    }
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }

  // Near-black foregrounds come from light-theme output and vanish on our
  // dark background; let those inherit instead.
  function tooDark(rgb) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(rgb || "");
    if (!m) return false;
    return (+m[1] * 0.299 + +m[2] * 0.587 + +m[3] * 0.114) < 40;
  }

  function runsToHtml(runs) {
    return runs
      .map((r) => {
        if (!r.text) return "";
        const css = [];
        if (r.fg && !tooDark(r.fg)) css.push(`color:${r.fg}`);
        if (r.bg) css.push(`background:${r.bg}`);
        if (r.bold) css.push("font-weight:600");
        if (r.italic) css.push("font-style:italic");
        if (r.underline) css.push("text-decoration:underline");
        const text = escapeHtml(r.text);
        return css.length ? `<span style="${css.join(";")}">${text}</span>` : text;
      })
      .join("");
  }

  function runsText(runs) {
    return runs.map((r) => r.text).join("");
  }

  // Trailing padding spaces would otherwise wrap on a narrow screen.
  function rtrimRuns(runs) {
    const out = runs.slice();
    while (out.length) {
      const last = out[out.length - 1];
      const trimmed = last.text.replace(/\s+$/, "");
      if (trimmed === last.text) break;
      if (trimmed) { out[out.length - 1] = { ...last, text: trimmed }; break; }
      out.pop();
    }
    return out;
  }
  const MARKERS = [
    { re: /^❯/, cls: "user" },        // > user message / live input
    { re: /^⏺/, cls: "assistant" },   // assistant message or tool call
    { re: /^⎿/, cls: "tool" },        // tool result
    { re: /^[✻✽✳]/, cls: "meta" }, // "Worked for 1m 8s"
    { re: /^※/, cls: "tip" },         // tips
    { re: /^⏵⏵/, cls: "status" }, // "auto mode on ..."
  ];
  const RE_BOX = /^[┌┐└┘├┤┬┴┼│╭╮╯╰┏┓┗┛┣┫┳┻╋┃║╔╗╚╝╠╣╦╩╬]/;
  // Long runs of rule glyphs anywhere in a line, not just whole-line rules.
  const RE_INLINE_RULE = /([─━┄┅┈┉═—–_=*.])\1{7,}/g;

  /* Is this line one of the terminal's horizontal rules? Returns null if not,
     otherwise the caption embedded in it - the input box's top border carries
     the session title ("──────… Get this to work in herdr ─"), which is worth
     keeping as a heading rather than 200 wrapped dashes. */
  function ruleLabel(trimmed) {
    const glyphs = (trimmed.match(RE_RULE_GLYPH) || []).length;
    if (glyphs < 8) return null;
    const label = trimmed.replace(RE_RULE_GLYPH, " ").trim();
    if (!label) return "";
    // A caption has to contain words; leftover frame glyphs are not one.
    if (!/[\p{L}\p{N}]/u.test(label)) return "";
    if (glyphs >= 16 && label.length <= 60) return label;
    return null; // prose that merely contains a long run of glyphs
  }

  function classifyLine(trimmed) {
    if (!trimmed) return null;
    if (RE_BOX.test(trimmed)) return "table";
    if (ruleLabel(trimmed) !== null) return "rule";
    for (const m of MARKERS) {
      if (m.re.test(trimmed)) return m.cls;
    }
    return null; // continuation of whatever came before
  }

  function parseTranscript(text) {
    // Tokenise first: every later step works on the plain text, while the
    // styled runs ride along so rendering can mirror the terminal's colours.
    const st = { fg: null, bg: null, bold: false, italic: false, underline: false };
    const rows = text.split("\n").map((line) => {
      const runs = rtrimRuns(ansiRuns(line.replace(/\r/g, ""), st));
      return { runs, text: runsText(runs) };
    });
    const raw = rows.map((r) => r.text);

    // Everything after the final rule is the agent's own status bar.
    const ruleIdxs = [];
    raw.forEach((l, i) => {
      if (ruleLabel(l.trim()) !== null) ruleIdxs.push(i);
    });
    const lastRule = ruleIdxs.length ? ruleIdxs[ruleIdxs.length - 1] : -1;
    const prevRule = ruleIdxs.length > 1 ? ruleIdxs[ruleIdxs.length - 2] : -1;

    /* The final pair of rules frames the terminal's own input box - whatever
       is typed on the desktop, plus any autocomplete menu it has opened. That
       is live UI state, not conversation, so it must not render as a past
       user message. Lift it out and let the caller show it next to the phone's
       own composer instead. */
    let inputStart = -1;
    let inputEnd = -1;
    if (prevRule >= 0 && lastRule - prevRule <= 12) {
      inputStart = prevRule + 1;
      inputEnd = lastRule - 1;
    }
    // The status bar names the current mode; shift+tab cycles through them.
    let mode = "";
    if (lastRule >= 0) {
      const tail = raw.slice(lastRule + 1).join(" ");
      const m = /\b(auto|plan|manual|accept edits|bypass\w*)\s+mode\b/i.exec(tail);
      if (m) mode = m[1].toLowerCase();
    }

    const liveInput =
      inputStart >= 0
        ? raw
            .slice(inputStart, inputEnd + 1)
            .join(" ")
            .replace(/^[\s\u00a0]*❯[\s\u00a0]*/, "")
            .replace(/\s+/g, " ")
            .trim()
        : "";

    const blocks = [];
    let current = "assistant";
    raw.forEach((line, i) => {
      // Drop the input box's contents and its closing rule; the opening rule
      // stays because it carries the session title.
      if (inputStart >= 0 && i >= inputStart && i <= lastRule) return;

      const trimmed = line.trim();
      let cls = classifyLine(trimmed);

      if (lastRule >= 0 && i > lastRule && cls !== "rule") cls = "status";

      if (cls === "rule") {
        const label = ruleLabel(trimmed);
        const prev = blocks[blocks.length - 1];
        // Collapse runs of rules, but let a captioned one win.
        if (prev && prev.cls === "rule") {
          if (label) prev.label = label;
          return;
        }
        blocks.push({ cls: "rule", label, rows: [] });
        return;
      }

      if (cls === null) {
        cls = current; // continuation line inherits the active block
      } else {
        current = cls;
      }

      const last = blocks[blocks.length - 1];
      if (last && last.cls === cls) last.rows.push(rows[i]);
      else blocks.push({ cls, rows: [rows[i]] });
    });

    // Drop leading/trailing empties inside each block, then empty blocks.
    const kept = blocks.filter((b) => {
      if (b.cls === "rule") return true;
      while (b.rows.length && !b.rows[0].text.trim()) b.rows.shift();
      while (b.rows.length && !b.rows[b.rows.length - 1].text.trim()) b.rows.pop();
      return b.rows.length > 0;
    });

    return { blocks: kept, liveInput, mode };
  }

  /* What the desktop currently has typed into the pane, mirrored above the
     phone's composer so the two inputs do not look like one. */
  function renderLiveInput(textValue) {
    const show = Boolean(textValue);
    elTerminalInputRow.classList.toggle("hidden", !show);
    if (show) elTerminalInput.textContent = textValue;
  }

  function renderTranscript(text) {
    if (!text) {
      renderLiveInput("");
      elHistoryContent.innerHTML =
        '<div class="history-empty">(No output recorded yet)</div>';
      return;
    }

    // Resolve each block to its final text, dropping the ones that render
    // to nothing: an empty input box, or the status bar when hidden.
    const parsed = parseTranscript(text);
    renderLiveInput(parsed.liveInput);
    state.mode = parsed.mode;
    elModeCurrent.textContent = parsed.mode || "unknown";

    const visible = [];
    for (const b of parsed.blocks) {
      if (b.cls === "rule") {
        visible.push({ cls: "rule", label: b.label });
        continue;
      }
      if (b.cls === "status" && !state.showStatusBar) continue;

      // Tables need their padding; everywhere else a long run of rule glyphs
      // is decoration that would wrap across several phone lines.
      const collapse = b.cls !== "table";
      const rows = b.rows.map((row) => {
        let runs = row.runs;
        if (b.cls === "status") {
          // Status lines are padded across the full terminal width.
          runs = runs.map((r) => ({ ...r, text: r.text.replace(/\s{3,}/g, "  ·  ") }));
        }
        if (collapse) {
          runs = runs.map((r) => ({ ...r, text: r.text.replace(RE_INLINE_RULE, "$1$1$1") }));
        }
        return runs;
      });

      const plain = rows.map(runsText).join("\n").trim();
      // A bare marker is an empty prompt box, not content.
      if (!plain.replace(/^[❯⏺⎿✻✽✳※]/, "").trim()) continue;

      visible.push({ cls: b.cls, html: rows.map(runsToHtml).join("\n") });
    }

    // Separators only mean something between two blocks.
    const trimmed = [];
    for (const b of visible) {
      if (b.cls === "rule" && (!trimmed.length || trimmed[trimmed.length - 1].cls === "rule")) {
        continue;
      }
      trimmed.push(b);
    }
    while (trimmed.length && trimmed[trimmed.length - 1].cls === "rule") trimmed.pop();

    const html = trimmed
      .map((b) => {
        if (b.cls !== "rule") {
          return `<div class="t-block t-${b.cls}">${b.html}</div>`;
        }
        return b.label
          ? `<div class="t-rule-label"><span>${escapeHtml(b.label)}</span></div>`
          : '<div class="t-rule"></div>';
      })
      .join("");

    elHistoryContent.innerHTML =
      html || '<div class="history-empty">(No output recorded yet)</div>';
  }

  // Fetch Agent List
  async function fetchAgents() {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error("Failed to fetch agents");
      const data = await res.json();
      setConnected(true);

      state.agents = data.agents || [];
      renderAgentBar();

      // If no agent selected or active agent no longer exists, select first available
      if (
        !state.activePaneId ||
        !state.agents.some((a) => a.pane_id === state.activePaneId)
      ) {
        if (state.agents.length > 0) {
          selectAgent(state.agents[0].pane_id);
        } else {
          state.activePaneId = null;
          renderActiveAgentMeta();
          elHistoryContent.innerHTML = '<div class="history-empty">No active agents in Herdr.</div>';
        }
      } else {
        renderActiveAgentMeta();
      }
    } catch (err) {
      console.warn("fetchAgents error:", err);
      setConnected(false);
    }
  }

  // Header button showing the current project
  function renderAgentBar() {
    const agent = state.agents.find((a) => a.pane_id === state.activePaneId);
    elAgentSelectName.textContent = agent
      ? agent.name || agent.pane_id
      : state.agents.length
      ? "Select project"
      : "No agents";
    elAgentSelectDot.className = `agent-dot ${agent ? agent.status || "unknown" : "unknown"}`;

    if (!elAgentPicker.classList.contains("hidden")) renderAgentList();
  }

  // Full-screen project list
  function renderAgentList() {
    if (state.agents.length === 0) {
      elAgentList.innerHTML = '<div class="history-empty">No active agents in Herdr.</div>';
      return;
    }

    elAgentList.innerHTML = state.agents
      .map((agent) => {
        const isActive = agent.pane_id === state.activePaneId;
        const status = agent.status || "unknown";
        const subtitle = agent.title || agent.cwd || "";
        return `
          <div class="agent-row-wrap">
            <button class="agent-row-delete" data-workspace-id="${agent.workspace_id}">Close</button>
            <button class="agent-row ${isActive ? "active" : ""}" data-pane-id="${agent.pane_id}">
              <span class="agent-dot ${status}"></span>
              <span class="agent-row-text">
                <span class="agent-row-name">${escapeHtml(agent.name || agent.pane_id)}</span>
                <span class="agent-row-title">${escapeHtml(subtitle)}</span>
              </span>
              <span class="status-badge status-${status}">${escapeHtml(status)}</span>
            </button>
          </div>
        `;
      })
      .join("");
  }

  async function createWorkspace() {
    triggerHaptic();
    const before = new Set(state.agents.map((a) => a.workspace_id));
    try {
      const res = await fetch("/api/workspaces", { method: "POST" });
      if (!res.ok) throw new Error("create failed");
      await fetchAgents();
      // Open the one that was not there a moment ago.
      const created = state.agents.find((a) => !before.has(a.workspace_id));
      if (created) selectAgent(created.pane_id);
      else closePicker();
    } catch (err) {
      alert("Could not create workspace: " + err.message);
    }
  }

  async function closeWorkspace(workspaceId) {
    if (!workspaceId) return;
    const target = state.agents.find((a) => a.workspace_id === workspaceId);
    const name = target ? target.name : "this workspace";
    // Closing kills every agent inside, and a stray swipe on a phone is cheap
    // to make and expensive to undo.
    if (!confirm(`Close ${name}? Any agents running in it will be stopped.`)) {
      resetSwipe();
      return;
    }
    triggerHaptic("warning");
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/close`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("close failed");
      if (state.agents.find((a) => a.pane_id === state.activePaneId)?.workspace_id === workspaceId) {
        state.activePaneId = null;
      }
      resetSwipe();
      await fetchAgents();
      renderAgentList();
    } catch (err) {
      alert("Could not close workspace: " + err.message);
    }
  }

  function openPicker() {
    triggerHaptic();
    renderAgentList();
    elAgentPicker.classList.remove("hidden");
  }

  function closePicker() {
    elAgentPicker.classList.add("hidden");
  }

  // Select an Agent
  function selectAgent(paneId) {
    if (state.activePaneId === paneId) {
      closePicker();
      return;
    }
    closePicker();
    state.activePaneId = paneId;
    state.historyText = "";
    elHistoryContent.innerHTML = '<div class="history-empty">Loading…</div>';
    triggerHaptic();

    renderAgentBar();
    renderActiveAgentMeta();
    fetchHistory(true);
  }

  // Render Metadata (lives in the settings sheet)
  function renderActiveAgentMeta() {
    const agent = state.agents.find((a) => a.pane_id === state.activePaneId);
    if (!agent) {
      elAgentTitle.textContent = "No agent selected";
      elAgentCwd.textContent = "";
      elAgentStatus.className = "status-badge status-unknown";
      elAgentStatus.textContent = "--";
      return;
    }

    elAgentTitle.textContent = agent.title || agent.name || agent.pane_id;
    elAgentCwd.textContent = agent.cwd || "";

    const status = agent.status || "unknown";
    elAgentStatus.className = `status-badge status-${status}`;
    elAgentStatus.textContent = status;
  }

  // Fetch Agent History
  async function fetchHistory(forceScroll = false) {
    if (!state.activePaneId) return;

    try {
      const url = `/api/agents/${encodeURIComponent(state.activePaneId)}/history?lines=${state.linesCount}&source=recent_unwrapped&format=ansi`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch history");
      const data = await res.json();
      setConnected(true);

      const newText = data.text || "";
      if (newText !== state.historyText) {
        state.historyText = newText;
        renderTranscript(newText);

        // Auto-scroll to bottom if user hasn't scrolled up, or if forced
        if (!state.isUserScrolledUp || forceScroll) {
          scrollToBottom();
        }
      }
    } catch (err) {
      console.warn("fetchHistory error:", err);
      setConnected(false);
    }
  }

  // Scroll to Bottom
  function scrollToBottom(smooth = false) {
    if (smooth) {
      elHistoryContainer.scrollTo({
        top: elHistoryContainer.scrollHeight,
        behavior: "smooth",
      });
    } else {
      elHistoryContainer.scrollTop = elHistoryContainer.scrollHeight;
    }
    state.isUserScrolledUp = false;
    updateScrollButton();
  }

  // Check scroll position
  function onHistoryScroll() {
    const threshold = 80;
    const distanceToBottom =
      elHistoryContainer.scrollHeight -
      elHistoryContainer.scrollTop -
      elHistoryContainer.clientHeight;

    state.isUserScrolledUp = distanceToBottom > threshold;
    updateScrollButton();
  }

  function updateScrollButton() {
    elBtnScrollBottom.classList.toggle("hidden", !state.isUserScrolledUp);
  }

  // Settings sheet
  function openSheet() {
    triggerHaptic();
    elSheet.classList.remove("hidden");
    elSheetBackdrop.classList.remove("hidden");
  }

  function closeSheet() {
    elSheet.classList.add("hidden");
    elSheetBackdrop.classList.add("hidden");
  }

  // Send Prompt
  async function submitPrompt(e) {
    if (e) e.preventDefault();
    const text = elPromptInput.value.trim();
    if (!text || !state.activePaneId || state.isSending) return;

    state.isSending = true;
    elBtnSend.disabled = true;
    triggerHaptic();

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(state.activePaneId)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const errData = await res.json();
        alert("Prompt failed: " + (errData.error?.message || errData.error || "Unknown error"));
        return;
      }

      // Success
      elPromptInput.value = "";
      hideCompletions();
      autoResizeTextarea();
      elBtnSend.disabled = true;

      state.isUserScrolledUp = false;
      setTimeout(() => {
        fetchAgents();
        fetchHistory(true);
      }, 300);
    } catch (err) {
      alert("Error sending prompt: " + err.message);
    } finally {
      state.isSending = false;
    }
  }

  // Send Key Action
  async function sendKey(key) {
    if (!state.activePaneId) return;
    triggerHaptic("warning");

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(state.activePaneId)}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      if (res.ok) {
        setTimeout(() => fetchHistory(true), 300);
      }
    } catch (err) {
      console.error("Failed to send key:", err);
    }
  }

  // Copy visible history text
  async function copyHistory() {
    if (!state.historyText) return;
    try {
      await navigator.clipboard.writeText(state.historyText.replace(RE_SGR, ""));
      triggerHaptic();
      const origText = elBtnCopy.textContent;
      elBtnCopy.textContent = "Copied!";
      setTimeout(() => {
        elBtnCopy.textContent = origText;
      }, 1500);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  }

  /* Path completion for an @token, rooted at the pane's working directory.
     Typing a path on a phone keyboard is the slowest thing here, and the cwd
     is the one piece of context the gateway can complete against reliably -
     there is no completion RPC, and slash commands are not enumerable. */
  let completeTimer = null;
  let completeAbort = null;

  /// The @token immediately before the caret, or null.
  function activeToken() {
    const pos = elPromptInput.selectionStart ?? elPromptInput.value.length;
    const upto = elPromptInput.value.slice(0, pos);
    const match = /(^|\s)@(\S*)$/.exec(upto);
    if (!match) return null;
    return { query: match[2], start: pos - match[2].length };
  }

  function hideCompletions() {
    elCompleteBar.classList.add("hidden");
    elCompleteBar.innerHTML = "";
  }

  function scheduleCompletion() {
    clearTimeout(completeTimer);
    const token = activeToken();
    if (!token || !state.activePaneId) {
      hideCompletions();
      return;
    }
    completeTimer = setTimeout(() => fetchCompletions(token.query), 130);
  }

  async function fetchCompletions(query) {
    if (completeAbort) completeAbort.abort();
    completeAbort = new AbortController();
    try {
      const url = `/api/agents/${encodeURIComponent(state.activePaneId)}/files?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: completeAbort.signal });
      if (!res.ok) return hideCompletions();
      const data = await res.json();
      renderCompletions(data.entries || []);
    } catch (err) {
      if (err.name !== "AbortError") hideCompletions();
    }
  }

  function renderCompletions(entries) {
    if (!entries.length) return hideCompletions();
    elCompleteBar.innerHTML = entries
      .map(
        (e) =>
          `<button type="button" class="complete-chip${e.is_dir ? " is-dir" : ""}" data-path="${escapeHtml(e.path)}" data-dir="${e.is_dir ? 1 : 0}">${escapeHtml(e.name)}${e.is_dir ? "/" : ""}</button>`
      )
      .join("");
    elCompleteBar.classList.remove("hidden");
  }

  /// Replace the token under the caret; a directory stays open for the next segment.
  function applyCompletion(path, isDir) {
    const token = activeToken();
    if (!token) return;
    const value = elPromptInput.value;
    const insert = path + (isDir ? "/" : " ");
    elPromptInput.value = value.slice(0, token.start) + insert + value.slice(token.start + token.query.length);
    const caret = token.start + insert.length;
    elPromptInput.setSelectionRange(caret, caret);
    elPromptInput.focus();
    autoResizeTextarea();
    triggerHaptic();
    if (isDir) scheduleCompletion();
    else hideCompletions();
  }

  // Keep focus in the composer when a chip is pressed.
  elCompleteBar.addEventListener("mousedown", (e) => e.preventDefault());

  elCompleteBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".complete-chip");
    if (chip) applyCompletion(chip.dataset.path, chip.dataset.dir === "1");
  });

  // Auto-resize textarea
  function autoResizeTextarea() {
    const focused = elPromptInput.classList.contains("expanded");
    const cap = focused
      ? Math.max(140, Math.round(window.innerHeight * 0.4))
      : 120;
    elPromptInput.style.height = "auto";
    elPromptInput.style.height = `${Math.min(elPromptInput.scrollHeight, cap)}px`;
    elBtnSend.disabled = elPromptInput.value.trim().length === 0;
  }

  // Poll loop
  async function loop() {
    await fetchAgents();
    await fetchHistory();
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(loop, state.pollInterval);
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  // Utilities
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Preferences that should survive a reload
  function loadPrefs() {
    try {
      const lines = parseInt(localStorage.getItem("herdr.lines"), 10);
      if (lines) {
        state.linesCount = lines;
        elLinesSelect.value = String(lines);
      }
      state.showStatusBar = localStorage.getItem("herdr.statusbar") === "1";
      elToggleStatusBar.checked = state.showStatusBar;
      setKeysBar(localStorage.getItem("herdr.keys") !== "0");
    } catch (err) {
      /* localStorage unavailable in private mode; defaults are fine */
    }
  }

  function savePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      /* ignore */
    }
  }

  // Event Listeners
  elAgentSelect.addEventListener("click", openPicker);
  elBtnClosePicker.addEventListener("click", closePicker);

  elAgentList.addEventListener("click", (e) => {
    const del = e.target.closest(".agent-row-delete");
    if (del) {
      closeWorkspace(del.dataset.workspaceId);
      return;
    }
    const row = e.target.closest(".agent-row");
    if (!row) return;
    // A tap on a swiped-open row puts it back rather than selecting it.
    if (row.classList.contains("swiped")) {
      resetSwipe();
      return;
    }
    if (row.dataset.paneId) selectAgent(row.dataset.paneId);
  });

  /* Swipe a row left to reveal Close, iOS style. The reveal is the
     confirmation step, so the second tap acts immediately. */
  const SWIPE_WIDTH = 92;
  let swipe = null;

  function resetSwipe() {
    elAgentList.querySelectorAll(".agent-row.swiped").forEach((r) => {
      r.classList.remove("swiped");
      r.style.transform = "";
    });
  }

  elAgentList.addEventListener("touchstart", (e) => {
    const row = e.target.closest(".agent-row");
    if (!row) return;
    if (!row.classList.contains("swiped")) resetSwipe();
    swipe = { row, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, axis: null };
  }, { passive: true });

  elAgentList.addEventListener("touchmove", (e) => {
    if (!swipe) return;
    const dx = e.touches[0].clientX - swipe.x;
    const dy = e.touches[0].clientY - swipe.y;
    if (swipe.axis === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (swipe.axis !== "x") return; // let the list scroll
    const base = swipe.row.classList.contains("swiped") ? -SWIPE_WIDTH : 0;
    swipe.dx = Math.max(-SWIPE_WIDTH, Math.min(0, base + dx));
    swipe.row.style.transition = "none";
    swipe.row.style.transform = `translateX(${swipe.dx}px)`;
  }, { passive: true });

  elAgentList.addEventListener("touchend", () => {
    if (!swipe) return;
    const { row, dx, axis } = swipe;
    swipe = null;
    if (axis !== "x") return;
    row.style.transition = "";
    const open = dx < -SWIPE_WIDTH / 2;
    row.classList.toggle("swiped", open);
    row.style.transform = open ? `translateX(${-SWIPE_WIDTH}px)` : "";
    if (open) triggerHaptic();
  }, { passive: true });

  elBtnNewWorkspace.addEventListener("click", createWorkspace);

  elBtnRefresh.addEventListener("click", () => {
    triggerHaptic();
    loop();
  });

  elBtnSettings.addEventListener("click", openSheet);
  elBtnCloseSheet.addEventListener("click", closeSheet);
  elSheetBackdrop.addEventListener("click", closeSheet);

  elHistoryContainer.addEventListener("scroll", onHistoryScroll, { passive: true });
  elBtnScrollBottom.addEventListener("click", () => scrollToBottom(true));

  elPromptInput.addEventListener("input", () => {
    autoResizeTextarea();
    scheduleCompletion();
  });
  // Tapping a chip blurs the textarea, so the bar must outlive the blur long
  // enough for the click to land on it.
  elPromptInput.addEventListener("blur", () => {
    setTimeout(hideCompletions, 250);
  });
  // Enter inserts a newline (iOS shows a return key); the button sends.
  elPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitPrompt();
    }
  });

  // Give the composer room while it has focus.
  elPromptInput.addEventListener("focus", () => {
    elPromptInput.classList.add("expanded");
    autoResizeTextarea();
    setTimeout(() => {
      syncViewportHeight();
      scrollToBottom();
    }, 150);
  });

  elPromptInput.addEventListener("blur", () => {
    elPromptInput.classList.remove("expanded");
    autoResizeTextarea();
  });

  elPromptForm.addEventListener("submit", submitPrompt);

  elBtnCtrlC.addEventListener("click", () => {
    if (confirm("Send interrupt (Ctrl+C) to agent?")) {
      sendKey("ctrl+c");
    }
  });

  elBtnEsc.addEventListener("click", () => sendKey("esc"));

  // Pull the desktop's draft into the composer to carry on editing it here.
  elBtnAdopt.addEventListener("click", () => {
    const draft = elTerminalInput.textContent.trim();
    if (!draft) return;
    triggerHaptic();
    const existing = elPromptInput.value.trim();
    elPromptInput.value = existing ? `${existing} ${draft}` : draft;
    elPromptInput.focus();
    autoResizeTextarea();
  });
  elBtnCopy.addEventListener("click", copyHistory);

  elLinesSelect.addEventListener("change", (e) => {
    state.linesCount = parseInt(e.target.value, 10) || 100;
    savePref("herdr.lines", String(state.linesCount));
    fetchHistory(true);
  });

  // Key palette: the single keypresses agents ask for at confirmation prompts.
  function setKeysBar(show) {
    state.showKeys = show;
    elKeysBar.classList.toggle("hidden", !show);
    elBtnKeys.classList.toggle("active", show);
    savePref("herdr.keys", show ? "1" : "0");
  }

  elBtnKeys.addEventListener("click", () => {
    triggerHaptic();
    setKeysBar(!state.showKeys);
  });

  elKeysBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".key-btn");
    if (btn && btn.dataset.key) sendKey(btn.dataset.key);
  });

  // shift+tab cycles the agent between auto, manual and plan mode.
  elBtnCycleMode.addEventListener("click", async () => {
    await sendKey("shift+tab");
    setTimeout(() => fetchHistory(true), 400);
  });

  elToggleStatusBar.addEventListener("change", (e) => {
    state.showStatusBar = e.target.checked;
    savePref("herdr.statusbar", state.showStatusBar ? "1" : "0");
    renderTranscript(state.historyText);
    scrollToBottom();
  });

  /* iOS does not reliably reflow a fixed, dvh-sized layout when the keyboard
     opens, which pushes the header off screen. Drive the height from the
     visual viewport instead so the top bar stays put and the transcript, not
     the chrome, is what shrinks. */
  function syncViewportHeight() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
    document.documentElement.style.setProperty("--app-offset", `${vv.offsetTop}px`);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
    window.visualViewport.addEventListener("scroll", syncViewportHeight);
    syncViewportHeight();
  }

  /* Web Push. iOS only allows this for a PWA opened from the home screen,
     and only when permission is requested inside a user gesture - hence the
     toggle rather than an automatic prompt on load. */
  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window;
  }

  function setPushHint(text) {
    elPushHint.textContent = text || "";
  }

  async function refreshPushState() {
    if (!pushSupported()) {
      elTogglePush.disabled = true;
      setPushHint(
        window.matchMedia("(display-mode: standalone)").matches
          ? "not supported by this browser"
          : "add to Home Screen first"
      );
      return;
    }
    if (Notification.permission === "denied") {
      elTogglePush.disabled = true;
      elTogglePush.checked = false;
      setPushHint("blocked in iOS Settings");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      elTogglePush.checked = Boolean(sub);
      setPushHint(sub ? "on for this device" : "");
    } catch (err) {
      setPushHint("unavailable");
    }
  }

  async function enablePush() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      elTogglePush.checked = false;
      setPushHint(permission === "denied" ? "blocked in iOS Settings" : "not granted");
      return;
    }
    const info = await (await fetch("/api/push/info")).json();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.public_key),
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    setPushHint("on for this device");
    triggerHaptic();
  }

  async function disablePush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    setPushHint("");
  }

  elTogglePush.addEventListener("change", async (e) => {
    try {
      if (e.target.checked) await enablePush();
      else await disablePush();
    } catch (err) {
      elTogglePush.checked = false;
      setPushHint("failed: " + err.message);
    }
  });

  if (pushSupported()) {
    navigator.serviceWorker
      .register("/sw.js")
      .then(refreshPushState)
      .catch(() => setPushHint("service worker failed"));
  } else {
    refreshPushState();
  }

  // Handle page visibility for battery savings & wake-up
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      loop();
      startPolling();
    }
  });

  // Init
  loadPrefs();
  autoResizeTextarea();
  loop();
  startPolling();
})();
