// Sheep It - the phone client for the SheepIt gateway

(function () {
  let state = {
    agents: [],
    /* The headless chats, kept apart from the panes on purpose. They are rows
       in the same list, but they are not panes - no workspace, no tab strip,
       no transcript - and everything from the badge to the bleat walks
       `state.agents` assuming one. They have a tab of their own in the flock,
       drawn from `state.chatPens` (`orderChats`). */
    chats: [],
    chatPens: [],
    // Which half of the flock is on screen: "projects" or "chats".
    flockTab: "projects",
    activePaneId: null,
    // Which headless chat the wide layout's right column is showing, if any.
    activeChatId: null,
    chatVisible: false,
    historyText: "",
    linesCount: 400,
    // What a desktop's right column shows of a Claude Code pane.
    paneView: "transcript",
    diffSplit: false,
    numberKeys: 3,
    badgeCount: -1,
    activity: {},
    drafts: {},
    order: [],
    customOrder: [],
    // Folders the projects are filed in, and what the list draws at its top
    // level: projects and folders in order (`layoutGroups`).
    folders: [],
    layout: [],
    // What is folded shut on this device (`toggleCollapsed`).
    collapsed: new Set(),
    groups: [],
    // The flock is what the app opens on: a chat is something you go into.
    pickerOpen: true,
    bleat: true,
    statuses: null,
    showKeys: true,
    mode: "",
    isUserScrolledUp: false,
    pollInterval: 2000,
    timer: null,
    isSending: false,
    listSignature: null,
    swiping: false,
    queue: [],
    settling: new Map(),
    quota: null,
    quotaAt: 0,
    // Off until asked for: the strip answers a question about the laptop, not
    // about the agents, and most glances at the flock are not asking it.
    machineStrip: false,
    queueSignature: null,
    queueRequest: 0,
    editingId: null,
    listTouchedAt: 0,
    chatVisited: false,
    // The tokens page, which is only ever read while it is open: `rows` stays
    // null until it has been, so opening it knows to say it is reading.
    usage: { days: 7, rows: null, columns: null, picked: -1, scrubbing: false, error: "" },
    // The changed-files listing, by path: what a row needs when it opens.
    changedFiles: {},
    // Transcript text that arrived while something in it was selected.
    heldHistory: null,
    // What has been sent to each chat, oldest first, for the recall arrow.
    history: {},
    recall: { at: -1, text: null },
  };

  // DOM Elements
  const elAgentSelect = document.getElementById("agent-select");
  const elAgentSelectDot = document.getElementById("agent-select-dot");
  const elAgentSelectName = document.getElementById("agent-select-name");
  const elTabStrip = document.getElementById("tab-strip");
  const elAgentPicker = document.getElementById("agent-picker");
  const elPickerHead = elAgentPicker.querySelector(".picker-head");
  const elAgentList = document.getElementById("agent-list");
  const elBtnClosePicker = document.getElementById("btn-close-picker");
  const elBtnNewWorkspace = document.getElementById("btn-new-workspace");
  const elFlockTabs = document.getElementById("flock-tabs");
  const elHistoryContainer = document.getElementById("history-container");
  const elHistoryContent = document.getElementById("history-content");
  const elBtnScrollBottom = document.getElementById("btn-scroll-bottom");
  const elPromptForm = document.getElementById("prompt-form");
  const elPromptInput = document.getElementById("prompt-input");
  const elTerminalInput = document.getElementById("terminal-input");
  const elCompleteBar = document.getElementById("complete-bar");
  const elBtnAttach = document.getElementById("btn-attach");
  const elBtnPasteImage = document.getElementById("btn-paste-image");
  const elAttachInput = document.getElementById("attach-input");
  const elAttachStrip = document.getElementById("attach-strip");
  const elTerminalInputRow = document.getElementById("terminal-input-row");
  const elBtnAdopt = document.getElementById("btn-adopt");
  const elBtnUnadopt = document.getElementById("btn-unadopt");
  const elBtnCycleMode = document.getElementById("btn-cycle-mode");
  const elBtnKeys = document.getElementById("btn-keys");
  const elComposerMenu = document.getElementById("composer-menu");
  const elBtnMore = document.getElementById("btn-more");
  const elComposerMenuPanel = document.getElementById("composer-menu-panel");
  const elKeysBar = document.getElementById("keys-bar");
  const elKeysNumbers = document.getElementById("keys-numbers");
  const elModeCurrent = document.getElementById("mode-current");
  const elBtnRecall = document.getElementById("btn-recall");
  const elBtnSend = document.getElementById("btn-send");
  const elComposerStop = document.getElementById("chat-btn-stop");
  const elBtnCtrlC = document.getElementById("btn-ctrl-c");
  const elBtnEsc = document.getElementById("btn-esc");
  // The palette opens from the composer's icon row, anchored above the box.
  elPromptForm.appendChild(elKeysBar);
  const elBtnCopy = document.getElementById("btn-copy");
  const elSheetBackdrop = document.getElementById("sheet-backdrop");
  const elNewSheet = document.getElementById("new-sheet");
  const elNewSheetTitle = document.getElementById("new-sheet-title");
  const elNewSheetBody = document.getElementById("new-sheet-body");
  const elBtnCloseNewSheet = document.getElementById("btn-close-new-sheet");
  const elTogglePush = document.getElementById("toggle-push");
  const elToggleBleat = document.getElementById("toggle-bleat");
  const elToggleMachine = document.getElementById("toggle-machine");
  const elPushHint = document.getElementById("push-hint");
  const elBtnTestPush = document.getElementById("btn-test-push");
  const elGlobalSettingsView = document.getElementById("global-settings-view");
  const elChatHomePath = document.getElementById("chat-home-path");
  const elBtnChatHome = document.getElementById("btn-chat-home");
  const elBtnCloseGlobalSettings = document.getElementById("btn-close-global-settings");
  const elBtnFlockSettings = document.getElementById("btn-flock-settings");
  const elBtnAddHeartbeat = document.getElementById("btn-add-heartbeat");
  const elHeartbeatsList = document.getElementById("heartbeats-list");
  const elPickerQuota = document.getElementById("picker-quota");
  const elChatQueue = document.getElementById("chat-queue");
  const elViewSwitcher = document.getElementById("view-switcher");
  const elBtnConsole = document.getElementById("btn-console");
  const elBtnViewNormal = document.getElementById("btn-view-normal");
  const elConsoleView = document.getElementById("console-view");
  const elAppHeader = document.querySelector(".app-header");
  const syncAppHeaderHeight = () => {
    document.documentElement.style.setProperty(
      "--app-header-height",
      `${elAppHeader.getBoundingClientRect().height}px`,
    );
  };
  if (window.ResizeObserver) {
    new ResizeObserver(syncAppHeaderHeight).observe(elAppHeader);
  } else {
    window.addEventListener("resize", syncAppHeaderHeight);
  }
  syncAppHeaderHeight();
  const elConsoleTerm = document.getElementById("console-term");
  const elConsoleSub = document.getElementById("console-sub");
  const elConsoleKeys = document.getElementById("console-keys");
  const elBtnChanges = document.getElementById("btn-changes");
  const elBtnPaneChat = document.getElementById("btn-pane-chat");
  const elChatView = document.getElementById("chat-chat-view");
  let chatTarget = "";
  const elChangesView = document.getElementById("changes-view");
  const elChangesList = document.getElementById("changes-list");
  const elChangesSub = document.getElementById("changes-sub");
  const elChangesCount = document.getElementById("changes-count");
  const elBtnCloseChanges = document.getElementById("btn-close-changes");
  const elBtnDiffLayout = document.getElementById("btn-diff-layout");
  const elBtnUsage = document.getElementById("btn-usage");
  const elUsageView = document.getElementById("usage-view");
  const elUsageBody = document.getElementById("usage-body");
  const elUsageSub = document.getElementById("usage-sub");
  const elUsageRanges = document.getElementById("usage-ranges");
  const elBtnCloseUsage = document.getElementById("btn-close-usage");

  /* A phone stacks: the flock is the page, a chat covers it. A desktop window
     has room for both, so past this width the flock is a column on the left
     that nothing closes and the chat opens beside it. The same breakpoint is
     in style.css; the layout is the stylesheet's, this is only what the app
     has to know about it. */
  const wide = window.matchMedia("(min-width: 900px)");

  /* Whether this machine has a pointer that can hover, which is what decides
     between the icons on a row and the drawer behind it. The same query is in
     `style.css`, which is what actually hides each of them; this is only what
     the gestures have to know about it. */
  const mouse = window.matchMedia("(hover: hover) and (pointer: fine)");

  function pickerVisible() {
    return wide.matches || !elAgentPicker.classList.contains("hidden");
  }

  /* The bleat an agent gets when it stops working, while you are looking at
     the app. iOS will not let a page make noise until it has been touched
     once, so the context is created and the file decoded on the first
     interaction and kept for the rest of the session. */
  const BLEAT_URL = "/bleat.wav";
  let audioCtx = null;
  let bleatBuffer = null;

  async function unlockAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const res = await fetch(BLEAT_URL);
      bleatBuffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
    } catch (err) {
      audioCtx = null; // no audio this session; everything else still works
    }
  }

  function playBleat() {
    if (!state.bleat || !audioCtx || !bleatBuffer) return;
    if (document.hidden) return; // never bleat from a backgrounded tab
    try {
      const src = audioCtx.createBufferSource();
      src.buffer = bleatBuffer;
      const gain = audioCtx.createGain();
      gain.gain.value = 0.55;
      src.connect(gain).connect(audioCtx.destination);
      src.start();
    } catch (err) {
      /* context died with the page going to sleep; nothing to do */
    }
  }

  /* One bleat per batch, however many agents landed at once - eight sheep at
     the same instant is a farmyard, not a notification. */
  function bleatForFinished(agents) {
    const now = {};
    for (const a of agents) {
      if (a.pane_id) now[a.pane_id] = a.has_agent ? a.status : null;
    }
    const before = state.statuses;
    state.statuses = now;
    if (!before) return; // first sweep: everything looks new, nothing finished
    /* The same event the gateway pushes for: an agent that was working has
       stopped somewhere it needs you. Bleating at `idle` too meant a sheep
       answered every interrupt and every `/clear`. */
    const finished = Object.keys(now).some(
      (id) => before[id] === "working" && WAITING.includes(now[id])
    );
    if (finished) playBleat();
  }

  // Haptic feedback helper
  function triggerHaptic(type = "light") {
    if (navigator.vibrate) {
      if (type === "warning") navigator.vibrate([30, 50, 30]);
      else navigator.vibrate(12);
    }
  }

  /* ---------------------------------------------------------------------
   * Transcript rows
   *
   * Preserve the pane's screen as it arrived, including the terminal's own
   * frame and status lines. ANSI SGR colors are retained for legibility; the
   * small amount of parsing below only feeds the composer mirror and keypad.
   * ------------------------------------------------------------------- */

  const RE_SGR = /\x1b\[([0-9;]*)m/g;

  /* Split one ANSI line into styled runs, carrying the SGR state in `st` so
     attributes opened on an earlier line keep applying. Only colors the
     terminal actually sets are emitted; everything else inherits the
     transcript's default color. */
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

  const RE_URL = /https?:\/\/[^\s<>"'`]+/g;

  function linkifyHtml(html) {
    return html.replace(RE_URL, (rawUrl) => {
      let url = rawUrl;
      let trail = "";
      while (url.length > 0) {
        if (url.endsWith("&quot;")) {
          url = url.slice(0, -6);
          trail = "&quot;" + trail;
        } else if (url.endsWith("&gt;")) {
          url = url.slice(0, -4);
          trail = "&gt;" + trail;
        } else if (url.endsWith("&lt;")) {
          url = url.slice(0, -4);
          trail = "&lt;" + trail;
        } else if (url.endsWith("&#39;")) {
          url = url.slice(0, -5);
          trail = "&#39;" + trail;
        } else if (url.endsWith("&amp;")) {
          url = url.slice(0, -5);
          trail = "&amp;" + trail;
        } else if (/[.,:;!?'"\]]$/.test(url)) {
          trail = url.slice(-1) + trail;
          url = url.slice(0, -1);
        } else if (url.endsWith(")")) {
          const openCount = (url.match(/\(/g) || []).length;
          const closeCount = (url.match(/\)/g) || []).length;
          if (closeCount > openCount) {
            trail = ")" + trail;
            url = url.slice(0, -1);
          } else {
            break;
          }
        } else {
          break;
        }
      }
      if (!url) return rawUrl;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
    });
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
        const text = linkifyHtml(escapeHtml(r.text));
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
  // Composer and selection hints are read from the raw rows only; they affect
  // the mirror and keypad, never which transcript rows are shown.
  const RE_OPTION = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s/;
  const RE_PROMPT_HINT = /Enter to select|keys? to navigate|Enter to confirm/i;
  const RE_SELECT_HINT = /Esc to cancel|Esc to reject/i;
  const RE_COMPOSER = /^[❯›](?:\s|$)/;
  const RE_PLACEHOLDER = /^(?:ask codex to do anything|try ".*")$/i;
  const TAIL_REACH = 24;

  function parseTranscript(text) {
    const st = { fg: null, bg: null, bold: false, italic: false, underline: false };
    const rows = text.split("\n").map((line) => {
      const runs = rtrimRuns(ansiRuns(line.replace(/\r/g, ""), st));
      return { runs, text: runsText(runs) };
    });
    const raw = rows.map((row) => row.text);
    const floor = Math.max(0, raw.length - TAIL_REACH);
    let liveInput = "";
    for (let i = raw.length - 1; i >= floor; i--) {
      const trimmed = raw[i].trim();
      if (!RE_COMPOSER.test(trimmed) || RE_OPTION.test(trimmed)) continue;
      const value = trimmed.replace(RE_COMPOSER, "").trim();
      liveInput = RE_PLACEHOLDER.test(value) ? "" : value;
      break;
    }

    let mode = "";
    const modeMatch = raw.slice(Math.max(0, raw.length - 6)).join(" ")
      .match(/\b(auto|plan|manual|accept edits|bypass\w*)\s+mode\b/i);
    if (modeMatch) mode = modeMatch[1].toLowerCase();

    let hintIndex = -1;
    for (let i = floor; i < raw.length; i++) {
      if (RE_PROMPT_HINT.test(raw[i]) || RE_SELECT_HINT.test(raw[i])) hintIndex = i;
    }
    let optionCount = 0;
    if (hintIndex >= 0 && (RE_PROMPT_HINT.test(raw[hintIndex]) || RE_SELECT_HINT.test(raw[hintIndex]))) {
      const labels = new Set();
      for (let i = floor; i <= hintIndex; i++) {
        const option = RE_OPTION.exec(raw[i]);
        if (option) labels.add(Number(option[1]));
      }
      while (labels.has(optionCount + 1)) optionCount++;
    }
    return { rows, liveInput, mode, optionCount };
  }

  function transcriptHtml(rows) {
    return `<div class="t-block t-transcript">${rows
      .map((row) => runsToHtml(row.runs))
      .join("\n")}</div>`;
  }

  function renderTranscript(text) {
    if (!text) {
      renderLiveInput("");
      renderNumberKeys(0);
      state.mode = "";
      elModeCurrent.textContent = "unknown";
      elHistoryContent.innerHTML = '<div class="history-empty">(No output recorded yet)</div>';
      return;
    }
    const parsed = parseTranscript(text);
    renderLiveInput(parsed.liveInput);
    renderNumberKeys(parsed.optionCount);
    state.mode = parsed.mode;
    elModeCurrent.textContent = parsed.mode || "unknown";
    elHistoryContent.innerHTML = transcriptHtml(parsed.rows);
  }

  /* What the desktop currently has typed into the pane, mirrored above the
     phone's composer so the two inputs do not look like one. */
  function renderLiveInput(textValue) {
    // A headless chat has no console, whatever the pane behind it has typed.
    const show = Boolean(textValue) && !state.activeChatId;
    elTerminalInputRow.classList.toggle("hidden", !show);
    if (show) elTerminalInput.textContent = textValue;
  }

  /* The keypad ships with 1-3, but a prompt can list more - or fewer - and a
     choice you cannot press is the same as no choice at all. Follow whatever
     the current prompt actually offers, never dropping below the three keys
     the pad is built around. It stops at nine: a tenth choice has no single
     key behind it - both agents act on the first digit typed - so the arrows
     and enter are how you reach it. */
  function renderNumberKeys(count) {
    const want = Math.min(Math.max(count || 0, 3), 9);
    if (want === state.numberKeys) return;
    state.numberKeys = want;
    elKeysNumbers.innerHTML = Array.from({ length: want }, (_, i) => {
      const n = i + 1;
      return `<button type="button" class="key-btn" data-key="${n}">${n}</button>`;
    }).join("");
  }

  // An older poll must not replace a list fetched after creating a pane or chat.
  let agentsRequest = 0;

  // Fetch Agent List
  async function fetchAgents() {
    const request = ++agentsRequest;
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error("Failed to fetch agents");
      const data = await res.json();
      if (request !== agentsRequest) return;
      state.agents = data.agents || [];
      state.chats = data.chats || [];
      // Deleted from another phone, or reaped: the column cannot keep showing it.
      if (state.activeChatId && !state.chats.some((c) => c.id === state.activeChatId)) {
        state.activeChatId = null;
      }
      bleatForFinished(state.agents);
      trackActivity();
      orderAgents();
      renderAgentBar();
      updateBadge();

      // If no agent selected or active agent no longer exists, select first available
      if (
        !state.activeChatId && (
          !state.activePaneId ||
          !state.agents.some((a) => a.pane_id === state.activePaneId)
        )
      ) {
        // The first agent on screen, or failing that the first row there is:
        // a project whose tabs are all plain shells is still worth opening.
        const first = state.agents.find((a) => a.has_agent) || state.agents[0];
        if (first) {
          // Reload into the pane's default view: Chat when this pane supports
          // it, otherwise Normal on mobile or Console on desktop.
          selectAgent(first.pane_id);
        } else {
          state.activePaneId = null;
          syncPickerChrome();
          // Nothing open means nothing to switch between: the strip goes with
          // the chat it belonged to rather than being left standing.
          renderTabStrip();
          elHistoryContent.innerHTML = '<div class="history-empty">No active agents in Herdr.</div>';
        }
      } else {
      }
    } catch (err) {
      console.warn("fetchAgents error:", err);
    }
  }

  /* iOS freezes the home screen icon at install time, so the badge on it is
     the only thing that can still change - it counts the agents waiting on
     you, and clears itself as you answer them. Needs an installed web app and
     granted notification permission; anywhere else the call is simply absent
     or a no-op.

     Waiting means a turn that ended with nobody looking at it yet, or a
     question on screen. A pane parked at its prompt is not waiting for
     anything, and counting those kept a number on the icon all day. */
  const WAITING = ["done", "blocked"];

  function updateBadge() {
    if (!("setAppBadge" in navigator)) return;
    /* A chat holding a permission prompt counts the same as a pane holding
       one: the badge is how many things are waiting on you, and where they
       are waiting is not something a number on a home screen can say. */
    const waiting = state.agents.filter(
      (a) => a.has_agent && WAITING.includes(a.status)
    ).length + state.chats.filter((c) => c.pending && c.pending.length).length;
    if (waiting === state.badgeCount) return;
    state.badgeCount = waiting;
    const done = waiting > 0 ? navigator.setAppBadge(waiting) : navigator.clearAppBadge();
    Promise.resolve(done).catch(() => {
      // Permission not granted: badges stay hidden, nothing else breaks.
    });
  }

  /* Keep the project selector on the worktree name; the tab strip and view
     switcher already say which tab and surface are open. */
  function agentBarName(row) {
    return row.workspace_label || row.name || row.pane_id;
  }

  function paneHasChat(agent) {
    return !!agent && ["claude", "codex"].includes(agent.agent);
  }

  // Header button showing the current project
  function renderAgentBar() {
    /* A headless chat has no pane, transcript, Console or Changed Files view;
       its conversation occupies the app's main content area. */
    const chat = state.activeChatId
      && state.chats.find((c) => c.id === state.activeChatId);
    if (chat) {
      elAgentSelectName.textContent = chat.title || "New chat";
      elAgentSelectDot.className = `agent-dot ${chatStatus(chat)}`;
      elViewSwitcher.classList.add("hidden");
      elBtnChanges.classList.add("hidden");
      document.getElementById("chat-btn-delete").classList.remove("hidden");
      renderChatSurface(encodeURIComponent(chat.id));
      /* The strip is compared against what it last drew before it is replaced,
         so hiding it here has to forget that - otherwise coming back to a pane
         whose tabs have not changed leaves the strip hidden. */
      elTabStrip.classList.add("hidden");
      tabStripDrawn = null;
      if (pickerVisible()) renderAgentList();
      return;
    }

    const agent = state.agents.find((a) => a.pane_id === state.activePaneId);
    elViewSwitcher.classList.toggle("hidden", !agent);
    elBtnChanges.classList.remove("hidden");
    document.getElementById("chat-btn-delete").classList.add("hidden");
    const chattable = paneHasChat(agent);
    const chatShowing = chattable && (state.chatVisible || (wide.matches && state.paneView === "chat"));
    if (!chatShowing) {
      const working = !!agent && agent.status === "working";
      elComposerStop.classList.toggle("normal-visible", working);
      elComposerStop.classList.toggle("hidden", !working);
    }
    if (agent) {
      const name = agentBarName(agent);
      elAgentSelectName.textContent = chatShowing ? `${name} · ${tabChipLabel(agent)}` : name;
    } else {
      elAgentSelectName.textContent = state.agents.length ? "Select project" : "No agents";
    }
    elAgentSelectDot.className = `agent-dot ${agent ? displayedStatus(agent) : "unknown"}`;
    // Pane chat reads both Claude Code and Codex session logs.
    elBtnPaneChat.classList.toggle("hidden", !chattable);
    elBtnViewNormal.classList.toggle("hidden", chattable || wide.matches);
    const consoleShowing = !elConsoleView.classList.contains("hidden");
    elBtnPaneChat.setAttribute("aria-pressed", String(!consoleShowing && chatShowing));
    elBtnViewNormal.setAttribute("aria-pressed", String(!consoleShowing && !chatShowing));
    elBtnConsole.setAttribute("aria-pressed", String(consoleShowing));
    renderChatSurface(chattable ? "pane:" + agent.pane_id : "");

    renderTabStrip();
    if (pickerVisible()) renderAgentList();
  }

  /* A sheep per tab, the same animal the home screen icon shows. Colour
     carries the status, but so does the posture: an agent that is working
     grazes, one that is idle stands with its head up, a blocked one pricks its
     ear at you, and a finished one lies down to sleep. A pane with no agent is
     a shell, and draws one - a black terminal with a sheep standing on it.
     Drawn inline so the fleece can inherit the row's colour instead of
     shipping five copies of the file. */
  const POSE = {
    working: "graze",
    idle: "stand",
    done: "sleep",
    blocked: "alert",
    unknown: "empty",
  };

  /* ------------------------------------------------------- Telling them apart
   *
   * Two agents on one project used to be the same animal twice, and grouping
   * the list by project is exactly what puts them side by side.
   *
   * The first answer here was paint - a raddle mark in a hashed colour - which
   * works on a real hillside and worked here too, until you ask what you
   * actually recognise a sheep by. It is not the mark. It is the shape: horns
   * or no horns, woolly or shorn, and then the colour of the animal itself.
   * Shape survives a glance too fast to register hue, and colour you can name
   * - "the black one with horns" is a thing you can hold in your head, where
   * "the one with the teal blob on its flank" is a thing you have to decode.
   *
   * So the sheep is identity, whole: breed, horns, coat. Nine breeds, three
   * horns, three coats - 81 animals, most of which differ in silhouette
   * before they differ in colour.
   *
   * That is only possible because status moved off the animal and onto the
   * row: see `.agent-row` in the stylesheet, where a five-pixel spine down the
   * left edge carries what the fleece used to. The pose still carries it too -
   * grazing, head up, ear pricked, asleep - but a pose is not enough on its
   * own for `blocked`, which is the one state that must never be missed.
   * ------------------------------------------------------------------------ */

  /* FNV-1a, because the ids being hashed are short and nearly identical -
     "wE:p1" and "wJ:p1" differ in one character, and a weaker hash hands them
     the same animal. */
  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /* Breeds, near enough to real ones to be nameable: a white sheep with a
     black face is a Suffolk, a dark one with a pale face is a badger face.
     Each carries its own face colour rather than picking one at random,
     because the pairing is what makes it read as an animal - and because a
     face has to stay off its own fleece to be a face at all.

     `patch` is a second fleece colour for the spotted ones. */
  const BREEDS = [
    { id: "white", fleece: "#eef1f6", face: "#ccd4e1" },
    { id: "suffolk", fleece: "#e9edf4", face: "#2c3242" },
    { id: "cream", fleece: "#e8dcb9", face: "#b8a878" },
    { id: "oatmeal", fleece: "#d8c9a8", face: "#6f6650" },
    { id: "tan", fleece: "#cfa26b", face: "#a97c49" },
    { id: "saddle", fleece: "#d9b98a", face: "#7a5636", patch: "#6b4a2f", mark: "saddle" },
    { id: "brown", fleece: "#8d5c3c", face: "#e0d4c4" },
    { id: "grey", fleece: "#9aa2b1", face: "#6d7688" },
    /* The dark end of the palette cannot be told apart by shade - at this size
       charcoal, black and a badger face are one animal three times. So only
       one of them is a plain dark sheep; the others carry a pattern, which
       reads at a glance where four points of lightness do not. */
    { id: "dalmatian", fleece: "#474f61", face: "#d7dce6", patch: "#eef1f6", mark: "dots" },
    { id: "black", fleece: "#2f3543", face: "#1d222c" },
    { id: "badger", fleece: "#5c6678", face: "#e3e8f1", patch: "#e8edf6", mark: "belt" },
    { id: "spotted", fleece: "#edf0f6", face: "#8d5c3c", patch: "#8d5c3c", mark: "spots" },
    { id: "jacob", fleece: "#c3c9d4", face: "#333a49", patch: "#333a49", mark: "spots" },
  ];

  /* Fleece patterns, clipped to whatever body the coat drew - a dot that falls
     off a shorn sheep's slimmer barrel is a dot lying in the grass. */
  const MARKS = {
    spots: '<circle cx="13.5" cy="16.5" r="4.6"/><circle cx="27" cy="13.5" r="3.8"/>',
    dots: [
      [10, 14, 1.9], [15.5, 11, 1.7], [20.5, 15.5, 2], [25, 10.5, 1.7],
      [29.5, 14.5, 1.9], [13, 21, 1.7], [19, 21.5, 1.6], [25.5, 20.5, 1.8],
      [32, 19.5, 1.5], [8.5, 19, 1.5],
    ].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join(""),
    belt: '<rect x="14" y="0" width="7.5" height="34" rx="0.5"/>',
    saddle: '<path d="M6 4 h26 v9 q-13 4 -26 0 z"/>',
  };

  /* Horns: the cue that is supposed to survive being small, and the first
     attempt did not. It curled *back over* the skull, inside the fleece, in
     bone - which on a white sheep is pale on pale, inside the outline, where
     it changes nothing at all about the shape.

     A horn has to leave the silhouette to be one. These rise off the top of
     the head and sweep back above the fleece line, so what changes is the
     animal's edge against the card - and they are coloured against the fleece
     rather than in a fixed bone, the way the eye is coloured against the
     face. */
  const HORNS = {
    none: "",
    // Half a turn: up, back, and hooked down behind the ear.
    curl: "M0 0 c-1.4 -3.2 -5.2 -4 -7 -1.4 c-1.4 2 -0.2 4.2 1.8 4.4",
    // A full one, the ram's.
    spiral: "M0 0 c-1.6 -3.8 -6.4 -5 -8.6 -1.8 c-1.9 2.8 -0.2 6 3 6 c2.4 0 3.6 -1.9 2.8 -3.6 c-0.6 -1.3 -2.3 -1.5 -3.2 -0.5",
  };
  const HORN_KINDS = ["none", "curl", "spiral"];

  // Woolly, shorn, or woolly with a fringe down over the eyes.
  const COATS = ["woolly", "shorn", "fringe"];

  function sheepMarks(seed) {
    const hash = fnv1a(String(seed || ""));
    return {
      breed: BREEDS[hash % BREEDS.length],
      horn: HORN_KINDS[(hash >>> 5) % HORN_KINDS.length],
      coat: COATS[(hash >>> 11) % COATS.length],
      // A dark muzzle on a pale face, a pale one on a dark face. Real, and it
      // is the cheapest way to tell two of one breed apart.
      muzzle: ((hash >>> 17) & 1) === 1,
    };
  }

  /* The body, in two passes.

     A black sheep on a dark card is a hole in the row unless something draws
     its edge, and stroking the shapes themselves puts a line through every
     place two of them overlap - the fleece would come out as a diagram of the
     circles it is made of. So the same shapes are drawn twice: once in the
     card's colour with a fat stroke, and once filled on top. The first pass
     leaves a halo, the second covers every internal line of it. */
  function sheepBody(dy, legs, marks, clip) {
    const woolly = `
      ${legs ? '<rect x="11" y="21" width="5" height="12" rx="2.5"/>' : ""}
      ${legs ? '<rect x="23" y="21" width="5" height="12" rx="2.5"/>' : ""}
      <circle cx="11.5" cy="16" r="7.5"/>
      <circle cx="18" cy="11" r="8"/>
      <circle cx="25.5" cy="11.5" r="7.5"/>
      <circle cx="31" cy="16" r="7"/>
      <rect x="5" y="13" width="27" height="13" rx="6.5"/>`;
    /* Shorn: the same animal a week after the clippers. Ellipses rather than a
       rounded rectangle - a shorn sheep is a barrel that tapers into the neck,
       and a box with round corners reads as furniture. */
    const shorn = `
      ${legs ? '<rect x="12" y="21" width="4.4" height="13" rx="2.2"/>' : ""}
      ${legs ? '<rect x="23.5" y="21" width="4.4" height="13" rx="2.2"/>' : ""}
      <ellipse cx="17" cy="18.5" rx="13" ry="7.4"/>
      <ellipse cx="27.5" cy="16.5" rx="7" ry="6.2"/>`;
    const shape = marks.coat === "shorn" ? shorn : woolly;
    const mark = MARKS[marks.breed.mark];
    /* Clipped to the body the coat actually drew, so a pattern cannot spill
       off a slimmer sheep - and defined per drawing, because several of these
       share one page. */
    const pattern = mark
      ? `<clipPath id="${clip}">${shape}</clipPath>
         <g clip-path="url(#${clip})" fill="${marks.breed.patch}">${mark}</g>`
      : "";
    const rim = rimFor(marks.breed.fleece);
    const rimStyle = rim ? ` style="fill:${rim};stroke:${rim}"` : "";
    return `
      <g transform="translate(0 ${dy})">
        <g class="sheep-edge"${rimStyle}>${shape}</g>
        <g fill="currentColor">${shape}</g>
        ${pattern}
      </g>`;
  }

  /* A horn placed on a head: the card-coloured stroke underneath is the same
     outline the face and ear carry, and it is what keeps a pale horn off a
     pale fleece and a dark one off the card. */
  /* Where a horn is planted is not a matter of taste: it has to leave the
     fleece, or it changes no outline and is not doing the job horns are here
     for. The head is in a different place in every pose and the low ones -
     grazing, asleep - are where the first attempt failed, because a horn
     curling up off a lowered skull curls straight into the body. These four
     placements were searched for rather than eyeballed: each keeps the horn
     off the face and the eye, inside the canvas, and mostly outside the
     silhouette. `tools/test-flock.js` holds that last part. */
  function hornAt(marks, x, y, rotate) {
    const path = HORNS[marks.horn];
    if (!path) return "";
    const at = `translate(${x} ${y}) rotate(${rotate})`;
    return `
      <g transform="${at}" fill="none" stroke-linecap="round">
        <path class="sheep-horn-edge" d="${path}"/>
        <path class="sheep-horn" d="${path}" style="stroke:${hornOn(marks.breed.fleece)}"/>
      </g>`;
  }

  /* Dark horn on a pale sheep, bone on a dark one. Horn is keratin and comes in
     both, so the one that can be seen is the right one. */
  function hornOn(fleece) {
    return isLight(fleece) ? "#4a4235" : "#e4d9bd";
  }

  /* A fringe hangs off the forehead, so it belongs to the head rather than the
     body - and it has to actually cross the face. As a soft ellipse tucked
     above the brow it was fleece-coloured wool over a pale face, which is to
     say invisible. Scalloped and sitting on the face, its card-coloured edge
     draws a line across the brow that reads at any size. */
  const FRINGE = "M-5.6 -2.6 h11.2 v1.4 q-1.9 2.9 -3.8 0 q-1.9 2.9 -3.8 0 q-1.9 2.9 -3.8 0 z";

  function fringeAt(x, y, rotate) {
    return `
      <g transform="translate(${x} ${y}) rotate(${rotate})">
        <path class="sheep-fringe" d="${FRINGE}"/>
      </g>`;
  }

  /* Where the horn and the fringe go in each pose: [x, y, rotation]. Data
     rather than four hand-placed pairs, so the test can take the real numbers
     and check the horn actually leaves the fleece - which is the property that
     has now been got wrong twice. */
  const HEAD_AT = {
    graze: { horn: [38, 15, 110], fringe: [36.4, 17.4, 18] },
    stand: { horn: [38, 8.2, 40], fringe: [36.2, 10.4, 0] },
    alert: { horn: [36.4, 6.2, 15], fringe: [36.6, 8, -6] },
    sleep: { horn: [38, 19.8, 110], fringe: [36.2, 22.6, 12] },
  };

  /* Each pose moves the head, so everything hanging off it - the ear, the
     horn, the fringe - is part of the pose rather than laid over the top. */
  const HEADS = {
    // Head down in the grass.
    graze: (m) => `
      <ellipse class="sheep-ear" cx="33.2" cy="15.2" rx="3" ry="1.8" transform="rotate(-42 33.2 15.2)"/>
      ${hornAt(m, ...HEAD_AT.graze.horn)}
      <ellipse class="sheep-face" cx="36.6" cy="19.4" rx="5.4" ry="4.6" style="fill:${m.breed.face}"/>
      ${m.muzzle ? `<ellipse class="sheep-muzzle" cx="39.5" cy="20.5" rx="2" ry="1.6" style="fill:${eyeOn(m.breed.face)}"/>` : ""}
      ${m.coat === "fringe" ? fringeAt(...HEAD_AT.graze.fringe) : ""}
      <circle class="sheep-eye" cx="38.2" cy="18" r="1.2" style="fill:${eyeOn(m.breed.face)}"/>`,
    // Head up, ear resting: done, waiting on you.
    stand: (m) => `
      <ellipse class="sheep-ear" cx="32.4" cy="9" rx="3" ry="1.8" transform="rotate(-38 32.4 9)"/>
      ${hornAt(m, ...HEAD_AT.stand.horn)}
      <ellipse class="sheep-face" cx="36.4" cy="12.6" rx="5.4" ry="4.6" style="fill:${m.breed.face}"/>
      ${m.muzzle ? `<ellipse class="sheep-muzzle" cx="39.3" cy="13.7" rx="2" ry="1.6" style="fill:${eyeOn(m.breed.face)}"/>` : ""}
      ${m.coat === "fringe" ? fringeAt(...HEAD_AT.stand.fringe) : ""}
      <circle class="sheep-eye" cx="38.2" cy="11.4" r="1.2" style="fill:${eyeOn(m.breed.face)}"/>`,
    // Ear pricked straight up: something is asking for an answer.
    alert: (m) => `
      <ellipse class="sheep-ear" cx="33.6" cy="6.2" rx="3.2" ry="1.7" transform="rotate(-72 33.6 6.2)"/>
      ${hornAt(m, ...HEAD_AT.alert.horn)}
      <ellipse class="sheep-face" cx="36.8" cy="10.2" rx="5.4" ry="4.6" style="fill:${m.breed.face}"/>
      ${m.muzzle ? `<ellipse class="sheep-muzzle" cx="39.7" cy="11.3" rx="2" ry="1.6" style="fill:${eyeOn(m.breed.face)}"/>` : ""}
      ${m.coat === "fringe" ? fringeAt(...HEAD_AT.alert.fringe) : ""}
      <circle class="sheep-eye" cx="38.6" cy="8.8" r="1.3" style="fill:${eyeOn(m.breed.face)}"/>`,
    // Lying down, eye shut, legs folded under.
    sleep: (m) => `
      <ellipse class="sheep-ear" cx="32.6" cy="20.4" rx="3" ry="1.8" transform="rotate(-30 32.6 20.4)"/>
      ${hornAt(m, ...HEAD_AT.sleep.horn)}
      <ellipse class="sheep-face" cx="36.4" cy="24.6" rx="5.4" ry="4.6" style="fill:${m.breed.face}"/>
      ${m.muzzle ? `<ellipse class="sheep-muzzle" cx="39.3" cy="25.7" rx="2" ry="1.6" style="fill:${eyeOn(m.breed.face)}"/>` : ""}
      ${m.coat === "fringe" ? fringeAt(...HEAD_AT.sleep.fringe) : ""}
      <path class="sheep-lid" d="M36.4 24.2 q1.6 1.4 3.2 0"/>`,
  };

  function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) > 110;
  }

  /* An eye has to be the opposite of the face it sits in: a dark pupil on a
     black-faced Suffolk is not a subtle eye, it is no eye. */
  function eyeOn(face) {
    return isLight(face) ? "#12161f" : "#e8edf6";
  }

  /* The rim around the whole animal, and the thing the first version got
     backwards. It was the card's own colour, which cannot by definition
     separate a dark sheep from the card - a black one was a hole in the row
     rather than an animal in it.

     A pale sheep needs no rim at all against a dark card, so it keeps the
     card-coloured one (the stylesheet swaps that for the selected row's colour
     on its own). A dark one gets a light rim instead: its own fleece mixed
     halfway to a pale grey, so the halo still belongs to that animal rather
     than outlining every dark sheep in the same white. */
  function rimFor(fleece) {
    if (isLight(fleece)) return "";
    const n = parseInt(fleece.slice(1), 16);
    const mix = (channel, towards) => Math.round(channel + (towards - channel) * 0.55);
    const rgb = [
      mix(n >> 16, 0xc6), mix((n >> 8) & 255, 0xcf), mix(n & 255, 0xdd),
    ];
    return `rgb(${rgb.join(",")})`;
  }

  /* Nobody home: a black terminal screen with a sheep standing on it. Bare
     ground was the first answer and it said the wrong thing - an empty field
     reads as an agent that has run out, which is the one thing the grass is
     for. A pane with no agent in it has not run out of anything; it is a
     shell, so it looks like one, and the sheep in it is the only one in the
     flock with no breed, no colour and nothing to be doing.

     The prompt is what makes the box a terminal rather than a card - drop the
     `>_` and this is a dark rectangle with an animal in it. The sheep is
     four overlapping circles rather than a traced outline, because they are
     one fill and so union without a seam, and because a fleece at this size
     is a silhouette with bumps on it and nothing else. Its eye is a hole back
     to the screen colour, so it stays an eye whatever the row behind it is. */
  const SHELL_WINDOW = `
      <rect class="shell-screen" x="1.5" y="4" width="41" height="26" rx="5"/>
      <rect class="shell-frame" x="1.5" y="4" width="41" height="26" rx="5"/>
      <g class="shell-prompt" transform="translate(4.6 12.6) scale(0.92)">
        <path d="M0 0 L3.2 2.8 L0 5.6"/>
        <path d="M4.6 6 H8.2"/>
      </g>
      <g class="shell-sheep" transform="translate(15 10.4) scale(0.92)">
        <g class="shell-sheep-under">
          <rect x="5.4" y="8.4" width="2.5" height="6.2" rx="1.2"/>
          <rect x="12.4" y="8.4" width="2.5" height="6.2" rx="1.2"/>
          <ellipse cx="19.2" cy="6.8" rx="3.9" ry="4.2"/>
          <ellipse cx="17.2" cy="2.4" rx="2.2" ry="1.4" transform="rotate(-35 17.2 2.4)"/>
        </g>
        <g class="shell-sheep-fleece">
          <circle cx="5.2" cy="6.6" r="4.2"/>
          <circle cx="9.5" cy="4.4" r="4.7"/>
          <circle cx="14" cy="6" r="4.3"/>
          <circle cx="9.9" cy="8.4" r="4.4"/>
        </g>
        <circle class="shell-sheep-eye" cx="20" cy="6.2" r="0.95"/>
      </g>`;

  /* ---------------------------------------------------------- The pasture ---
   *
   * The grass under a sheep is what its subscription has left. A fresh window
   * is a field it has barely started on; a spent one is stubble, which is the
   * same thing the queue means when it says it is holding - there is nothing
   * on the ground to feed a prompt with.
   *
   * The field goes blade by blade, from the far side in, and what is left of
   * it is the count. Cutting every blade down together was the first attempt
   * and it is the one thing this drawing cannot do: the grazing muzzle sits
   * eleven units above the ground, so a field cropped to a quarter left the
   * sheep chewing air nine units above the grass. The animal reads as standing
   * on a lawn, not eating one.
   *
   * So the tuft at the muzzle - the mouthful - is not part of the count. It is
   * always tall enough to reach a grazing head, because it is the bit the
   * sheep has hold of, and it is the only blade the chewing moves. The seven
   * behind it are the field, and they go one at a time from the far end, which
   * puts the bare patch away from the animal and keeps something under its
   * mouth until the window is actually gone.
   *
   * Eaten ground keeps its stubble. Bare ground and a pane whose usage nobody
   * can read would otherwise be one drawing, and those are opposite things to
   * know.
   *
   * The field belongs to the subscription rather than to the pane - every
   * Claude sheep on this machine eats the same one, and the Codex sheep eat
   * their own. `pastureOf` is what keys it that way.
   * ------------------------------------------------------------------------ */

  // Where the blades are rooted: low enough to be ground, high enough that a
  // leg still ends below it.
  const GROUND = 33;

  // x, how tall it stands, which way it leans. Seven, eaten from the left.
  const FIELD = [
    [4.5, 5.4, -1.4],
    [9, 7, 0.9],
    [13.5, 5, -1],
    [18, 6.6, 1.2],
    [22.5, 5.2, -0.8],
    [27, 7.2, 1],
    [31.5, 6, -1.2],
  ];

  /* The mouthful. Tall because it has to arrive at the muzzle, which the
     grazing pose puts at 39.5, 20.5 - `HEAD_AT.graze` is where that number
     comes from, and moving one means checking the other. */
  const MOUTHFUL = [38.6, 11.6, 1.3];

  // What eaten ground keeps.
  const STUBBLE = 1.3;

  /* How much of the field is still standing. Seven blades is a coarse gauge on
     purpose: it is read as how much green is left rather than counted, and a
     gauge that moves in sevenths redraws the row - and restarts every sheep
     mid-chew - seven times a window instead of continuously. */
  function bladesFor(left) {
    if (!(left > 0)) return 0;
    return Math.max(1, Math.min(FIELD.length, Math.round(left * FIELD.length)));
  }

  function blade(x, height, lean, extra) {
    const d = `M${x} ${GROUND} q${round1(lean * 0.4)} ${round1(-height * 0.55)} ${round1(lean)} ${round1(-height)}`;
    return `<path class="grass-blade${extra || ""}" d="${d}"/>`;
  }

  function stubble(x, lean) {
    return `<path class="grass-blade grass-stubble" d="M${x} ${GROUND} q${round1(lean * 0.2)} ${round1(-STUBBLE * 0.6)} ${round1(lean * 0.3)} ${round1(-STUBBLE)}"/>`;
  }

  function grassSvg(pasture) {
    // No reading is no field. A sheep with no subscription behind it - a shell,
    // an agent nobody can price - stands on the same plain ground it always did.
    if (!pasture) return "";
    const standing = bladesFor(pasture.left);
    const eaten = FIELD.length - standing;
    const blades = FIELD.map(([x, height, lean], i) =>
      i < eaten ? stubble(x, lean) : blade(x, height, lean)
    );
    /* A window with nothing left leaves nothing in its mouth either. A sheep
       still working through that is chewing at bare stubble, which is exactly
       the picture: the field it was spending is gone. */
    const [mx, mh, mlean] = MOUTHFUL;
    blades.push(standing ? blade(mx, mh, mlean, " grass-bite") : stubble(mx, mlean));
    return `<g class="grass${pasture.spent ? " spent" : ""}">${blades.join("")}</g>`;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  /* The statuses the app has a sheep, a colour and a class for - anything else
     Herdr grows later reads as unknown rather than an unstyled dot or a sheep
     that is not there. POSE is a plain object, so ask it what it owns:
     POSE["constructor"] is truthy and would draw nothing at all. */
  function knownStatus(status) {
    return Object.prototype.hasOwnProperty.call(POSE, status) ? status : "unknown";
  }

  /* A clip path is referenced by id, and the list draws a dozen of these into
     one document - so each drawing gets its own. The list is replaced whole on
     every redraw, so the counter never has to be tidied up. */
  let sheepSerial = 0;

  /* What tells a chat's sheep from a pane's at a glance. It sits over the
     rump rather than by the head - the head moves with every pose, and a
     bubble that jumps around the animal is one you have to find each time -
     and it is outlined in the card's colour like every other part laid over
     the fleece. Drawn inside the sheep's own viewBox, past its left edge,
     which `.sheep { overflow: visible }` already allows for the horns. */
  const CHAT_BUBBLE = `
    <g class="sheep-bubble">
      <path class="bubble-body" d="M-1 1.5 h13 a2.5 2.5 0 0 1 2.5 2.5 v4.5 a2.5 2.5 0 0 1 -2.5 2.5 h-5.5 l-3 3 v-3 h-4.5 a2.5 2.5 0 0 1 -2.5 -2.5 v-4.5 a2.5 2.5 0 0 1 2.5 -2.5 z"/>
      <circle class="bubble-dot" cx="2.5" cy="6.2" r="1"/>
      <circle class="bubble-dot" cx="6" cy="6.2" r="1"/>
      <circle class="bubble-dot" cx="9.5" cy="6.2" r="1"/>
    </g>`;

  function sheepSvg(status, seed, pasture, chatty) {
    const pose = POSE[knownStatus(status)];
    // A shell has nobody to tell apart, and no window to draw grass for.
    if (pose === "empty") {
      return `<svg class="sheep" viewBox="0 0 44 34" aria-hidden="true">${SHELL_WINDOW}</svg>`;
    }
    const marks = sheepMarks(seed);
    const asleep = pose === "sleep";
    /* The head is its own group so it can chew without the body doing it: a
       whole animal rocking is a sheep on a boat, a head dipping into the grass
       is a sheep eating. The grass goes on last, in front of the legs - a
       blade behind a leg is a blade nobody sees. */
    return `
      <svg class="sheep" viewBox="0 0 44 34" aria-hidden="true">
        ${sheepBody(asleep ? 5 : 0, !asleep, marks, `fleece-${++sheepSerial}`)}
        <g class="sheep-head">${HEADS[pose](marks)}</g>
        ${chatty ? CHAT_BUBBLE : ""}
        ${grassSvg(pasture)}
      </svg>`;
  }

  /* Everything a row draws. The picker is redrawn on every poll, and replacing
     its HTML restarts each sheep's graze mid-cycle and throws away the row a
     swipe is holding open - so redraw only when one of these actually moved.
     The projects' order is in here too, because it is the one thing that can
     change without any single row changing at all. */
  function agentListSignature() {
    const queued = queuedByPane();
    if (state.flockTab === "chats") {
      return "chats\u001d" + (state.chatPens || []).map((pen) => penMark(pen, queued)).join("\u001e");
    }
    /* The folders and what is folded shut: filing a project or folding one
       away moves no row at all, and is still a different list. */
    const shelves = (state.layout || [])
      .map((item) =>
        item.kind === "folder"
          ? [item.key, item.folder.name, item.groups.map((g) => g.key).join("\u001c")].join("\u001b")
          : item.key
      )
      .join("\u001a");
    const folded = [...(state.collapsed || [])].sort().join("\u001a");
    return shelves + "\u001d" + folded + "\u001d" + state.groups
      .map((group) =>
        [
          group.key,
          group.name,
          // Whether the heading can offer anything, which is not the same as
          // whether it can offer a worktree: a project with no checkout open
          // can still take a tab.
          (group.from ? "w" : "") + (group.rows.some((pen) => pen.workspace_id) ? "t" : ""),
          ...group.rows.map((pen) => penMark(pen, queued)),
        ].join("\u001e")
      )
      .join("\u001d");
  }

  // Everything one row draws, for the signature.
  function penMark(pen, queued) {
    return [
      pen.lead.pane_id,
      pen.workspace_id,
      // A tab opened or closed changes the row even when the pane
      // leading it did not move.
      tabCount(pen),
      pen.lead.status,
      pen.lead.has_agent ? "a" : "",
      pen.lead.busy ? "b" : "",
      pen.lead.name,
      tabName(pen.lead),
      pen.lead.title || pen.lead.cwd,
      rowAgo(pen.lead),
      queuedLabel(penQueue(pen, queued)),
      pastureMark(pastureOf(pen.lead.has_agent ? pen.lead.agent : "")),
      // Any of its tabs being the open one lights the row up: the
      // chat you came from is in this pen even when another tab leads.
      // A headless chat lights up the same way, from its own id.
      pen.chat
        ? (state.activeChatId === pen.chat.id ? "1" : "")
        : pen.tabs.some((a) => a.pane_id === state.activePaneId) ? "1" : "",
      // And every tab of a pen that has them out, since a second tab
      // going blocked moves nothing about the tab leading the pen.
      penTabsMark(pen, queued),
    ].join("\u001f");
  }

  /* A row under a heading that already names the project should not spend its
     biggest line saying the project again. What you are looking for is which
     of this project's worktrees this one is - so the terminal title of the tab
     leading it goes on top, since it is whatever you asked it to do, and the
     rest drops to the small line, and only when it says something the heading
     did not: the tab's name, "sheep #5", or a name you set by hand.

     A worktree with no agent in it has no title to lead with. It is called
     what the laptop's tab bar calls it, which is a name if anybody typed one
     and a number otherwise - and that is the whole point of listing it: the
     row you want at 11pm is often the one running the dev server. */
  /* What is still owed to each pane: prompts holding for a window or a busy
     chat, and anything that failed on the way in. Both are things you queued
     and neither has happened yet, so the overview says so rather than making
     you open the queue to find out. */
  function queuedByPane() {
    const counts = new Map();
    for (const p of state.queue) {
      const at = counts.get(p.pane_id) || { waiting: 0, failed: 0 };
      if (p.state === "failed") at.failed++;
      else at.waiting++;
      counts.set(p.pane_id, at);
    }
    return counts;
  }

  /* And what is owed to a whole pen, since the row stands for every tab in
     one: a prompt waiting on a worktree's second agent is still a prompt this
     worktree has not delivered. */
  function penQueue(pen, counts) {
    const total = { waiting: 0, failed: 0 };
    for (const a of pen.tabs) {
      const at = counts.get(a.pane_id);
      if (!at) continue;
      total.waiting += at.waiting;
      total.failed += at.failed;
    }
    return total.waiting || total.failed ? total : null;
  }

  function queuedLabel(count) {
    if (!count) return "";
    const bits = [];
    if (count.waiting) bits.push(`${count.waiting} queued`);
    if (count.failed) bits.push(`${count.failed} failed`);
    return bits.join(" · ");
  }

  /* The one word beside a row. What the agent is doing is already the spine
     down the card and the pose the sheep stands in, so when something is
     stacked behind it that is the more useful word: an agent that finished
     with a prompt still waiting is not "done", it is one prompt from starting
     again. A question on screen outranks even that - nothing is ever delivered
     into one, and it is the state that must never be buried.

     A pane with no agent uses its shell activity to show Idle or Working. */
  function statusBadge(agent, status, queued) {
    if (!agent.has_agent) {
      const shellStatus = agent.busy ? "working" : "idle";
      return `<span class="status-badge status-${shellStatus}">${escapeHtml(shellStatus)}</span>`;
    }
    const word = queued ? queuedLabel(queued) : "";
    if (!word || status === "blocked") {
      return `<span class="status-badge status-${status}">${escapeHtml(status)}</span>`;
    }
    return `<span class="status-badge status-${queued.failed ? "failed" : "queued"}">${escapeHtml(word)}</span>`;
  }

  /* When the row last moved. A pane's age is the last change this phone
     watched happen; a chat keeps its own timestamp, which is better - it
     survives a reload, where the pane's activity record is only as old as
     this tab is. */
  function rowAgo(row) {
    if (row.chat) return row.updated ? agoText(Date.now() - row.updated * 1000) : "";
    return agoLabel(row.pane_id);
  }

  /* ------------------------------------------------------- Icons on a row ---
   *
   * A mouse cannot swipe, so the drawer a finger drags a row aside for is a
   * gesture a desktop does not have. What it had instead was a `…` in the
   * corner on hover, which said a drawer was there and did nothing itself -
   * one more thing to learn before anything could be renamed.
   *
   * So the row actions are on the row, in the corner that hint used to sit in,
   * and only while the pointer is on it. The actions depend on the row: a
   * worktree renames and closes the workspace, a
   * tab of an opened pen renames and closes the tab, a chat has only Delete.
   * A linked worktree also offers Remove, which asks before deleting its
   * checkout. `style.css` hides the icons wherever there is no hover to reveal
   * them, which is every phone, and hides the drawer wherever there is.
   * ------------------------------------------------------------------------ */

  /* The action glyphs a row wears on a desktop. Drawn here rather than in
     `index.html` because the row is built in JS, and cut to the same stroke as
     the icons in the chrome: 24-wide box, `currentColor`, round caps. */
  const ICON_PENCIL =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
     </svg>`;

  const ICON_TRASH =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <polyline points="3 6 5 6 21 6"></polyline>
       <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
       <path d="M10 11v6M14 11v6"></path>
       <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
     </svg>`;

  const ICON_PLUS =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <line x1="12" y1="5" x2="12" y2="19"></line>
       <line x1="5" y1="12" x2="19" y2="12"></line>
     </svg>`;

  const ICON_REMOVE =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <path d="M3 7h18v13H3zM3 7l2-3h14l2 3"></path>
       <path d="M9 13l6 6M15 13l-6 6"></path>
     </svg>`;

  /* One cluster of them. `key` is the data attribute the click handler reads
     the target out of, which is whatever that action acts on - a workspace, a
     pane, a tab or a chat. */
  function rowToolsHtml(tools, cls) {
    const icons = tools.map(
      (t) => `
            <span class="row-tool${t.danger ? " danger" : ""}" role="button"
                  title="${escapeHtml(t.label)}" aria-label="${escapeHtml(t.label)}"
                  data-action="${t.action}" data-${t.key}="${escapeHtml(t.value)}">${t.icon}</span>`
    );
    return `<span class="${cls}">${icons.join("")}</span>`;
  }

  // The pointer controls offer the same workspace actions as the swipe drawer,
  // plus a new tab in this worktree - which a phone gets from the strip's +.
  // Only a linked worktree can have its checkout removed.
  function penTools(pen) {
    const tools = [
      { action: "tab-new", key: "workspace-id", value: pen.workspace_id,
        label: "New tab in this worktree", icon: ICON_PLUS },
      { action: "rename", key: "workspace-id", value: pen.workspace_id,
        label: "Rename this worktree", icon: ICON_PENCIL },
      { action: "close", key: "workspace-id", value: pen.workspace_id,
        label: "Close this worktree", icon: ICON_TRASH, danger: true },
    ];
    if (pen.lead.repo && !pen.lead.main_checkout) {
      tools.push({ action: "remove", key: "workspace-id", value: pen.workspace_id,
        label: "Remove this worktree and delete its checkout", icon: ICON_REMOVE, danger: true });
    }
    return tools;
  }

  /* A chat's row. Shorter than a pane's, because most of what a pane's row
     says is about the worktree it sits in and a chat has none: no tab count,
     no worktree name, nothing to rename and nothing to close. What is left is
     what it is about, what it costs and whether it is waiting on you.

     Delete is the only thing in the drawer, and it is the whole reason the
     list this replaced could be deleted from at all. */
  function chatRowHtml(pen) {
    const row = pen.lead;
    const chat = pen.chat;
    const status = knownStatus(row.status);
    const marks = sheepMarks(penSeed(pen));
    const pasture = pastureOf("claude");
    const chew = pasture && pasture.chew ? `--chew:${pasture.chew}` : "";
    const wrapStyle = [`color:${marks.breed.fleece}`, chew].filter(Boolean).join(";");
    // What it was told to do first, which is what the gateway titles it with.
    const headline = row.title || "New chat";
    const sub = [chat.model || "default", chat.mode].filter(Boolean).join(" · ");
    return `
      <div class="agent-row-wrap">
        <div class="agent-row-actions">
          <button class="agent-row-action remove" data-action="chat-delete" data-chat-id="${escapeHtml(chat.id)}">Delete</button>
        </div>
        <button class="agent-row st-${status} chat-row ${state.activeChatId === chat.id ? "active" : ""}" data-chat-id="${escapeHtml(chat.id)}">
          <span class="sheep-wrap ${status}" style="${wrapStyle}">${sheepSvg(status, penSeed(pen), pasture, true)}</span>
          <span class="agent-row-text">
            <span class="agent-row-name">${escapeHtml(headline)}</span>
            <span class="agent-row-meta">
              <span class="row-agent">chat</span>
              ${sub ? `<span class="agent-row-title">${escapeHtml(sub)}</span>` : ""}
            </span>
          </span>
          <span class="agent-row-side">
            ${statusBadge(row, status, null)}
            <span class="agent-row-ago">${escapeHtml(rowAgo(row))}</span>
          </span>
          ${rowToolsHtml(
            [{ action: "chat-delete", key: "chat-id", value: chat.id,
               label: "Delete this chat", icon: ICON_TRASH, danger: true }],
            "row-tools"
          )}
        </button>
      </div>
    `;
  }

  function sheepStatus(agent) {
    const status = knownStatus(agent.status);
    // Herdr can identify a Codex pane while its activity status is unknown.
    // A terminal icon means no agent is present, so draw a standing sheep.
    return status === "unknown" && agent.has_agent ? "idle" : status;
  }

  function displayedStatus(agent) {
    const status = knownStatus(agent.status);
    return status === "unknown" && agent.has_agent && agent.agent === "codex"
      ? "idle" : status;
  }

  function agentRowHtml(pen, groupName, queued) {
    if (pen.chat) return chatRowHtml(pen);
    // The tab that speaks for the pen: whichever of them needs you most.
    const agent = pen.lead;
    // The open chat being anywhere in this pen lights the row up - it is the
    // pen you came from, whichever of its tabs is leading it now.
    const isActive = pen.tabs.some((a) => a.pane_id === state.activePaneId);
    const status = displayedStatus(agent);
    const label = agent.name || agent.pane_id;
    const named = tabName(agent);
    // Herdr's own number for the tab, when it has one: a pane the gateway
    // could not place has nothing but the project's name to fall back on.
    const numbered = tabNumber(agent) ? `tab ${tabNumber(agent)}` : "";
    const headline = agent.title || named || numbered || label;
    /* The fleece is whose sheep it is - and whose is the worktree, not the
       tab. Hashing the workspace keeps one animal per pen however its tabs
       come and go; hashing the leading pane would change the face every time
       another tab started asking something. */
    const iconStatus = sheepStatus(agent);
    const fleece = iconStatus === "unknown"
      ? ""
      : `color:${sheepMarks(penSeed(pen)).breed.fleece}`;
    /* What this pane's subscription has left, and how fast it is going: the
       first is the height of the grass, the second is how quickly the sheep
       chews it. A shell has no subscription and so no field. */
    const pasture = pastureOf(agent.has_agent ? agent.agent : "");
    const chew = pasture && pasture.chew ? `--chew:${pasture.chew}` : "";
    const wrapStyle = [fleece, chew].filter(Boolean).join(";");
    let sub = "";
    if (named && named !== headline) sub = named;
    else if (label !== headline && label !== groupName) sub = label;
    else if (!agent.title) sub = agent.cwd || "";
    /* Removing the checkout is offered on a worktree and never on the project
       itself: Close leaves a worktree's copy of the tree on disk, which is the
       right answer for a project you will open again on Monday and the wrong
       one for a branch that was finished with last week. The project's own
       checkout is not something the phone may delete at all. */
    const removable = agent.repo && !agent.main_checkout;
    return `
      <div class="agent-row-wrap">
        <div class="agent-row-actions">
          <button class="agent-row-action rename" data-action="rename" data-workspace-id="${escapeHtml(pen.workspace_id)}">Rename</button>
          <button class="agent-row-action close" data-action="close" data-workspace-id="${escapeHtml(pen.workspace_id)}">Close</button>
          ${removable
            ? `<button class="agent-row-action remove" data-action="remove" data-workspace-id="${escapeHtml(pen.workspace_id)}">Remove</button>`
            : ""}
        </div>
        <button class="agent-row st-${status} ${isActive ? "active" : ""}" data-pane-id="${escapeHtml(agent.pane_id)}">
          <span class="sheep-wrap ${iconStatus}"${wrapStyle ? ` style="${wrapStyle}"` : ""}>${sheepSvg(iconStatus, penSeed(pen), pasture, false)}</span>
          <span class="agent-row-text">
            <span class="agent-row-name">${escapeHtml(headline)}</span>
            <span class="agent-row-meta">
              ${agent.has_agent && agent.agent
                ? `<span class="row-agent">${escapeHtml(agent.agent)}</span>`
                : ""}
              ${sub ? `<span class="agent-row-title">${escapeHtml(sub)}</span>` : ""}
            </span>
          </span>
          <span class="agent-row-side">
            ${statusBadge(agent, status, queued)}
            <span class="agent-row-ago">${escapeHtml(rowAgo(agent))}</span>
          </span>
          ${rowToolsHtml(penTools(pen), "row-tools")}
        </button>
      </div>
    `;
  }

  /* ------------------------------------------------ A pen with its tabs out
   *
   * One row per workspace is honest right up to the moment a workspace has a
   * second tab in it. Then the row draws whichever tab needs you most and the
   * other one is a number in the corner - so the tab you were looking for is
   * the one that lost the tie, and the only way to it is through the strip
   * above somebody else's transcript.
   *
   * So a pen with more than one tab hangs them out: the worktree's title on a
   * line of its own, and one sheep per tab underneath it, indented and joined
   * to that title by a bracket down the left. The pen is still one thing -
   * Rename, Close and Remove still take the whole worktree and still live on
   * the title, where they read as what they do - and each tab carries the two
   * a strip offers it, renaming and closing itself and nothing else.
   * ---------------------------------------------------------------------- */

  // Whether a pen draws its tabs rather than standing in front of them. A
  // headless chat has no tabs at all, and one tab is already one row.
  function penShowsTabs(pen) {
    return !pen.chat && tabCount(pen) > 1;
  }

  // In the order the strip has them, so the two places that list a workspace's
  // tabs cannot disagree about which one is first.
  function penTabs(pen) {
    return pen.tabs.slice().sort(
      (a, b) =>
        (Number(tabNumber(a)) || 0) - (Number(tabNumber(b)) || 0) || bornAt(a) - bornAt(b)
    );
  }

  /* The title the tabs hang off. Quieter than a row - everything in this
     worktree that is doing something is drawn directly underneath it, so all
     the title has to say is which worktree this is - but the same colour as
     them, because it is part of the same pen. Tapping it opens the tab that
     needs you most, which is what the collapsed row did.

     The action icons are for a pointer: a mouse has no swipe, so the drawer
     behind the row is a gesture it cannot make, and the two things a title is
     asked for most are on the row itself. `style.css` hides them wherever
     there is no hover to reveal them, which is every phone. A linked
     worktree also offers Remove here; removeWorktree asks before deletion. */
  function penHeadHtml(pen, folded) {
    const lead = pen.lead;
    const label = lead.workspace_label || lead.name || pen.workspace_id;
    const removable = lead.repo && !lead.main_checkout;
    /* Folded, the title is all there is of the pen, so it carries what the
       tabs under it would have said: which of them needs you most. */
    const summary = folded ? foldDotsHtml(pen.tabs) : "";
    return `
      <div class="agent-row-wrap">
        <div class="agent-row-actions">
          <button class="agent-row-action rename" data-action="rename" data-workspace-id="${escapeHtml(pen.workspace_id)}">Rename</button>
          <button class="agent-row-action close" data-action="close" data-workspace-id="${escapeHtml(pen.workspace_id)}">Close</button>
          ${removable
            ? `<button class="agent-row-action remove" data-action="remove" data-workspace-id="${escapeHtml(pen.workspace_id)}">Remove</button>`
            : ""}
        </div>
        <button class="agent-row pen-head${folded ? " folded" : ""}" data-pane-id="${escapeHtml(lead.pane_id)}">
          ${foldToggleHtml("w:" + pen.workspace_id, folded, `${label} tabs`)}
          <span class="pen-head-name">${escapeHtml(label)}</span>
          ${rowToolsHtml(penTools(pen), "pen-head-tools")}
          ${summary}
          <span class="row-tabs">${tabCount(pen)} tabs</span>
        </button>
      </div>`;
  }

  /* One tab of an opened pen, which is a row like any other bar two things.
     Its sheep is hashed from its own pane rather than from the workspace -
     the one place `penSeed` is deliberately not used, since two animals side
     by side under one title must not be the same animal. And its drawer is the
     tab's own: Rename is `tab.rename`, and Close closes this tab rather than
     the branch, which is safe here because a pen is only drawn this way while
     it has a second tab for Herdr to keep the workspace alive by. */
  function penTabRowHtml(agent, queued) {
    const status = displayedStatus(agent);
    // What the strip calls this tab, including which half of a split it is.
    const chip = tabChipLabel(agent);
    const headline = agent.title || chip;
    const iconStatus = sheepStatus(agent);
    const fleece = iconStatus === "unknown"
      ? ""
      : `color:${sheepMarks(agent.pane_id).breed.fleece}`;
    const pasture = pastureOf(agent.has_agent ? agent.agent : "");
    const chew = pasture && pasture.chew ? `--chew:${pasture.chew}` : "";
    const wrapStyle = [fleece, chew].filter(Boolean).join(";");
    return `
      <div class="pen-tab">
        <div class="agent-row-wrap">
          <div class="agent-row-actions">
            <button class="agent-row-action rename" data-action="tab-rename" data-pane-id="${escapeHtml(agent.pane_id)}">Rename</button>
            <button class="agent-row-action close" data-action="tab-close" data-tab-id="${escapeHtml(agent.tab_id)}">Close</button>
          </div>
          <button class="agent-row st-${status} ${agent.pane_id === state.activePaneId ? "active" : ""}" data-pane-id="${escapeHtml(agent.pane_id)}">
            <span class="sheep-wrap ${iconStatus}"${wrapStyle ? ` style="${wrapStyle}"` : ""}>${sheepSvg(iconStatus, agent.pane_id, pasture, false)}</span>
            <span class="agent-row-text">
              <span class="agent-row-name">${escapeHtml(headline)}</span>
              <span class="agent-row-meta">
                ${agent.has_agent && agent.agent
                  ? `<span class="row-agent">${escapeHtml(agent.agent)}</span>`
                  : ""}
                ${agent.title ? `<span class="row-tab">${escapeHtml(chip)}</span>` : ""}
              </span>
            </span>
            <span class="agent-row-side">
              ${statusBadge(agent, status, queued)}
              <span class="agent-row-ago">${escapeHtml(rowAgo(agent))}</span>
            </span>
            ${rowToolsHtml(
              [
                { action: "tab-rename", key: "pane-id", value: agent.pane_id,
                  label: "Rename this tab", icon: ICON_PENCIL },
                { action: "tab-close", key: "tab-id", value: agent.tab_id,
                  label: "Close this tab", icon: ICON_TRASH, danger: true },
              ],
              "row-tools"
            )}
          </button>
        </div>
      </div>`;
  }

  /* What an opened pen's own rows are worth to the signature. Everything the
     collapsed row carried, once per tab: the pen's line above them says almost
     nothing, and all of what changes is down here. */
  function penTabsMark(pen, queued) {
    if (!penShowsTabs(pen)) return "";
    return penTabs(pen)
      .map((a) =>
        [
          a.pane_id,
          a.status,
          a.has_agent ? "a" : "",
          a.busy ? "b" : "",
          a.title || a.cwd,
          tabChipLabel(a),
          rowAgo(a),
          queuedLabel(queued.get(a.pane_id) || null),
          pastureMark(pastureOf(a.has_agent ? a.agent : "")),
          a.pane_id === state.activePaneId ? "1" : "",
        ].join("\u001c")
      )
      .join("\u001b");
  }

  // Either shape a workspace takes: one row, or a title with its tabs out.
  function penHtml(pen, groupName, counts) {
    if (!penShowsTabs(pen)) return agentRowHtml(pen, groupName, penQueue(pen, counts));
    const folded = isCollapsed("w:" + pen.workspace_id);
    if (folded) return `<div class="pen">${penHeadHtml(pen, true)}</div>`;
    return `
      <div class="pen">
        ${penHeadHtml(pen, false)}
        <div class="pen-tabs">
          ${penTabs(pen)
              .map((a) => penTabRowHtml(a, counts.get(a.pane_id) || null))
              .join("")}
        </div>
      </div>`;
  }

  /* The full-screen overview: a heading per project, with that project's own
     sheep under it. The heading names the project and nothing else: the sheep
     are right there to be counted, and the ones asking you something are
     already at the top of the list, in the pose and the colour that says so. */
  function renderAgentList() {
    renderFlockTabs();
    if (state.flockTab === "chats") return renderChatList();
    if (state.groups.length === 0 && !(state.layout || []).length) {
      state.listSignature = null;
      elAgentList.innerHTML = '<div class="history-empty">No active agents in Herdr.</div>';
      return;
    }

    // Never under the thumb: a rebuild would snap a swiped row shut, or pull
    // the floor out from under a project being carried somewhere else.
    if (state.swiping || elAgentList.querySelector(".agent-row.swiped")) return;
    const signature = agentListSignature();
    if (signature === state.listSignature) return;
    state.listSignature = signature;

    const queued = queuedByPane();
    const items = state.layout && state.layout.length
      ? state.layout
      : state.groups.map((group) => ({ kind: "project", key: group.key, group }));
    elAgentList.innerHTML = items
      .map((item) =>
        item.kind === "folder" ? folderHtml(item, queued) : projectHtml(item.group, queued)
      )
      .join("");
  }

  /* The switch at the top of the flock. Whichever half is off screen still
     says when something in it is waiting on you: a question in the other tab
     must not be one nobody sees. */
  function renderFlockTabs() {
    const blocked = {
      projects: state.agents.some((a) => knownStatus(a.status) === "blocked"),
      chats: (state.chatPens || []).some((pen) => pen.lead.status === "blocked"),
    };
    for (const btn of elFlockTabs.querySelectorAll("[data-flock-tab]")) {
      const tab = btn.dataset.flockTab;
      btn.setAttribute("aria-pressed", String(tab === state.flockTab));
      btn.classList.toggle("wants", tab !== state.flockTab && blocked[tab]);
    }
  }

  function renderChatList() {
    const pens = state.chatPens || [];
    if (!pens.length) {
      state.listSignature = null;
      elAgentList.innerHTML = '<div class="history-empty">No chats yet. Start one with + New.</div>';
      return;
    }
    if (state.swiping || elAgentList.querySelector(".agent-row.swiped")) return;
    const signature = agentListSignature();
    if (signature === state.listSignature) return;
    state.listSignature = signature;
    // Not an .agent-group: there is no project here to lift and carry.
    elAgentList.innerHTML = `<div class="chat-list">${pens.map(chatRowHtml).join("")}</div>`;
  }

  function setFlockTab(tab) {
    if (tab !== "chats") tab = "projects";
    if (tab === state.flockTab) return;
    state.flockTab = tab;
    savePref("sheepit.flocktab", tab);
    state.listSignature = null;
    resetSwipe();
    renderAgentList();
  }

  function projectHtml(group, queued) {
    const owed = group.agents.reduce(
      (sum, a) => sum + ((queued.get(a.pane_id) || {}).waiting || 0), 0
    );
    /* The one number left in a heading: prompts this project has not been
       given yet. It stays because nothing else on the screen says so - a
       sheep with a prompt still queued behind it looks idle. */
    const owedChip = owed
      ? `<span class="agent-group-queued">${owed} queued</span>`
      : "";
    /* Another one of these, please: a worktree cut off this project or a
       tab beside what is already open - the sheet asks which. It lives in
       the heading because the project is what both of them need to be
       told, and the heading is the only thing on this screen that names
       one. A project with nothing open has neither to offer. */
    const add = group.from || group.rows.some((pen) => pen.workspace_id)
      ? `<button class="agent-group-add" type="button"
                 data-action="worktree" data-project="${escapeHtml(group.key)}"
                 aria-label="New in ${escapeHtml(group.name)}">+</button>`
      : "";
    /* Folded, the heading is the whole project, so it says what the sheep
       under it would have: one dot each, in the colour of what it is doing -
       a question folded away still pulses red. */
    const folded = isCollapsed("p:" + group.key);
    const summary = folded ? foldDotsHtml(group.agents) : "";
    return `
      <section class="agent-group${folded ? " folded" : ""}" data-project="${escapeHtml(group.key)}">
        <h2 class="agent-group-head">
          ${foldToggleHtml("p:" + group.key, folded, group.name)}
          <span class="agent-group-name" data-action="fold" data-fold="${escapeHtml("p:" + group.key)}">${escapeHtml(group.name)}</span>
          ${summary}
          ${owedChip}
          ${add}
        </h2>
        ${folded ? "" : group.rows.map((pen) => penHtml(pen, group.name, queued)).join("")}
      </section>`;
  }

  /* A folder: its name on a row of its own, which is what a thumb holds to
     carry it and swipes to rename or delete it, and the projects filed in it
     underneath. Tapping the name folds it. */
  function folderHtml(item, queued) {
    const { folder, groups } = item;
    const folded = isCollapsed("f:" + folder.id);
    const count = groups.length === 1 ? "1 project" : `${groups.length} projects`;
    const everyone = groups.flatMap((g) => g.agents);
    const tools = [
      { action: "folder-rename", key: "folder-id", value: folder.id,
        label: "Rename this folder", icon: ICON_PENCIL },
      { action: "folder-delete", key: "folder-id", value: folder.id,
        label: "Remove this folder (its projects stay)", icon: ICON_TRASH, danger: true },
    ];
    const inside = groups.length
      ? groups.map((group) => projectHtml(group, queued)).join("")
      : '<div class="folder-empty">Drag a project here</div>';
    return `
      <section class="folder${folded ? " folded" : ""}" data-folder="${escapeHtml(folder.id)}">
        <div class="agent-row-wrap folder-head-wrap">
          <div class="agent-row-actions">
            <button class="agent-row-action rename" data-action="folder-rename" data-folder-id="${escapeHtml(folder.id)}">Rename</button>
            <button class="agent-row-action close" data-action="folder-delete" data-folder-id="${escapeHtml(folder.id)}">Ungroup</button>
          </div>
          <button class="agent-row folder-head" data-folder-id="${escapeHtml(folder.id)}"
                  aria-expanded="${folded ? "false" : "true"}">
            <span class="fold-chevron" aria-hidden="true">${ICON_CHEVRON}</span>
            <span class="folder-icon" aria-hidden="true">${ICON_FOLDER}</span>
            <span class="folder-name">${escapeHtml(folder.name || "Folder")}</span>
            ${rowToolsHtml(tools, "pen-head-tools")}
            ${folded ? foldDotsHtml(everyone) : ""}
            <span class="row-tabs">${count}</span>
          </button>
        </div>
        ${folded ? "" : `<div class="folder-body">${inside}</div>`}
      </section>`;
  }

  const ICON_CHEVRON =
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <polyline points="6 9 12 15 18 9"></polyline>
     </svg>`;

  const ICON_FOLDER =
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <path d="M3 19V6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
     </svg>`;

  /* The chevron that folds a project or a pen. A span rather than a button,
     since it sits inside the pen's title, which is a button already - the
     click handler reads `data-action` before it reads the row. */
  function foldToggleHtml(key, folded, name) {
    return `<span class="fold-toggle" role="button" data-action="fold"
                  data-fold="${escapeHtml(key)}" aria-expanded="${folded ? "false" : "true"}"
                  aria-label="${folded ? "Show" : "Hide"} ${escapeHtml(name)}">${ICON_CHEVRON}</span>`;
  }

  /* What a folded thing still owes you: a dot per agent, loudest first, in
     the colours the dots have everywhere else. Shells are left out - a dot
     that is always grey says nothing - and a long flock is cut short with a
     count, since the point is the red one, not the census. */
  const FOLD_DOTS = 8;

  function foldDotsHtml(rows) {
    const agents = rows
      .filter((a) => a.has_agent)
      .map((a) => knownStatus(displayedStatus(a)))
      .sort((a, b) => (URGENCY[a] ?? 4) - (URGENCY[b] ?? 4));
    if (!agents.length) return "";
    const dots = agents
      .slice(0, FOLD_DOTS)
      .map((st) => `<span class="agent-dot ${st}"></span>`)
      .join("");
    const more = agents.length > FOLD_DOTS
      ? `<span class="fold-more">+${agents.length - FOLD_DOTS}</span>`
      : "";
    return `<span class="fold-dots" title="${escapeHtml(agents.join(", "))}">${dots}${more}</span>`;
  }

  /* Renaming happens on the laptop as well. These are Herdr's own labels - the
     ones the desktop draws in its workspace strip and its tab bar - so a
     project named here is named there a moment later, and the phone is not
     keeping a private nickname the machine under the desk knows nothing of.

     A row is a worktree, so Rename is workspace.rename - the label in the
     desktop's workspace strip. A single tab inside it is renamed from the
     strip above the transcript, which is the only place the tabs are far
     enough apart to tell which one you meant. */
  async function renameRow(workspaceId) {
    const row = state.agents.find((a) => a.workspace_id === workspaceId);
    if (row) await renameWorkspace(row);
  }

  async function renameWorkspace(row) {
    const current = row.workspace_label || "";
    const label = prompt("Rename project", current);
    resetSwipe();
    if (label === null) return;
    const trimmed = label.trim();
    if (!trimmed || trimmed === current) return;
    triggerHaptic();
    try {
      await sendRename(
        `/api/workspaces/${encodeURIComponent(row.workspace_id)}/rename`,
        trimmed
      );
      // Show it now rather than at the next poll.
      for (const r of state.agents) {
        if (r.workspace_id !== row.workspace_id) continue;
        r.workspace_label = trimmed;
        r.name = trimmed;
      }
      redrawNames();
    } catch (err) {
      alert("Could not rename project: " + err.message);
    }
  }

  async function renameTab(row) {
    /* Offer the name somebody gave this tab, not the one it is displaying: a
       tab called "2" shows its pane's title, and prefilling the box with that
       would turn the agent's own headline into the tab's name on the first
       tap of OK. */
    const current = tabName(row);
    const label = prompt("Rename tab", current);
    resetSwipe();
    if (label === null) return;
    const trimmed = label.trim();
    if (!trimmed || trimmed === current) return;
    triggerHaptic();
    try {
      await sendRename(`/api/tabs/${encodeURIComponent(row.tab_id)}/rename`, trimmed);
      for (const r of state.agents) {
        if (r.tab_id === row.tab_id) r.tab_label = trimmed;
      }
      redrawNames();
    } catch (err) {
      alert("Could not rename tab: " + err.message);
    }
  }

  function redrawNames() {
    state.listSignature = null;
    renderAgentBar();
    renderAgentList();
  }

  async function sendRename(url, label) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const error = data.error;
      throw new Error((error && error.message) || error || "refused");
    }
    return data;
  }

  /* A new Herdr workspace - a whole console of its own, not a tab in one
     that is already open. Opened in the project's directory when it is asked
     for from a project, so it lands under that heading. */
  async function createWorkspace(cwd) {
    triggerHaptic();
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cwd ? { cwd } : {}),
      });
      if (!res.ok) throw new Error("create failed");
      const data = await res.json();
      if (!data.pane_id) throw new Error("No pane returned for the new terminal");
      let created;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        await fetchAgents();
        created = state.agents.find((a) => a.pane_id === data.pane_id);
      }
      // Open the pane Herdr created. A poll can bring in another workspace at
      // the same time, so a difference between two lists is not its identity.
      if (created) {
        selectAgent(created.pane_id);
        if (!wide.matches) openConsole();
      } else throw new Error("The new terminal did not appear");
    } catch (err) {
      alert("Could not create workspace: " + err.message);
    }
  }

  /* --------------------------------------------------------- What "+" asks
   *
   * There were four plusses, and between them they did four unrelated things
   * nobody could name from the icon: a bare workspace, a worktree, a tab, and
   * - on a page of its own that nothing pointed at - a chat. Two of those are
   * the same question with a different answer ("another agent on this project,
   * in its own checkout or not") and the other two are the other same question
   * ("something new, with a terminal in front of it or a model").
   *
   * So there are two plusses now, and both of them ask. The sheet is one
   * element: a title, a body drawn from whichever question is being asked, and
   * a cancel. `newSheet` is what it is asking about - `where` is which plus was
   * tapped, `step` is how far through the answer we are.
   * ------------------------------------------------------------------------ */

  let newSheet = null;
  // The permission modes a chat may be started with, and the directory it
  // starts in. Asked for whenever a chat is, since the settings can move it.
  let chatOptions = null;

  function openNewSheet(where, extra) {
    newSheet = { where, step: "choose", ...extra };
    triggerHaptic();
    resetSwipe();
    elNewSheet.classList.remove("hidden");
    elSheetBackdrop.classList.remove("hidden");
    renderNewSheet();
  }

  function closeNewSheet() {
    newSheet = null;
    elNewSheet.classList.add("hidden");
    elSheetBackdrop.classList.add("hidden");
  }

  /* The plus at the top of the flock: nothing exists yet, so nothing is known.
     This is where a new project starts - a console in the home directory, to
     cd and clone from - and where a folder is made. */
  function openNewAnything() {
    openNewSheet("flock");
    // In the chats tab there is only one thing `+ New` could mean.
    if (state.flockTab === "chats") chooseChat();
  }

  /* The plus on a project heading. It knows the project, and which of its
     workspaces a worktree would be cut from - the project's own checkout,
     picked in groupByProject - but not which workspace a tab should join, so
     it aims a tab at that same checkout. */
  function openNewInProject(key) {
    const group = state.groups.find((g) => g.key === key) || (() => {
      const fallback = groupByProject(state.agents).find((g) => g.key === key);
      return fallback ? { ...fallback, rows: byWorkspace(fallback.agents) } : null;
    })();
    if (!group) return;
    /* No tab from here: a tab belongs to one worktree, and a heading does not
       know which one you meant. That is the plus on the worktree's own row. */
    const lead = group.rows.find((pen) => pen.workspace_id);
    openNewSheet("project", {
      project: group.key,
      name: group.name,
      from: group.from,
      cwd: projectDir(group.key, lead && lead.lead),
    });
  }

  /* Where a new console for a project opens: the project's own directory,
     which is the repository root for a repository - so the workspace groups
     under the same heading - and whatever a pane stands in otherwise. */
  function projectDir(key, row) {
    if (key && key.startsWith("/")) return key;
    return (row && row.cwd) || "";
  }

  /* The plus in the tab strip. Same sheet, but here the worktree you are
     looking at is the one a tab joins, which is the whole reason the strip
     has its own plus rather than sending you back to the heading. */
  function openNewInWorkspace(workspaceId) {
    const row = state.agents.find((a) => a.workspace_id === workspaceId);
    if (!row) return;
    const group = state.groups.find((g) => g.key === projectKey(row));
    openNewSheet("project", {
      project: group ? group.key : projectKey(row),
      name: (group && group.name) || row.project_name || row.name,
      from: group ? group.from : "",
      workspaceId,
      workspaceName: row.workspace_label || row.name,
      cwd: projectDir(group ? group.key : projectKey(row), row),
    });
  }

  const ICON = {
    chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    console: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2"/><polyline points="6.5 9 9.5 12 6.5 15"/><line x1="12" y1="15.5" x2="17" y2="15.5"/></svg>',
    worktree: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9M6 12h5a4 4 0 0 0 4-1.2"/></svg>',
    folder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19V6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
    tab: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19V7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  };

  function choiceHtml(key, name, hint) {
    return `
      <button type="button" class="new-choice" data-choose="${key}">
        <span class="new-choice-icon">${ICON[key]}</span>
        <span class="new-choice-text">
          <span class="new-choice-name">${escapeHtml(name)}</span>
          <span class="new-choice-hint">${escapeHtml(hint)}</span>
        </span>
      </button>`;
  }

  function renderNewSheet() {
    if (!newSheet) return;
    const { where, step } = newSheet;
    if (where === "flock" && step === "choose") {
      elNewSheetTitle.textContent = "New";
      elNewSheetBody.innerHTML =
        choiceHtml("chat", "Chat", "a Claude Code you talk to, with no terminal behind it") +
        choiceHtml("console", "Console", "an empty Herdr workspace to start a new project in") +
        choiceHtml("folder", "Folder", "somewhere to drag projects you are not touching this week");
      return;
    }
    if (where === "project" && step === "choose") {
      elNewSheetTitle.textContent = `New in ${newSheet.name}`;
      // No checkout of the project is open, so there is no repository to cut a
      // branch from - Herdr resolves a worktree through a workspace, not a path.
      const worktree = newSheet.from
        ? choiceHtml("worktree", "Worktree", "its own branch and its own copy of the tree")
        : "";
      const here = newSheet.workspaceName
        ? `another agent beside the one in ${newSheet.workspaceName}`
        : "another agent on the branch that is already checked out";
      const tab = newSheet.workspaceId ? choiceHtml("tab", "Tab", here) : "";
      // A workspace of its own, in the project's directory: nothing is shared
      // with what is open already, and it needs no repository to be made.
      const own = newSheet.cwd
        ? choiceHtml("console", "Console", "a new Herdr workspace of its own in this project")
        : "";
      elNewSheetBody.innerHTML = (tab + own + worktree) ||
        '<p class="new-choice-hint">Nothing of this project is open to add to.</p>';
      return;
    }
    if (step === "chat") {
      elNewSheetTitle.textContent = "New chat";
      elNewSheetBody.innerHTML = chatFormHtml();
      restoreChatPrefs();
      return;
    }
    if (step === "home") {
      elNewSheetTitle.textContent = where === "settings" ? "Chats live in" : "Where should chats live?";
      elNewSheetBody.innerHTML = dirPickerHtml();
      return;
    }
    if (where === "project" && step === "worktree") {
      elNewSheetTitle.textContent = `New worktree in ${newSheet.name}`;
      elNewSheetBody.innerHTML = `
        <label class="new-field">Branch
          <input id="new-branch" type="text" autocapitalize="off" autocorrect="off"
                 spellcheck="false" placeholder="leave empty and Herdr names it">
        </label>
        <button type="button" class="new-go" data-go="worktree">Cut worktree</button>`;
      const input = document.getElementById("new-branch");
      if (input) input.focus();
    }
  }

  /* The settings a chat is started with, which are the only ones it ever gets:
     what it may do without asking, and which model. Remembered between chats,
     because the answer is nearly always the last answer. Where it runs is not
     asked: every chat from here starts in the one directory the settings name. */
  function chatFormHtml() {
    if (!chatOptions) return '<p class="new-choice-hint">Reading…</p>';
    const modes = chatOptions.modes
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("");
    return `
      <p class="new-chat-home">in <span>${escapeHtml(chatOptions.home)}</span>
        <button type="button" class="new-link" data-choose="home">change</button></p>
      <div class="new-row">
        <label class="new-field">Permissions
          <select id="new-chat-mode">${modes}</select>
        </label>
        <label class="new-field">Model
          <select id="new-chat-model">
            <option value="">default</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
        </label>
      </div>
      <button type="button" class="new-go" data-go="chat">Start chat</button>`;
  }

  function restoreChatPrefs() {
    const mode = document.getElementById("new-chat-mode");
    const model = document.getElementById("new-chat-model");
    if (mode) mode.value = readPref("chat.mode") || "auto";
    if (model) model.value = readPref("chat.model") || "";
  }

  async function loadChatOptions() {
    try {
      const res = await fetch("/api/chat");
      const data = await res.json();
      chatOptions = { home: data.home || "", modes: data.modes || ["auto"] };
    } catch (err) {
      chatOptions = null;
      throw err;
    }
    return chatOptions;
  }

  /* Chat first asks where chats live, once: a phone has no folder dialog for
     the machine the agents are on, so the gateway walks it one level at a time. */
  async function chooseChat() {
    newSheet.step = "chat";
    chatOptions = null;
    renderNewSheet();
    try {
      await loadChatOptions();
    } catch (err) {
      closeNewSheet();
      alert("Could not reach the gateway: " + err.message);
      return;
    }
    if (!newSheet) return;
    if (!chatOptions.home) {
      newSheet.step = "home";
      newSheet.then = "chat";
      return browseDir("");
    }
    renderNewSheet();
  }

  async function startChat() {
    const mode = document.getElementById("new-chat-mode");
    const model = document.getElementById("new-chat-model");
    const body = {
      mode: (mode && mode.value) || "auto",
      model: (model && model.value) || "",
    };
    savePref("sheepit.chat.mode", body.mode);
    savePref("sheepit.chat.model", body.model);
    triggerHaptic();
    try {
      const res = await fetch("/api/chat/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "refused");
      closeNewSheet();
      // The creation response has the chat already; show it without waiting
      // for the project list to refresh.
      state.chats = [...state.chats.filter((c) => c.id !== data.chat.id), data.chat];
      setFlockTab("chats");
      openChat(data.chat.id);
      await fetchAgents();
    } catch (err) {
      alert("Could not start a chat: " + err.message);
    }
  }

  /* The folder picker, for the chat home. `newSheet.dir` is the directory on
     screen - its path, its parent and its children, as the gateway read them. */
  async function browseDir(path) {
    if (!newSheet) return;
    newSheet.dir = { ...(newSheet.dir || {}), loading: true, error: "" };
    renderNewSheet();
    try {
      const target = path || (chatOptions && chatOptions.home) || "";
      const res = await fetch("/api/chat/dirs?path=" + encodeURIComponent(target));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "refused");
      if (!newSheet) return;
      newSheet.dir = { path: data.path, parent: data.parent, dirs: data.dirs, home: data.home };
    } catch (err) {
      if (!newSheet) return;
      newSheet.dir = { ...newSheet.dir, loading: false, error: err.message };
    }
    renderNewSheet();
  }

  function dirPickerHtml() {
    const dir = newSheet.dir || {};
    if (!dir.path) {
      return `<p class="new-choice-hint">${dir.error ? escapeHtml("Could not read it: " + dir.error) : "Reading…"}</p>`;
    }
    const up = dir.parent
      ? `<button type="button" class="dir-item dir-up" data-dir="${escapeHtml(dir.parent)}">..</button>`
      : "";
    const items = dir.dirs
      .map((name) => {
        const full = (dir.path === "/" ? "" : dir.path) + "/" + name;
        return `<button type="button" class="dir-item" data-dir="${escapeHtml(full)}">${escapeHtml(name)}</button>`;
      })
      .join("");
    const first = newSheet.then === "chat"
      ? '<p class="new-choice-hint dir-why">Every chat started from here runs in this folder. You can change it later in the settings.</p>'
      : "";
    return `${first}
      <div class="dir-path">${escapeHtml(dir.path)}</div>
      <div class="dir-list">${up}${items || (up ? "" : '<p class="new-choice-hint">No folders in here.</p>')}</div>
      ${dir.error ? `<p class="new-choice-hint">${escapeHtml(dir.error)}</p>` : ""}
      <div class="new-row dir-make">
        <input id="new-dir-name" type="text" autocapitalize="off" autocorrect="off"
               spellcheck="false" placeholder="new folder in here">
        <button type="button" class="sheet-btn-small" data-go="mkdir">Make</button>
      </div>
      <button type="button" class="new-go" data-go="home"${dir.loading ? " disabled" : ""}>Use this folder</button>`;
  }

  async function makeDir() {
    const input = document.getElementById("new-dir-name");
    const name = input ? input.value.trim() : "";
    if (!name || !newSheet || !newSheet.dir) return;
    try {
      const res = await fetch("/api/chat/dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newSheet.dir.path, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "refused");
      browseDir(data.path);
    } catch (err) {
      alert("Could not make that folder: " + err.message);
    }
  }

  async function saveChatHome() {
    if (!newSheet || !newSheet.dir || !newSheet.dir.path) return;
    triggerHaptic();
    try {
      const res = await fetch("/api/chat/home", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newSheet.dir.path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "refused");
      chatOptions = { ...(chatOptions || { modes: ["auto"] }), home: data.home };
      renderChatHomeSetting(data.home);
    } catch (err) {
      alert("Could not keep that folder: " + err.message);
      return;
    }
    if (newSheet.then === "chat") {
      newSheet.step = "chat";
      renderNewSheet();
    } else {
      closeNewSheet();
    }
  }

  elNewSheet.addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]");
    if (dir) {
      browseDir(dir.dataset.dir);
      return;
    }
    const choice = e.target.closest("[data-choose]");
    if (choice) {
      const pick = choice.dataset.choose;
      triggerHaptic();
      // The two that need nothing more said happen now; the two that do get
      // the second step of the same sheet rather than a dialog over it.
      if (pick === "console") {
        const cwd = newSheet.cwd;
        closeNewSheet();
        createWorkspace(cwd);
      } else if (pick === "folder") {
        closeNewSheet();
        newFolder();
      } else if (pick === "tab") {
        const workspaceId = newSheet.workspaceId;
        closeNewSheet();
        createTab(workspaceId);
      } else if (pick === "chat") {
        chooseChat();
      } else if (pick === "home") {
        // From the chat form: pick again, then come back to it.
        newSheet.step = "home";
        newSheet.then = "chat";
        browseDir("");
      } else if (pick === "worktree") {
        newSheet.step = "worktree";
        renderNewSheet();
      }
      return;
    }
    const go = e.target.closest("[data-go]");
    if (!go) return;
    if (go.dataset.go === "worktree") cutWorktreeFromSheet();
    else if (go.dataset.go === "chat") startChat();
    else if (go.dataset.go === "home") saveChatHome();
    else if (go.dataset.go === "mkdir") makeDir();
  });

  /* Return in the branch field is the same as the button: a name and a return
     key is the whole gesture when you already know what the branch is called. */
  elNewSheet.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "new-branch") {
      e.preventDefault();
      cutWorktreeFromSheet();
    } else if (e.key === "Enter" && e.target.id === "new-dir-name") {
      e.preventDefault();
      makeDir();
    }
  });

  // Both read the sheet before closing it, since closing forgets the question.
  function cutWorktreeFromSheet() {
    if (!newSheet) return;
    const input = document.getElementById("new-branch");
    const project = newSheet.project;
    const branch = input ? input.value.trim() : "";
    closeNewSheet();
    createWorktree(project, branch);
  }

  /* Cut a worktree off a project and open it. Herdr does both halves in the
     one call, so all this has to decide is what the branch is called - and a
     blank answer is a real answer, meaning "you name it", which is how this
     stays one tap and a return key when you have not thought that far. */
  async function createWorktree(key, branch) {
    const group = state.groups.find((g) => g.key === key);
    if (!group || !group.from) return;
    triggerHaptic();
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: group.from, branch: (branch || "").trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const error = data.error;
        throw new Error((error && error.message) || error || "refused");
      }
      await fetchAgents();
      const created = state.agents.find((a) => a.workspace_id === data.workspace_id);
      if (created) selectAgent(created.pane_id);
      else renderAgentList();
    } catch (err) {
      alert("Could not create worktree: " + err.message);
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

  /* Removing a worktree takes the checkout with it, so the branch and the
     directory both go. Asked for once here; asked for a second time only if
     Herdr refuses, which it does when there is work in the checkout that is
     not committed anywhere - that refusal is the whole safety net, so it is
     repeated verbatim rather than swallowed and retried. */
  async function removeWorktree(workspaceId) {
    /* Loud rather than silent. A button that does nothing at all is the one
       failure nobody can report usefully - and this one returned quietly on a
       row whose workspace the poll had not caught up with yet. */
    if (!workspaceId) {
      alert("That row has no workspace to remove - pull to refresh and try again.");
      return;
    }
    const target = state.agents.find((a) => a.workspace_id === workspaceId);
    const name = target ? target.name : "this worktree";
    if (!confirm(`Remove ${name}? The checkout is deleted and any agents in it stopped.`)) {
      resetSwipe();
      return;
    }
    triggerHaptic("warning");
    try {
      let done = await sendRemove(workspaceId, false);
      if (done.refusal) {
        if (!confirm(`Herdr refused: ${done.refusal}\n\nRemove ${name} anyway?`)) {
          resetSwipe();
          return;
        }
        done = await sendRemove(workspaceId, true);
        if (done.refusal) throw new Error(done.refusal);
      }
      if (state.agents.find((a) => a.pane_id === state.activePaneId)?.workspace_id === workspaceId) {
        state.activePaneId = null;
      }
      resetSwipe();
      await fetchAgents();
      renderAgentList();
      // The checkout is gone; the branch it was on is not. Offered separately
      // because it is the half that can still hold work.
      await offerBranch(done.branch, done.repo_root);
    } catch (err) {
      alert("Could not remove worktree: " + err.message);
    }
  }

  /* Herdr removes a checkout and leaves the ref, so a week of worktrees leaves
     a week of branches. Asked rather than done: `git branch -d` refuses one
     whose commits are merged nowhere else, and that refusal is worth reading
     before it is overridden - it is the only thing that still knows the work
     happened. */
  async function offerBranch(branch, repoRoot) {
    if (!branch || !repoRoot) return;
    if (!confirm(`Checkout removed.\n\nAlso delete the branch ${branch}?`)) return;
    let refusal = await sendBranchDelete(repoRoot, branch, false);
    if (refusal) {
      if (!confirm(`Git refused: ${refusal}\n\nDelete ${branch} anyway?`)) return;
      refusal = await sendBranchDelete(repoRoot, branch, true);
    }
    if (refusal) alert(`Branch ${branch} was left behind: ${refusal}`);
  }

  // The message it refused with, or "" when it did the thing.
  async function sendRemove(workspaceId, force) {
    const data = await postAction(
      `/api/worktrees/${encodeURIComponent(workspaceId)}/remove`,
      { force }
    );
    return {
      refusal: data.refusal,
      branch: data.branch || "",
      repo_root: data.repo_root || "",
    };
  }

  async function sendBranchDelete(repoRoot, branch, force) {
    const data = await postAction("/api/branches/delete", {
      repo_root: repoRoot,
      branch,
      force,
    });
    return data.refusal;
  }

  /* One POST, and the refusal as a string rather than a throw: every one of
     these has a "no" that is worth showing the person who asked, and none of
     them is an error in the sense of something having gone wrong. */
  async function postAction(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) return { ...data, refusal: "" };
    const error = data.error;
    return { ...data, refusal: (error && error.message) || error || "refused" };
  }

  /* Safari paints its status strip and its bottom URL bar in theme-color, and
     anything but the colour actually under them reads as a shade laid over the
     page - which is what put a band across the Projects header. The flock's
     edges are the base colour; a chat's are its header and its input dock,
     both the surface colour. So the meta follows whichever is on screen rather
     than naming one of the two and being wrong about the other. Past 900px
     both are up at once and the flock owns the left edge, so it wins. */
  const elThemeColor = document.querySelector('meta[name="theme-color"]');

  function syncThemeColor() {
    if (!elThemeColor) return;
    const onFlock = state.pickerOpen || wide.matches;
    elThemeColor.setAttribute("content", onFlock ? "#090a0f" : "#12151d");
  }

  /* The flock is the document, which is what lets Safari fold its URL bar
     away - and the price of that is that closing the flock takes the only
     thing in the flow out of it, so the page has nowhere left to be scrolled
     to and the browser puts it back at zero. Remember where the list was and
     hand it back, or every chat you come out of drops you at the top of it.
     Past 900px the flock is a column with its own scrollTop and none of this
     applies. */
  let flockScroll = 0;

  function keepFlockScroll() {
    if (wide.matches) return;
    flockScroll = window.scrollY;
  }

  function restoreFlockScroll() {
    if (wide.matches || !flockScroll) return;
    // After the layout: the picker is only just back in the flow, so until it
    // has been laid out the document is still one screen tall and a scroll
    // would clamp to nothing.
    requestAnimationFrame(() => window.scrollTo(0, flockScroll));
  }

  /* A project heading sticks below the picker head, and the head's height is
     the status bar inset plus whatever the title and the button come to - a
     number only the browser knows, and one that changes with the notch and
     with rotation. Measure it into the variable the CSS reads. */
  function measurePickerHead() {
    const h = elPickerHead ? elPickerHead.getBoundingClientRect().height : 0;
    if (h) document.documentElement.style.setProperty("--picker-head-h", `${h}px`);
  }

  /* Home. Not a sheet over a chat any more: this is the screen the app starts
     on and the one a chat is backed out of. */
  function showFlock() {
    state.pickerOpen = true;
    elAgentPicker.classList.remove("hidden");
    renderAgentList();
    renderQuota();
    fetchQuota();
    syncPickerChrome();
    syncThemeColor();
    restoreFlockScroll();
  }

  function openPicker() {
    triggerHaptic();
    showFlock();
  }

  function closePicker() {
    // On a Mac the flock is the left column: there is nothing to close, and
    // hiding it would leave the chat alone on a very wide screen.
    if (wide.matches) return;
    keepFlockScroll();
    state.pickerOpen = false;
    elAgentPicker.classList.add("hidden");
    syncThemeColor();
  }

  /* The X returns from the flock to the pane once one has been opened. */
  function canLeaveFlock() {
    return Boolean(state.chatVisited && state.activePaneId) && !wide.matches;
  }

  function syncPickerChrome() {
    elBtnClosePicker.classList.toggle("hidden", !canLeaveFlock());
  }

  /* Console and changed files belong to the pane that opened them. Switching
     tabs closes those views so the new pane can show its default surface. */

  function closePaneViews() {
    if (!elConsoleView.classList.contains("hidden")) closeConsole();
    if (!elChangesView.classList.contains("hidden")) closeChanges();
  }

  /* Select a pane and start at its first available view. */
  function selectAgent(paneId, open = true) {
    if (open) state.chatVisited = true; // there is now a chat to go back to
    const draftBefore = draftKey();
    rememberDraft(draftBefore);
    // A pane takes the column back off whatever headless chat had it.
    state.activeChatId = null;
    const pane = state.agents.find((agent) => agent.pane_id === paneId);
    const hasChat = paneHasChat(pane);
    const changed = state.activePaneId !== paneId;
    if (open) closePicker();
    if (changed) {
      setCtrlCArmed(false);
      touchAgent(paneId);
      state.activePaneId = paneId;
      attachStrip.clear();
      state.historyText = "";
      state.heldHistory = null;
      elHistoryContent.innerHTML = '<div class="history-empty">Loading…</div>';
    }
    if (draftKey() !== draftBefore) {
      resetRecall();
      restoreDraft(draftKey());
    }
    state.paneView = hasChat ? "chat" : "transcript";
    state.chatVisible = hasChat;
    savePref("sheepit.view", state.paneView);
    if (open) triggerHaptic();

    closePaneViews();
    renderAgentBar();
    syncPickerChrome();
    if (changed) {
      renderChatQueue();
      fetchHistory(true);
    }
    if (open) {
      if (!wide.matches) stopPolling();
      if (wide.matches && !hasChat) openConsole();
    }
  }

  /* ------------------------------------------------------------ The tabs ---
   *
   * A worktree with a second tab in it hangs both of them out in the overview,
   * so this is not the only place a tab is reachable any more - but it is the
   * only place one is *switched to* without leaving the chat you are in, and
   * the only place another is opened. The two agree deliberately: a tab is
   * called the same thing in both, and Close means this tab in both, which is
   * the confusion this whole arrangement exists to end - every action the
   * overview used to offer acted on the workspace, so closing what looked like
   * a tab took the branch and its neighbours with it.
   *
   * Tap a chip to switch, hold one to rename it, + for another tab in the same
   * checkout, and the x on the one you are in to close it. The x is absent on
   * the last tab, because Herdr takes the workspace with it - closing the
   * worktree is the row's own Close, where it says what it does.
   * ------------------------------------------------------------------------ */

  // In the order the laptop's tab bar has them, so the phone agrees with it.
  function tabsOfActive() {
    const active = state.agents.find((a) => a.pane_id === state.activePaneId);
    if (!active) return [];
    return state.agents
      .filter((a) => a.workspace_id === active.workspace_id)
      .sort(
        (a, b) =>
          (Number(tabNumber(a)) || 0) - (Number(tabNumber(b)) || 0) ||
          bornAt(a) - bornAt(b)
      );
  }

  /* What a chip is called: the tab's name if it has one, its number if not.
     A split tab is two panes under one number, so the pane is named too -
     otherwise both halves of it are called "tab 2". */
  function tabChipLabel(row) {
    const base = tabName(row) || `tab ${tabNumber(row) || "?"}`;
    if (!row.split) return base;
    return `${base} · p${(row.pane_id || "").split(":p")[1] || "?"}`;
  }

  function tabStripHtml() {
    const tabs = tabsOfActive();
    if (!tabs.length) return "";
    const workspaceId = tabs[0].workspace_id || "";
    const closable = new Set(tabs.map((a) => a.tab_id)).size > 1;
    const chips = tabs.map((row) => {
      const on = row.pane_id === state.activePaneId;
      const status = displayedStatus(row);
      return `
        <button type="button" class="tab-chip ${on ? "on" : ""}" data-pane-id="${escapeHtml(row.pane_id)}">
          <span class="agent-dot ${status}"></span>
          <span class="tab-chip-name">${escapeHtml(tabChipLabel(row))}</span>
          ${on && closable
            ? `<span class="tab-chip-x" data-tab-close="${escapeHtml(row.tab_id)}" role="button" aria-label="Close this tab">×</span>`
            : ""}
        </button>`;
    });
    /* The chips scroll and the plus does not: Herdr's own tab labels are whole
       sentences, and two of them are wider than a phone - a plus that scrolls
       away with them is a plus nobody knows is there. */
    return `
      <div class="tab-chips">${chips.join("")}</div>
      <button type="button" class="tab-chip-new" data-tab-new="${escapeHtml(workspaceId)}"
              aria-label="New tab or worktree">+</button>`;
  }

  // Redrawn from the poll, so it is compared before it is replaced: a strip
  // rebuilt under the thumb loses the tap that was landing on it.
  let tabStripDrawn = null;

  function renderTabStrip() {
    const html = tabStripHtml();
    if (html === tabStripDrawn) return;
    tabStripDrawn = html;
    elTabStrip.innerHTML = html;
    elTabStrip.classList.toggle("hidden", !html);
    /* Herdr's tab labels are whole sentences, so the chip you are on is often
       off the end of the strip - along with the x that closes it. `nearest`
       everywhere, or this scrolls the transcript as well. */
    const on = elTabStrip.querySelector(".tab-chip.on");
    if (on && on.scrollIntoView) {
      on.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  async function renameTabByPane(paneId) {
    const row = state.agents.find((a) => a.pane_id === paneId);
    if (row) await renameTab(row);
  }

  async function closeTab(tabId) {
    const panes = state.agents.filter((a) => a.tab_id === tabId);
    const row = panes[0];
    if (!row) return;
    const name = tabName(row) || `tab ${tabNumber(row)}`;
    // A stray tap is cheap to make and expensive to undo, the same as Close on
    // a row - and this one stops an agent mid-turn.
    if (!confirm(`Close ${name}? Anything running in it will be stopped.`)) return;
    triggerHaptic("warning");
    // Where to land afterwards, decided while the tabs are all still here.
    const left = tabsOfActive().find((a) => a.tab_id !== tabId);
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/close`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("close failed");
      if (left && panes.some((a) => a.pane_id === state.activePaneId)) {
        selectAgent(left.pane_id);
      }
      await fetchAgents();
    } catch (err) {
      alert("Could not close tab: " + err.message);
    }
  }

  /* Another tab beside this one: a second agent on the same branch, in the
     same checkout, rather than a worktree of its own. It opens where the tab
     it was asked from is sitting. */
  async function createTab(workspaceId) {
    /* Where the new tab opens: the directory the pane you asked from is
       sitting in, or - asked from the project heading, where no pane is
       necessarily open - whatever that workspace's first pane is using. */
    const here = state.agents.find((a) => a.pane_id === state.activePaneId);
    const row = here && here.workspace_id === workspaceId
      ? here
      : state.agents.find((a) => a.workspace_id === workspaceId);
    if (!workspaceId || !row) return;
    triggerHaptic();
    try {
      const data = await postAction("/api/tabs", {
        workspace_id: workspaceId,
        cwd: row.cwd || "",
      });
      if (data.refusal) throw new Error(data.refusal);
      await fetchAgents();
      if (data.pane_id) selectAgent(data.pane_id);
      else renderTabStrip();
    } catch (err) {
      alert("Could not open a tab: " + err.message);
    }
  }

  // Fetch Agent History. A setting change can race an in-flight poll; only
  // render the newest request so an old line count cannot overwrite it.
  let historyRequest = 0;
  async function fetchHistory(forceScroll = false, forceRender = false) {
    if (!state.activePaneId) return;
    const request = ++historyRequest;
    const paneId = state.activePaneId;
    const lines = state.linesCount;

    try {
      const url = `/api/agents/${encodeURIComponent(paneId)}/history?lines=${lines}&source=recent_unwrapped&format=ansi`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch history");
      const data = await res.json();
      if (request !== historyRequest || paneId !== state.activePaneId || lines !== state.linesCount) return;
      const newText = data.text || "";
      if (forceRender || newText !== state.historyText) {
        // Something in it is selected: hold the redraw. See releaseHeld.
        if (transcriptHeld()) {
          state.heldHistory = newText;
          return;
        }
        state.historyText = newText;
        renderTranscript(newText);

        // Auto-scroll to bottom if user hasn't scrolled up, or if forced.
        // The transcript keeps polling behind a chat that covers it (see
        // renderChatSurface), and on a phone it shares the document scroller
        // with that chat now - scrolling a hidden transcript would drag the
        // chat the user is actually reading down with it.
        if ((!state.isUserScrolledUp || forceScroll) && !elHistoryContainer.classList.contains("hidden")) {
          scrollToBottom();
        }
      }
    } catch (err) {
      console.warn("fetchHistory error:", err);
    }
  }

  // Scroll to Bottom
  function historyScroller() {
    return wide.matches || document.documentElement.classList.contains("pinned")
      ? elHistoryContainer : document.scrollingElement;
  }

  function scrollToBottom(smooth = false) {
    const scroller = historyScroller();
    if (smooth) {
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: "smooth",
      });
    } else {
      scrollContainerToBottom(scroller);
    }
    state.isUserScrolledUp = false;
    updateScrollButton();
  }

  function scrollContainerToBottom(container) {
    container.scrollTop = container.scrollHeight;
  }
  window.SheepItScrollToBottom = scrollContainerToBottom;

  // Check scroll position
  function onHistoryScroll() {
    const threshold = 80;
    const scroller = historyScroller();
    const distanceToBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

    state.isUserScrolledUp = distanceToBottom > threshold;
    updateScrollButton();
  }

  function updateScrollButton() {
    elBtnScrollBottom.classList.toggle("hidden", !state.isUserScrolledUp);
  }

  /* ----------------------------------------------------- Holding still ---
   *
   * Both views redraw out from under you: the transcript is rewritten whole
   * every time the pane's text changes, and the console is repainted by
   * whatever Herdr sends. Either redraw takes a selection with it, which is
   * why a long press on a phone could never hold a line still long enough to
   * copy it - the handles appeared and two seconds later the text underneath
   * them was gone.
   *
   * So while something is selected, what arrives is held and applied the
   * moment the selection goes away. Nothing is dropped and nothing is
   * reordered; the screen simply waits for the hand that is on it.
   */
  function selectionIn(el) {
    if (!el) return false;
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
  }

  function transcriptHeld() {
    return selectionIn(elHistoryContent);
  }

  function consoleHeld() {
    return selectionIn(elConsoleTerm);
  }

  /* Put back whatever was held while the selection stood. Called on every
     selectionchange, which is also what fires when a tap collapses it. */
  function releaseHeld() {
    if (state.heldHistory !== null && !transcriptHeld()) {
      const text = state.heldHistory;
      state.heldHistory = null;
      if (text !== state.historyText) {
        state.historyText = text;
        renderTranscript(text);
        if (!state.isUserScrolledUp) scrollToBottom();
      }
    }
    if (consoleState.held.length && !consoleHeld()) {
      const frames = consoleState.held;
      consoleState.held = [];
      consoleState.heldBytes = 0;
      const term = consoleState.term;
      if (!term) return;
      for (const bytes of frames) term.write(bytes);
    }
  }

  document.addEventListener("selectionchange", releaseHeld);

  function openGlobalSettings() {
    triggerHaptic();
    if (elGlobalSettingsView) {
      elGlobalSettingsView.classList.remove("hidden");
      refreshGlobalSettings();
    }
  }

  function closeGlobalSettings() {
    if (elGlobalSettingsView) {
      elGlobalSettingsView.classList.add("hidden");
    }
  }

  /* Send through the gateway's single prompt path. It queues regular prompts
     until the pane and usage window are ready, but delivers /clear immediately. */
  async function submitPrompt(e) {
    if (e) e.preventDefault();
    if (state.chatVisible || state.activeChatId || !elChatView.classList.contains("hidden")) return;
    const images = attachStrip.list;
    if (images.some((image) => !image.name)) return; // still uploading
    const attachmentText = images.map((image) => `@${image.name}`).join(" ");
    const text = [elPromptInput.value.trim(), attachmentText].filter(Boolean).join(" ");
    if (!text || !state.activePaneId || state.isSending) return;

    state.isSending = true;
    state.queueRequest++; // and one already asked is answered too early
    elBtnSend.disabled = true;
    triggerHaptic();

    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, pane_id: state.activePaneId }),
      });
      const data = await res.json();

      if (!data.ok) {
        alert("Prompt failed: " + (data.error?.message || data.error || "Unknown error"));
        return;
      }

      // Success: the draft has become the agent's problem, and what it said
      // goes behind the arrow so it can be brought back and sent again.
      rememberSent(state.activePaneId, text);
      resetRecall();
      clearDraft(state.activePaneId);
      elPromptInput.value = "";
      hideCompletions();
      attachStrip.clear();
      autoResizeTextarea();
      elBtnSend.disabled = true;

      state.isUserScrolledUp = false;
      // Held back for the moment it takes to be delivered, so the common case
      // - straight into a free chat - never draws a queue chip at all. What is
      // actually being held shows up when the grace is up.
      holdBack(data.id);
      setTimeout(() => {
        fetchAgents();
        fetchHistory(true);
      }, 300);
    } catch (err) {
      alert("Error sending prompt: " + err.message);
    } finally {
      state.isSending = false;
    }
    fetchQueue();
  }

  /* Send Key Action. A refused key used to fail silently, which on a phone is
     indistinguishable from a key that landed - so the button that was tapped
     says so itself. Not an alert(): iOS suppresses those in a home screen web
     app once the user has dismissed a few. */
  async function sendKey(key, btn = null) {
    if (!state.activePaneId) return false;
    triggerHaptic("warning");

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(state.activePaneId)}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      if (res.ok) {
        setTimeout(() => fetchHistory(true), 300);
        return true;
      }
      flashKeyFailed(btn);
      return false;
    } catch (err) {
      console.error("Failed to send key:", err);
      flashKeyFailed(btn);
      return false;
    }
  }

  function flashKeyFailed(btn) {
    if (!btn) return;
    btn.classList.add("key-failed");
    setTimeout(() => btn.classList.remove("key-failed"), 900);
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
  function activeToken(input = elPromptInput) {
    const pos = input.selectionStart ?? input.value.length;
    const upto = input.value.slice(0, pos);
    const match = /(^|\s)@(\S*)$/.exec(upto);
    if (!match) return null;
    return { query: match[2], start: pos - match[2].length };
  }

  function hideCompletions(bar = elCompleteBar) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
  }

  function scheduleCompletion(input = elPromptInput, bar = elCompleteBar) {
    clearTimeout(completeTimer);
    const token = activeToken(input);
    if (!token || !state.activePaneId) {
      hideCompletions(bar);
      return;
    }
    completeTimer = setTimeout(() => fetchCompletions(token.query, bar), 130);
  }

  async function fetchCompletions(query, bar = elCompleteBar) {
    if (completeAbort) completeAbort.abort();
    completeAbort = new AbortController();
    try {
      const url = `/api/agents/${encodeURIComponent(state.activePaneId)}/files?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: completeAbort.signal });
      if (!res.ok) return hideCompletions(bar);
      const data = await res.json();
      renderCompletions(data.entries || [], bar);
    } catch (err) {
      if (err.name !== "AbortError") hideCompletions(bar);
    }
  }

  function renderCompletions(entries, bar = elCompleteBar) {
    if (!entries.length) return hideCompletions(bar);
    bar.innerHTML = entries
      .map(
        (e) =>
          `<button type="button" class="complete-chip${e.is_dir ? " is-dir" : ""}" data-path="${escapeHtml(e.path)}" data-dir="${e.is_dir ? 1 : 0}">${escapeHtml(e.name)}${e.is_dir ? "/" : ""}</button>`
      )
      .join("");
    bar.classList.remove("hidden");
  }

  /// Replace the token under the caret; a directory stays open for the next segment.
  function applyCompletion(path, isDir, input = elPromptInput, bar = elCompleteBar) {
    const token = activeToken(input);
    if (!token) return;
    const value = input.value;
    const insert = path + (isDir ? "/" : " ");
    input.value = value.slice(0, token.start) + insert + value.slice(token.start + token.query.length);
    const caret = token.start + insert.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    if (input === elPromptInput) autoResizeTextarea();
    triggerHaptic();
    if (isDir) scheduleCompletion(input, bar);
    else hideCompletions(bar);
  }

  // Keep focus in the composer when a chip is pressed.
  elCompleteBar.addEventListener("mousedown", (e) => e.preventDefault());

  elCompleteBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".complete-chip");
    if (chip) applyCompletion(chip.dataset.path, chip.dataset.dir === "1");
  });
  // Auto-resize textarea
  // A single line of the composer: padding, border and one `line-height`.
  const ONE_LINE = 40;

  function autoResizeTextarea() {
    const focused = elPromptInput.classList.contains("expanded");
    // What is visible, not innerHeight: on an iPhone that ignores the
    // keyboard, and 40% of it was nearly all the room left above the keys.
    const visible = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const cap = state.chatVisible || focused ? Math.max(120, Math.round(visible * 0.3)) : 120;
    const height = SheepItComposer.resizeTextarea(elPromptInput, cap);
    // Past one line there is room beside the box for a column of buttons.
    elPromptForm.classList.toggle("stacked", height > ONE_LINE);
    elBtnSend.disabled = elPromptInput.value.trim().length === 0;
    syncRecall();
  }

  /* ---------------------------------------------------------- Recall ---
   *
   * The arrow a terminal has. An empty composer offers it, and it brings back
   * what was last sent to this chat so it can be edited and sent again -
   * rewording a prompt that did not land, or running the same one after a
   * `/clear`. Tapping again walks further back, exactly like holding up at a
   * shell prompt. Anything you type ends the walk: from that keystroke on the
   * text is yours rather than something being recalled, and an arrow that
   * would throw it away has no business still being on screen.
   */
  const HISTORY_KEY = "sheepit.history";
  // A phone is not where anybody scrolls back forty prompts.
  const MAX_HISTORY = 20;
  const MAX_HISTORY_CHATS = 40;

  const recallHistory = SheepItComposer.createRecallHistory({
    getHistory: () => state.history,
    setHistory: (history) => { state.history = history; },
    read: () => readPref("history"),
    write: (value) => savePref(HISTORY_KEY, value),
    input: elPromptInput,
    getScope: () => state.activePaneId,
    getRecall: () => state.recall,
    setRecall: (recall) => { state.recall = recall; },
    maxEntries: MAX_HISTORY,
    maxScopes: MAX_HISTORY_CHATS,
    resize: autoResizeTextarea,
    rememberDraft,
    haptic: () => triggerHaptic(),
    showButton: (show) => elBtnRecall.classList.toggle("hidden", !show),
  });

  function loadHistory() {
    return recallHistory.load();
  }

  function saveHistory() {
    recallHistory.save();
  }

  function historyFor(paneId) {
    return recallHistory.forScope(paneId);
  }

  /* Newest last, the way a shell keeps it. The same prompt sent twice running
     is one entry: the walk back is for finding something, and a run of
     identical lines is the one thing it never helps you find. */
  function rememberSent(paneId, text) {
    recallHistory.rememberSent(paneId, text);
  }

  /* One step further back, stopping at the oldest rather than wrapping round:
     a list that wraps hands you the newest prompt again just as you were
     getting somewhere, with nothing on screen to say it has turned around. */
  function recallPrev() {
    recallHistory.previous();
  }

  /* The arrow is offered where it means something and nowhere else: an empty
     box with something behind it, or a box still holding exactly what the
     last tap put there. */
  function syncRecall() {
    recallHistory.sync();
  }

  function resetRecall() {
    recallHistory.reset();
  }

  /* -------------------------------------------------------- Attachments ---
   *
   * A screenshot is the one thing the phone has that the laptop does not, and
   * there was no way to hand one over: Claude Code pastes images from the
   * clipboard of the machine it runs on, and the console forwards keystrokes
   * rather than bytes. So the image goes up to the gateway, which writes it
   * beside the work, and the prompt carries its path - a thing both agents
   * already understand.
   *
   * The strip and its hidden [{name, url}] array are composer.js, shared with
   * chat - "name" here is the path an upload lands at. Nothing is spliced into
   * the visible text; submitPrompt folds the strip's paths into `@path` tokens
   * only at send time, the way gateway/panechat.py already does for a pane
   * chat's own images.
   * ---------------------------------------------------------------------- */

  const { imagesIn } = SheepItComposer;

  const attachStrip = SheepItComposer.createAttachStrip(
    elAttachStrip,
    async (blob, paneId, filename) => {
      const res = await fetch(`/api/agents/${encodeURIComponent(paneId)}/attach`, {
        method: "POST",
        headers: uploadHeaders(blob, filename),
        body: blob,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "the gateway would not take it");
      return data.path;
    },
    (message) => showAttachError(message),
    (images) => { elBtnSend.disabled = !elPromptInput.value.trim() && !images.length; }
  );

  /* The name rides along only for its extension - the gateway names the file. */
  function uploadHeaders(blob, filename) {
    return {
      "Content-Type": blob.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(filename || ""),
    };
  }
  window.SheepItUploadHeaders = uploadHeaders;

  async function attachFiles(files, paneId = state.activePaneId) {
    if (!files || !files.length) return;
    if (!paneId || state.activePaneId !== paneId) return;
    triggerHaptic();
    setAttachBusy(true);
    try {
      await attachStrip.add(files, paneId);
    } finally {
      setAttachBusy(false);
    }
  }

  function setAttachBusy(busy) {
    elBtnAttach.classList.toggle("busy", busy);
    elBtnAttach.disabled = busy;
  }

  function showAttachError(message) {
    /* Not an alert(): iOS stops showing those in an installed web app once a
       few have been dismissed, and a silently dropped screenshot looks
       exactly like one that went. */
    elAttachStrip.classList.remove("hidden");
    elAttachStrip.innerHTML += `<div class="attach-error">Could not attach it — ${escapeHtml(message)}</div>`;
  }

  elBtnAttach.addEventListener("click", () => {
    if (state.chatVisible || state.activeChatId) {
      document.getElementById("chat-attach-input").click();
      return;
    }
    if (!state.activePaneId) return;
    elAttachInput.click();
  });

  elBtnPasteImage.addEventListener("click", async () => {
    const paneId = state.activePaneId;
    if (!paneId) return;
    try {
      const images = await SheepItComposer.clipboardImages();
      if (state.activePaneId !== paneId) return;
      if (images.length) attachFiles(images, paneId);
      else showAttachError("No photo is available in the clipboard. Try the image button.");
    } catch (err) {
      if (state.activePaneId === paneId)
        showAttachError("Could not read the clipboard photo. Try the image button.");
    }
  });

  /* Paste a screenshot straight in. iOS copies one to the clipboard the moment
     you take it, which makes this the shortest path there is between seeing
     something wrong and an agent looking at it - shorter than the photo
     library, which is what the paperclip opens.

     Listened for on the document rather than the composer: a paste is aimed at
     whatever has focus, and on a phone that is as often the page as the
     textarea. Text pastes are left entirely alone. */
  document.addEventListener("paste", (e) => {
    // Text belongs to xterm when the console is open; photos are uploaded to
    // the pane and inserted as @path tokens for the terminal prompt.
    if (!elConsoleView.classList.contains("hidden")) {
      const images = imagesIn(e.clipboardData);
      if (!images.length) return;
      e.preventDefault();
      // xterm stops paste events at its hidden textarea, so handle images in
      // capture phase and keep its text-paste handler from seeing the image.
      e.stopPropagation();
      attachConsoleFiles(images);
      return;
    }
    if (state.chatVisible || state.activeChatId) return;
    if (!state.activePaneId) return;
    const images = imagesIn(e.clipboardData);
    if (images.length && images.every((image) => image.type.startsWith("image/"))) {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement !== elPromptInput) elPromptInput.focus();
      attachFiles(images);
      return;
    }
    // Safari can advertise a screenshot on the pasteboard without exposing a
    // File in this event. Read it directly while the paste gesture is active.
    const types = [...(e.clipboardData?.types || [])];
    const imageHint = types.some((type) => type === "Files" || type.startsWith("image/"));
    const text = e.clipboardData?.getData("text/plain") || "";
    if (text && !imageHint && !images.length) return;
    const suspectedPhoto = images.length > 0 || imageHint || !types.length;
    if (suspectedPhoto) {
      e.preventDefault();
      e.stopPropagation();
    }
    const paneId = state.activePaneId;
    SheepItComposer.clipboardImages().then((fromClipboard) => {
      if (state.activePaneId !== paneId || state.chatVisible || state.activeChatId) return;
      const usable = fromClipboard.length ? fromClipboard : images;
      if (usable.length) attachFiles(usable, paneId);
      else if (suspectedPhoto) showAttachError("Safari did not provide the pasted photo. Try the image button.");
    }).catch(() => {
      if (state.activePaneId !== paneId) return;
      if (images.length) attachFiles(images, paneId);
      else if (suspectedPhoto)
        showAttachError("Could not read the pasted photo. Try the image button.");
    });
  }, true);

  /* Dragging a file onto the composer, which is how the same thing happens on
     a laptop. `dragover` has to be refused for a drop to be offered at all -
     and it can only ask *whether* files are coming, because reading one mid-drag
     is not allowed: `getAsFile()` is null until the thing is actually dropped. */
  elPromptInput.addEventListener("dragover", (e) => {
    const types = e.dataTransfer ? [...(e.dataTransfer.types || [])] : [];
    if (state.activePaneId && types.includes("Files")) e.preventDefault();
  });

  elPromptInput.addEventListener("drop", (e) => {
    if (state.chatVisible || state.activeChatId) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length || !state.activePaneId) return;
    e.preventDefault();
    attachFiles(files);
  });

  elAttachInput.addEventListener("change", async () => {
    const files = [...(elAttachInput.files || [])];
    // Let the same file be picked twice in a row.
    elAttachInput.value = "";
    await attachFiles(files);
  });

  /* ------------------------------------------------------------- Queue --- */

  /* A queued prompt is either still ours or it never made it. Delivered ones
     are filtered out in fetchQueue and never reach this list. */
  const QUEUE_WORD = {
    waiting: "queued",
    failed: "failed",
  };

  /* A prompt that is about to go out should never be drawn as one that is
     waiting. Dispatch can take a few seconds even in a free chat, so drawing
     it as soon as the gateway accepts it flashes a queue card above the
     composer and moves the input down before the prompt is delivered.

     So a freshly accepted prompt is held back for as long as delivery takes.
     Nothing is hidden beyond that: one that is still waiting when the grace is
     up appears then, and one that failed appears at once, because a failure is
     the case worth interrupting for. */
  const QUEUE_SETTLE_MS = 5000;

  function isSettling(prompt, now) {
    const until = state.settling.get(prompt.id);
    if (!until) return false;
    if (now >= until) {
      state.settling.delete(prompt.id);
      return false;
    }
    return prompt.state === "waiting";
  }

  /* What the queue shows is what is still owed: prompts holding for a window
     or a busy chat, plus anything that failed and is going nowhere. A
     delivered prompt belongs to the conversation now - it is in the
     transcript, and leaving it here only buries what still needs you. */
  function stillOwed(prompts, now = Date.now()) {
    return prompts.filter((p) => p.state !== "sent" && !isSettling(p, now));
  }

  /* Keep a just-queued prompt out of the strip, and come back when the grace
     is up so one that is genuinely being held still appears without waiting on
     the next poll. */
  function holdBack(id) {
    if (!id) return;
    state.settling.set(id, Date.now() + QUEUE_SETTLE_MS);
    setTimeout(() => {
      state.settling.delete(id);
      fetchQueue();
    }, QUEUE_SETTLE_MS + 50);
  }

  function quotaIsStale() {
    return Date.now() - state.quotaAt > 30000;
  }

  async function fetchQueue() {
    // A poll answered mid-send has the new row in it but not yet its grace.
    if (state.isSending) return;
    const request = ++state.queueRequest;
    try {
      const res = await fetch("/api/queue");
      const data = await res.json();
      if (!data.ok || request !== state.queueRequest || state.isSending) return;
      state.queue = stillOwed(data.prompts || []);
      renderChatQueue();
      // The herd is polled before the queue, so the counts on the rows arrive
      // a beat later than the rows do. The signature keeps this cheap: it only
      // redraws when a number actually moved.
      if (state.pickerOpen) renderAgentList();
    } catch (err) {
      /* The connection dot already says the gateway is unreachable; a failed
         queue poll should not also blank the list you were reading. */
    }
  }

  async function fetchQuota() {
    if (!quotaIsStale()) return;
    try {
      const res = await fetch(
        `/api/queue/quota${state.machineStrip ? "" : "?machine=0"}`);
      state.quota = await res.json();
      state.quotaAt = Date.now();
      if (state.pickerOpen) {
        renderQuota();
        // The grass is this reading too. The signature keeps it cheap: a field
        // that has not visibly moved redraws nothing and restarts no animation.
        renderAgentList();
      }
    } catch (err) {
      /* keep the last reading */
    }
  }

  function relTime(iso) {
    if (!iso) return "";
    const secs = (new Date(iso).getTime() - Date.now()) / 1000;
    if (secs <= 0) return "now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  }

  /* How much subscription is left, per agent: a line each, small enough to
     live above the flock without pushing it down the screen.

     Two agents have two subscriptions and two answers - a Claude window says
     nothing about what a Codex pane may spend - so each gets its own line, and
     only the agents actually on this machine are drawn. */
  function quotaHtml() {
    const q = state.quota;
    if (!q) return '<div class="quota-note">Reading usage…</div>';
    const agents = q.agents || [];
    const lines = agents.length
      ? agents.map((a) => agentQuotaHtml(a)).join("")
      : '<div class="quota-note">No agents running.</div>';
    return lines + machineHtml(q.machine);
  }

  /* And what the machine they all run on has left, under the same bars.

     The subscription is one wall and the laptop is the other: four agents
     compiling at once is slow in a way no usage window explains, and it is the
     same glance that asks. Percentages of the whole machine, so the number
     means the same thing on a laptop as on the box under the desk - with the
     core count beside it, because 100% of two is not 100% of sixteen.

     Swap is held to a harder line than memory: memory at three quarters is a
     machine doing its job, swap at three quarters is a machine already paying
     for it in page faults. */
  const CPU_NEAR = 75;
  const CPU_OUT = 95;
  const SWAP_NEAR = 25;
  const SWAP_OUT = 60;

  /* Five readings and room for two of them a line, so the block is laid out in
     pairs: cpu and ram, then whatever else this machine keeps. The continuation
     rows carry an empty name column rather than starting at the margin, so
     every bar sits under the one above it - a wrapped flex item would land
     half a column to the left of the readings it belongs with. */
  function machineHtml(m) {
    if (!state.machineStrip) return "";
    if (!m || m.ok === false) return "";
    const mem = m.memory || {};
    const cells = [
      meterHtml("cpu", m.cpu, m.cores ? `${m.cores}×` : ""),
      meterHtml("ram", mem.percent, fmtBytes(mem.total)),
    ];
    // A machine with swap off has no swap line: 0% of nothing is not a fact
    // about it. Same for the counters an operating system does not keep.
    if (m.swap) {
      cells.push(meterHtml("swap", m.swap.percent, fmtBytes(m.swap.total),
                           SWAP_NEAR, SWAP_OUT));
    }
    if (m.disk) cells.push(flowHtml("disk", m.disk.read, m.disk.write));
    if (m.net) cells.push(flowHtml("net", m.net.rx, m.net.tx));

    const load = m.load === null || m.load === undefined
      ? "" : `<span class="usage-rate">load ${m.load.toFixed(1)}</span>`;
    const rows = [];
    for (let i = 0; i < cells.length; i += 2) {
      const head = i === 0
        ? `<span class="usage-agent">${escapeHtml(m.host || "machine")}${load}</span>`
        : '<span class="usage-agent" aria-hidden="true"></span>';
      rows.push(`<div class="usage machine${i ? " more" : ""}">${
        head}${cells.slice(i, i + 2).join("")}</div>`);
    }
    return rows.join("");
  }

  /* One bar, built like a usage window so the two line up column for column -
     a reading nobody could take draws the empty bar rather than disappearing,
     since a missing line reads as a machine with nothing running on it. */
  function meterHtml(label, percent, trailing, near, out) {
    const known = percent !== null && percent !== undefined && isFinite(percent);
    const pct = known ? Math.max(0, Math.min(100, percent)) : 0;
    const hot = out === undefined ? CPU_OUT : out;
    const warm = near === undefined ? CPU_NEAR : near;
    const cls = !known ? "past" : pct >= hot ? "out" : pct >= warm ? "near" : "";
    return `
      <span class="usage-window${cls ? " " + cls : ""}">
        <span class="usage-label">${escapeHtml(label)}</span>
        <span class="usage-bar"><span class="usage-fill" style="width:${pct}%"></span></span>
        <span class="usage-pct">${known ? `${pct.toFixed(0)}%` : "—"}</span>
        <span class="usage-when">${escapeHtml(trailing || "")}</span>
      </span>`;
  }

  /* Throughput has no full: a disk is not 80% of anything, it is simply moving
     this much right now. So these two get the same column as a bar but spend it
     on both directions instead, in and out under one arrow each. */
  function flowHtml(label, down, up) {
    return `
      <span class="usage-window flow">
        <span class="usage-label">${escapeHtml(label)}</span>
        <span class="usage-flow">↓${fmtRate(down)} ↑${fmtRate(up)}</span>
      </span>`;
  }

  function fmtBytes(bytes) {
    if (!bytes) return "";
    const gb = bytes / 1073741824;
    if (gb >= 10) return `${gb.toFixed(0)}G`;
    if (gb >= 1) return `${gb.toFixed(1)}G`;
    return `${Math.round(bytes / 1048576)}M`;
  }

  /* Bytes a second, in the fewest characters that still say it - two of these
     share the width one bar gets. Under a kilobyte a second is the machine
     breathing, and prints as a plain 0 rather than a decimal nobody wants;
     nothing at all is a dash, because measured-and-idle and not-measured must
     not look the same. */
  function fmtRate(bytes) {
    if (bytes === null || bytes === undefined || !isFinite(bytes)) return "—";
    const mb = bytes / 1048576;
    if (mb >= 10) return `${mb.toFixed(0)}M`;
    if (mb >= 1) return `${mb.toFixed(1)}M`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}k`;
    return "0";
  }

  // "five_hour" is what the endpoint calls it; "5h" is what fits on a phone.
  function windowLabel(name) {
    if (name === "five_hour") return "5h";
    if (name === "seven_day") return "week";
    const m = /^(\d+)_(hour|day)$/.exec(name || "");
    if (m) return m[2] === "hour" ? `${m[1]}h` : `${m[1]}d`;
    return String(name || "").replace(/_/g, " ");
  }

  // How long the window is, in hours, from the same name.
  function windowHours(name) {
    if (name === "five_hour") return 5;
    if (name === "seven_day") return 168;
    const m = /^(\d+)_(hour|day)$/.exec(name || "");
    if (!m) return 0;
    return m[2] === "hour" ? Number(m[1]) : Number(m[1]) * 24;
  }

  /* How fast a window is going down, in percent an hour.

     No history is kept for this and none is needed: a window's length is in
     its name and its end is in `resets_at`, so how far into it we are is
     arithmetic on one reading. Which matters, because the phone only asks for
     usage while the overview is open - a rate built from samples would be
     blank every time you came back to it.

     It is an average over the window so far, not a speedometer: an agent that
     spent an hour hammering and then went quiet still reads high for a while.
     That is the honest shape of the number the percentage is taken from. */
  const RATE_FLOOR_HOURS = 0.25;

  function burnRate(bucket) {
    if (!bucket || bucket.expired || !bucket.resets_at) return null;
    const length = windowHours(bucket.name);
    if (!length) return null;
    const left = (new Date(bucket.resets_at).getTime() - Date.now()) / 3600000;
    if (!isFinite(left)) return null;
    const elapsed = length - left;
    // Minutes into a window, any rate is a rounding error with a decimal point.
    if (elapsed < RATE_FLOOR_HOURS) return null;
    return Math.max(0, bucket.utilization) / elapsed;
  }

  function rateLabel(rate) {
    if (rate === null || rate === undefined) return "";
    return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}%/h`;
  }

  /* ---------------------------------------------------------- The pasture ---
   *
   * What the flock stands on, read off the same numbers the strip prints.
   *
   * `left` is the tightest window rather than an average of them: what stops
   * you is whichever runs out first, and a weekly window with plenty in it
   * says nothing about the five hours you are actually inside of. A window
   * that has rolled over describes a wall that is gone, so it is not counted
   * at all.
   *
   * `chew` is how fast the grazing animation runs - the visible half of "how
   * much is this one eating". It is bucketed on purpose: the list only redraws
   * when its signature moves, and a duration that tracked the rate exactly
   * would restart every sheep's animation on every poll.
   */
  const CHEW_SPEEDS = [
    [3, "3.4s"],   // nibbling
    [10, "2.4s"],  // steady
    [20, "1.7s"],  // hungry
    [Infinity, "1.1s"],
  ];

  function chewSpeed(rate) {
    if (rate === null || rate === undefined) return "";
    return (CHEW_SPEEDS.find(([under]) => rate < under) || [])[1] || "";
  }

  function pastureOf(kind) {
    if (!kind || !state.quota) return null;
    const reading = (state.quota.agents || []).find((a) => a.agent === kind);
    // An agent nobody can price gets no field rather than an empty one: not
    // knowing and having nothing left are opposite things.
    if (!reading || reading.ok === false) return null;
    const live = (reading.buckets || [])
      .filter((b) => !b.expired && (b.utilization > 0 || b.resets_at));
    if (!live.length) return null;
    const tightest = live.reduce((worst, b) => (b.utilization > worst.utilization ? b : worst));
    const rate = burnRate(fastestWindow(reading));
    return {
      left: Math.max(0, Math.min(100, 100 - tightest.utilization)) / 100,
      // Spent, not merely low - the same line the queue holds prompts on.
      spent: !!reading.blocked || tightest.utilization >= 100,
      rate,
      chew: chewSpeed(rate),
    };
  }

  /* What the flock's signature carries: sevenths, which is the granularity the
     field is actually drawn at. A redraw restarts every sheep mid-chew, so a
     window that moved a third of a percent - and took no blade with it - must
     not cost the whole list its animation. */
  const FIELD_BLADES = 7;

  function pastureMark(pasture) {
    if (!pasture) return "";
    return `${Math.round(pasture.left * FIELD_BLADES)}${pasture.spent ? "s" : ""}${pasture.chew}`;
  }

  /* When the window comes back, in as few characters as will still say it.

     A reset you could sit and wait for is a time - including the small hours
     of tomorrow, which is where a five hour window started in the evening
     lands, and "15.9." for something happening at 03:36 tonight says less than
     nothing. A reset days away is answered by its date; the minute it happens
     on is not what anybody is asking at that distance. */
  const SOON_HOURS = 18;

  function resetLabel(iso) {
    if (!iso) return "";
    const at = new Date(iso);
    if (isNaN(at)) return "";
    const hours = (at.getTime() - Date.now()) / 3600000;
    if (hours < SOON_HOURS) {
      return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return `${at.getDate()}.${at.getMonth() + 1}.`;
  }

  /* One line per agent, one bar per window. Both windows matter and they run
     out independently - a five hour window that is fine says nothing about a
     weekly one that is nearly gone - so each gets its own bar rather than the
     row showing whichever was worse. */
  function agentQuotaHtml(a) {
    const name = (a.agent || "agent").replace(/^./, (c) => c.toUpperCase());
    if (a.ok === false) {
      // Not knowing is not the same as having nothing left: the queue keeps
      // delivering, so this says what is missing rather than crying wolf.
      return `
        <div class="usage">
          <span class="usage-agent">${escapeHtml(name)}</span>
          <span class="usage-detail muted">${escapeHtml(a.error || "no usage reading")}</span>
        </div>`;
    }

    /* Buckets that are empty and have no window carry no information - they
       are plan slots this account does not use. */
    const windows = (a.buckets || [])
      .filter((b) => b.utilization > 0 || b.resets_at)
      .map((b) => {
        const pct = Math.max(0, Math.min(100, b.utilization));
        /* Amber from the threshold up, red at the cap. A window that has
           rolled over is drawn as neither: what has been spent in the new one
           is not known yet, so it shows no percentage at all. */
        const cls = b.expired ? "past" : b.spent ? "out" : b.warning ? "near" : "";
        return `
          <span class="usage-window${cls ? " " + cls : ""}">
            <span class="usage-label">${escapeHtml(windowLabel(b.name))}</span>
            <span class="usage-bar"><span class="usage-fill" style="width:${b.expired ? 0 : pct}%"></span></span>
            <span class="usage-pct">${b.expired ? "—" : `${pct.toFixed(0)}%`}</span>
            <span class="usage-when">${escapeHtml(resetLabel(b.resets_at))}</span>
          </span>`;
      })
      .join("");

    /* An expired reading is too old to hold work on, so the queue has stopped
       believing it. The bars are the last thing we were told, not the truth,
       so the whole line is greyed and the reason is left to a tooltip rather
       than a sentence underneath that pushes the strip down. A window that is
       merely full needs no commentary: its own colour is the sentence. */
    const stale = a.expired
      ? ' stale" title="last known reading — running anyway until usage can be read'
      : "";

    /* How fast this one is eating, under its own name. The bars say what is
       left; this says how long that will last, which is the question you are
       actually asking when you look at a bar that is two thirds gone. It sits
       in the name's column rather than getting one of its own, because the
       strip already spends 316 of a 360px phone's pixels. */
    const rate = rateLabel(burnRate(fastestWindow(a)));

    return `
      <div class="usage${stale}">
        <span class="usage-agent">${escapeHtml(name)}${
          rate ? `<span class="usage-rate">${escapeHtml(rate)}</span>` : ""}</span>
        ${windows}
      </div>`;
  }

  // The shortest window still running: the one that says what is being spent
  // now rather than what was spent since Monday.
  function fastestWindow(a) {
    return (a.buckets || [])
      .filter((b) => !b.expired && windowHours(b.name))
      .sort((x, y) => windowHours(x.name) - windowHours(y.name))[0];
  }

  function renderQuota() {
    elPickerQuota.innerHTML = quotaHtml();
  }

  // Which chat a prompt is queued for, named the way the picker names it.
  function chatName(paneId) {
    const agent = state.agents.find((a) => a.pane_id === paneId);
    return agent ? agent.name || paneId : paneId;
  }

  /* What is waiting to go to this chat, drawn directly above the box it was
     typed into. It used to live behind its own tab, which put the one thing
     you might want to take back two taps away from the place you would notice
     it was still sitting there. */
  function queueSignature() {
    return state.queue
      .map((p) => [p.id, p.state, p.pane_id, p.prompt, p.last_error].join("\u001f"))
      .join("\u001e");
  }

  function queuedFor(paneId) {
    return state.queue.filter((p) => p.pane_id === paneId && p.state !== "sent");
  }

  /* Why a prompt is still sitting there. A queue that holds without saying so
     is indistinguishable from one that is broken - which is exactly how it
     looked when a window ran out and the strip above said nothing about the
     chat below it. */
  function holdingNote() {
    const row = (state.agents || []).find((a) => a.pane_id === state.activePaneId);
    const kind = row && row.agent;
    if (!kind || !state.quota) return "";
    const reading = (state.quota.agents || []).find((a) => a.agent === kind);
    if (!reading || !reading.blocked) return "";
    const back = resetLabel(reading.resume_at);
    const name = kind.replace(/^./, (c) => c.toUpperCase());
    return `<div class="chat-queue-note">${escapeHtml(name)} has nothing left${
      back ? ` until ${escapeHtml(back)}` : ""
    }</div>`;
  }

  function renderChatQueue() {
    /* A chat draws its own strip inside the chat view. Asked by state as well
       as by the view's class, because switching chats hides the view for the
       moment a fetch takes - long enough for this one to draw the same rows a
       second time under it, at the dock's width. */
    if (state.chatVisible || state.activeChatId
        || !elChatView.classList.contains("hidden")) {
      chatQueueStrip.render([]);
      state.queueSignature = null;
      return;
    }
    const queued = queuedFor(state.activePaneId);
    if (!queued.length) {
      chatQueueStrip.render([]);
      state.queueSignature = null;
      return;
    }
    const note = holdingNote();
    const signature = queueSignature() + state.activePaneId + note;
    if (signature === state.queueSignature && !elChatQueue.classList.contains("hidden")) return;
    state.queueSignature = signature;

    chatQueueStrip.render(queued, note);
  }

  function chatQueueRow(p) {
        const failed = p.state === "failed";
        const word = QUEUE_WORD[p.state] || p.state;
        return `
          <div class="chat-queued ${failed ? "attention" : ""}">
            <span class="chat-queued-state status-badge status-${escapeHtml(p.state)}">${escapeHtml(word)}</span>
            <span class="chat-queued-text">${escapeHtml(p.prompt || "")}</span>
            ${failed && p.last_error
                ? `<span class="chat-queued-why">${escapeHtml(p.last_error)}</span>`
                : ""}
            <span class="chat-queued-acts">
              <button type="button" class="chat-queued-act" data-composer-action="edit" data-composer-id="${p.id}">Edit</button>
              <button type="button" class="chat-queued-act accent" data-composer-action="send" data-composer-id="${p.id}">Send now</button>
              <button type="button" class="chat-queued-act danger" data-composer-action="delete" data-composer-id="${p.id}">Delete</button>
            </span>
          </div>`;
  }

  async function queueAction(id, action) {
    triggerHaptic();
    try {
      const res = await fetch(`/api/queue/${id}/${action}`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error((data.error && data.error.message) || data.error || "failed");
      state.queueSignature = null;
      await fetchQueue();
      if (action === "send") setTimeout(() => fetchHistory(true), 300);
    } catch (err) {
      alert(`Could not ${action === "send" ? "send" : action} the prompt: ${err.message}`);
    }
  }

  /* Editing a queued prompt takes it back: the text lands in the composer,
     where it can be changed with the keyboard that is already open, and the
     row goes. Sending it again queues it again. Nothing is lost on the way -
     a composer full of text is a draft, and drafts are kept per project. */
  async function editQueued(id) {
    const queued = state.queue.find((p) => String(p.id) === String(id));
    if (!queued) return;
    triggerHaptic();
    elPromptInput.value = queued.prompt || "";
    autoResizeTextarea();
    rememberDraft();
    elBtnSend.disabled = !elPromptInput.value.trim();
    elPromptInput.focus();
    await queueAction(id, "delete");
  }

  function onChatQueueAction(action, id) {
    if (action === "edit") return editQueued(id);
    return queueAction(id, action);
  }
  const chatQueueStrip = SheepItComposer.createQueueStrip(elChatQueue, chatQueueRow, onChatQueueAction);

  // Poll loop
  async function loop() {
    await fetchAgents();
    /* The console is the pane itself, drawn over the transcript: reading the
       same pane a second time is a request for a screen nobody can see. It is
       skipped rather than the whole loop being stopped, because past 900px the
       flock is still a column beside the console and has to stay alive. */
    if (elConsoleView.classList.contains("hidden")) await fetchHistory();
    // Cheap: a local SQLite read. Keeps the header badge honest even when the
    // queue is closed.
    await fetchQueue();
    if (state.pickerOpen) await fetchQuota();
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
  window.SheepItEscapeHtml = escapeHtml;

  /* Preferences that should survive a reload. The keys were "herdr.*" before
     the app was called Sheep It, and an install that has been on a home screen
     since then still holds them - so read the old name where the new one is
     missing, rather than silently resetting every toggle on upgrade. */
  function readPref(name) {
    const value = localStorage.getItem(`sheepit.${name}`);
    return value === null ? localStorage.getItem(`herdr.${name}`) : value;
  }

  function loadPrefs() {
    try {
      state.paneView = readPref("view") || (wide.matches ? "chat" : "transcript");
      state.flockTab = readPref("flocktab") === "chats" ? "chats" : "projects";
      // Normal is a phone-only view. Older builds may have saved either its
      // current or former name; migrate both values before the first render.
      if (wide.matches && ["normal", "transcript"].includes(state.paneView)) {
        state.paneView = "chat";
      }
      setDiffLayout(readPref("diffsplit") === "1");
      setKeysBar(readPref("keys") !== "0");
      state.activity = loadActivity();
      state.customOrder = loadOrder();
      state.folders = loadFolders();
      state.collapsed = loadCollapsed();
      state.drafts = loadDrafts();
      state.history = loadHistory();
      state.bleat = readPref("bleat") !== "0";
      elToggleBleat.checked = state.bleat;
      state.machineStrip = readPref("machine") === "1";
      elToggleMachine.checked = state.machineStrip;
    } catch (err) {
      /* localStorage unavailable in private mode; defaults are fine */
    }
  }

  /* Recency ordering. Herdr has no timestamps, but every pane carries a
     state_change_seq that only ever grows, so watching it across polls tells us
     when a project last did something - and opening one here counts too. Both
     land as wall-clock stamps in localStorage, which is why the order survives
     a reload and follows this phone rather than the server's workspace
     numbering. */
  const ACTIVITY_KEY = "sheepit.activity";

  /* Half-written prompts, one per pane.

     A prompt on a phone is written in the gaps - a sentence now, the rest
     after the bus stop - and switching to another project to see what it is
     doing used to throw the sentence away. So the composer's text belongs to
     the pane it was typed for: leave, come back, and it is still there, still
     where the caret was. It lives in localStorage, so it survives the app
     being closed and the phone being locked, and it is this phone's - nothing
     is sent anywhere until you send it.

     Drafts are dropped when their prompt is sent, and the oldest are dropped
     when there are more than a phone will ever need. Panes that vanish are
     deliberately not pruned against the agent list: a poll can blink and come
     back, and losing a half-written prompt to that would be worse than
     keeping a few dead keys. */
  const DRAFTS_KEY = "sheepit.drafts";
  const MAX_DRAFTS = 40;

  const draftStore = SheepItComposer.createDraftStore({
    getDrafts: () => state.drafts,
    setDrafts: (drafts) => { state.drafts = drafts; },
    read: () => readPref("drafts"),
    write: (value) => savePref(DRAFTS_KEY, value),
    input: elPromptInput,
    resize: autoResizeTextarea,
    limit: MAX_DRAFTS,
  });

  function loadDrafts() {
    return draftStore.load();
  }

  function saveDrafts() {
    draftStore.save();
  }

  /* Whose the text in the composer is: a headless chat's own, or the pane's.
     A pane read as a chat shares its pane's draft - it is the same agent, and
     the same sentence, whichever way it is being read. */
  function draftKey() {
    return state.activeChatId ? "chat:" + state.activeChatId : state.activePaneId;
  }

  /* Remember what is in the composer now, against the chat it belongs to.
     Called as you type, and again before the chat changes under it. */
  function rememberDraft(key) {
    draftStore.remember(key || draftKey());
  }

  /* Run something that may change which chat is in front, keeping the
     composer's text with the one it was typed for and bringing back the
     other's. */
  function switchDraft(change) {
    const before = draftKey();
    rememberDraft(before);
    change();
    const after = draftKey();
    if (after === before) return;
    resetRecall();
    restoreDraft(after);
  }

  function restoreDraft(paneId) {
    draftStore.restore(paneId);
  }

  function clearDraft(paneId) {
    draftStore.clear(paneId);
  }

  function loadActivity() {
    try {
      const raw = JSON.parse(readPref("activity") || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function saveActivity() {
    savePref(ACTIVITY_KEY, JSON.stringify(state.activity));
  }

  /* Stamp anything whose sequence moved and forget panes that are gone. This
     is what dates the "3m" on a row; the order of the list is somebody else's
     job entirely. */
  // How many polls a pane may be missing from the list before it is forgotten.
  const FORGET_AFTER_MISSES = 5;

  function trackActivity() {
    const now = Date.now();
    const next = {};
    let changed = false;

    for (const a of state.agents) {
      const id = a.pane_id;
      if (!id) continue;
      const seq = Number(a.state_change_seq) || 0;
      const prev = state.activity[id];
      if (prev && prev.seq === seq) {
        next[id] = prev.miss ? { seq: prev.seq, ts: prev.ts, seeded: prev.seeded } : prev;
        if (prev.miss) changed = true;
      } else {
        // A first sighting is not a change: we have no idea when it happened,
        // so the stamp carries no time to show.
        next[id] = { seq, ts: now, seeded: !prev };
        changed = true;
      }
    }

    /* A pane missing from one poll is the gateway blinking far more often than
       it is a closed workspace, and rebuilding the map from the current rows
       alone meant a single empty answer re-seeded every project - every age
       label blank, for good. Let an absence stand a few polls first. */
    for (const id of Object.keys(state.activity)) {
      if (next[id]) continue;
      const entry = state.activity[id];
      const miss = (entry.miss || 0) + 1;
      if (miss >= FORGET_AFTER_MISSES) {
        changed = true;
        continue;
      }
      next[id] = { seq: entry.seq, ts: entry.ts, seeded: entry.seeded, miss };
    }

    state.activity = next;
    if (changed) saveActivity();
  }

  /* ----------------------------------------------------------- The flock ---
   *
   * The overview is the herd sorted the way you look for things in it: by the
   * project the sheep is grazing, then by the one fact that cannot wait.
   *
   * Ordering used to follow whatever moved last, which meant the list
   * rearranged itself under your thumb every few seconds - five sheep on one
   * project, each finishing a tool call, and the row you were reaching for was
   * somewhere else by the time you got there. Creation order never moves: a
   * project's sheep stay where you last saw them, and a new one joins the end
   * of its own project rather than jumping to the front of everything.
   *
   * A sheep waiting on a question or a finished turn may rise within its
   * project. Project headings stay where they first appeared until moved by
   * hand.
   * ------------------------------------------------------------------------ */

  /* When a row was created, as a number that only ever grows. Herdr numbers
     workspaces in the order they were opened and never renumbers them, and a
     pane's own index orders the several agents one workspace can hold. */
  function bornAt(agent) {
    const ws = Number(agent.workspace_number);
    const pane = Number((agent.pane_id || "").split(":p")[1]) || 0;
    return (Number.isFinite(ws) ? ws : Number.MAX_SAFE_INTEGER) * 1000 + pane;
  }

  /* How badly a row wants you, as a number to sort on. Herdr has no separate
     "you have not looked at this yet" flag - what it has is `done`, which is
     the state it puts a pane in when the turn ended, and which the agent
     leaves the moment anything happens in it. That is near enough to unread:
     a finished agent is owed an answer exactly as much as a blocked one is,
     and leaving it at the bottom of its project is how a turn that ended an
     hour ago goes unnoticed. It is the same pair the badge counts and the
     same pair a push fires for, so the list now agrees with both.

     A question still outranks a finished turn. An agent on a prompt has its
     work sitting half-done on screen; a finished one has already put its work
     down, and can wait the length of a scroll.

     `URGENCY` further down ranks the same two states the same way round, for a
     different question: which tab a pen's row speaks for. Both agreeing is
     what makes a row that floats open on the tab that floated it - keep them
     that way if either changes. */
  const ATTENTION = { blocked: 2, done: 1 };

  function attentionOf(agent) {
    return (agent.has_agent && ATTENTION[agent.status]) || 0;
  }

  /* Which project a row belongs under. The gateway reads it off Herdr's
     worktree record - so the scheduler's `sheep/` branches land under the
     repository they were cut from - and falls back to the directory. */
  function projectKey(agent) {
    return agent.project || agent.cwd || agent.workspace_id || "";
  }

  // Split the flock into projects, keeping each project's rows in the order
  // they arrived. Whoever calls decides what that order is.
  function groupByProject(agents) {
    const groups = new Map();
    for (const agent of agents) {
      const key = projectKey(agent);
      let group = groups.get(key);
      if (!group) {
        group = { key, name: agent.project_name || agent.name || key, agents: [], from: "" };
        groups.set(key, group);
      }
      group.agents.push(agent);
      /* Which of the project's workspaces a new worktree gets cut from. The
         project's own checkout when it is open, so a branch starts where the
         project does rather than on top of whatever a worktree opened last
         week was left sitting on. A project with no checkout open at all gets
         no plus button - there is no repository to cut from. */
      if (agent.repo && (!group.from || agent.main_checkout)) {
        group.from = agent.workspace_id;
      }
    }
    return [...groups.values()];
  }

  /* ------------------------------------------------------- One row, one pen
   *
   * A row used to be a tab, which read as a lie the moment you swiped one
   * aside: what the actions underneath it could do was close the workspace and
   * delete the checkout, because that is all a phone was ever offered. Two
   * tabs on one branch meant two rows, and closing either of them took the
   * branch and the other tab with it.
   *
   * So the overview groups by the pen rather than by the animals in it: one
   * entry per workspace, which for everything the scheduler cuts is one per
   * worktree - and what a pen with a second tab in it draws is a title with
   * both of them hung underneath (`penHtml` further up), so the actions on the
   * title act on the worktree while each sheep is still its own tab.
   * ---------------------------------------------------------------------- */

  /* Which of a workspace's tabs speaks for it. The point of the row is what it
     needs from you, so the tab that needs the most leads: a question first,
     then a turn that finished and is sitting there, then work in progress, and
     a plain shell last. Ties keep the order the project was already in, which
     is creation order. */
  const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

  function urgency(agent) {
    if (!agent.has_agent) return 5;
    const rank = URGENCY[agent.status];
    return rank === undefined ? 4 : rank;
  }

  /* Collapse a project's panes into one entry per workspace, in the order the
     panes were given. `tabs` keeps every pane, splits included, because that
     is what the strip lists and what the row counts. */
  function byWorkspace(agents) {
    const pens = new Map();
    for (const agent of agents) {
      const key = agent.workspace_id || agent.pane_id;
      let pen = pens.get(key);
      if (!pen) {
        pen = { key, workspace_id: agent.workspace_id || "", lead: agent, tabs: [] };
        pens.set(key, pen);
      }
      pen.tabs.push(agent);
      if (urgency(agent) < urgency(pen.lead)) pen.lead = agent;
    }
    return [...pens.values()];
  }

  // How many tabs a row stands for. A split tab is two panes and one tab, and
  // the number beside a row is a count of things the strip can switch between.
  function tabCount(pen) {
    return new Set(pen.tabs.map((a) => a.tab_id || a.pane_id)).size;
  }

  /* What the row's sheep is hashed from. The workspace, so the animal is the
     pen: a worktree keeps the same face for as long as it is open, and the
     tabs inside it are not five different sheep. */
  function penSeed(pen) {
    return pen.workspace_id || pen.lead.pane_id;
  }

  /* ------------------------------------------------------- The chats as rows
   *
   * A headless chat is the same Claude Code spending the same subscription in
   * the same checkout as the panes around it, and it used to live on a page of
   * its own that nothing pointed at - so a chat left asking a question was a
   * question nobody saw. It is a row here instead.
   *
   * What it is not is a pane. It has no workspace, no tab strip, no
   * transcript and no pane id Herdr would recognise, so it never enters
   * `state.agents`: it is hung on its project here and given a pen of its own
   * at the end of that project's rows. The pane id it carries is a label for
   * the DOM and the sheep hash, and deliberately unresolvable - `chat:` is not
   * a workspace prefix Herdr issues.
   * ------------------------------------------------------------------------ */

  /* What the sheep is doing. A question waiting on you is the one state that
     must never be missed, and a turn in flight is worth showing, but there is
     deliberately no `done` here: nothing marks a chat as read, so a chat that
     answered last Tuesday would sit at the top of its project asleep forever.
     A chat between turns is idle, and the push is what tells you it finished. */
  function chatStatus(chat) {
    if (chat.pending && chat.pending.length) return "blocked";
    if (chat.running) return "working";
    return "idle";
  }

  /* A chat wearing enough of a row's clothes that the list can draw it: the
     same status vocabulary, the same project key, the same agent kind - it is
     a Claude Code, so it grazes the same field as the panes do. */
  function chatRowOf(chat) {
    return {
      chat,
      pane_id: "chat:" + chat.id,
      name: chat.title || "New chat",
      project: chat.project || chat.cwd || "",
      project_name: chat.project_name || "",
      cwd: chat.cwd || "",
      agent: "claude",
      has_agent: true,
      status: chatStatus(chat),
      title: chat.title || "",
      updated: chat.updated || chat.created || 0,
      workspace_id: "",
      tab_id: "",
      tab_label: "",
      repo: false,
      main_checkout: false,
      split: false,
    };
  }

  /* The chats tab: every headless chat, the one waiting on you first and then
     the one that moved last. They used to hang under the project their cwd
     named, but a chat from `+ New` runs in the chat home, which is nobody's
     project - its heading was a project made up to hold them. While a hand is
     on the list the order they were drawn in holds, like the projects'. */
  function orderChats(held) {
    const pens = state.chats.map(chatRowOf).map((row) => ({
      key: row.pane_id, chat: row.chat, lead: row, tabs: [row],
    }));
    if (held) {
      const rank = new Map((state.chatPens || []).map((pen, i) => [pen.key, i]));
      const at = (key) => (rank.has(key) ? rank.get(key) : -1);
      pens.sort((a, b) => at(a.key) - at(b.key) || (b.lead.updated || 0) - (a.lead.updated || 0));
    } else {
      pens.sort((a, b) =>
        attentionOf(b.lead) - attentionOf(a.lead) || (b.lead.updated || 0) - (a.lead.updated || 0));
    }
    state.chatPens = pens;
  }

  function collapseTabs(groups) {
    for (const group of groups) {
      group.rows = byWorkspace(group.agents);
    }
    return groups;
  }

  /* Herdr numbers a tab before anybody names it, and "2" is not a name worth
     spending a row on - the pane's own title says more. Only a label somebody
     actually typed counts as a name here. */
  const RE_TAB_NUMBERED = /^(?:tab )?\d+$/i;

  function tabName(row) {
    const label = (row.tab_label || "").trim();
    return label && !RE_TAB_NUMBERED.test(label) ? label : "";
  }

  /* Which number the tab answers to. Herdr keeps two: `number`, its place in
     the workspace's own bookkeeping, and the label it has not been renamed
     from, which is the one the desktop's tab bar draws. The phone should agree
     with the tab bar, so an unrenamed tab is called what the laptop calls it -
     the third tab ever made in a workspace is "2" if one of the others is
     gone. */
  function tabNumber(row) {
    const label = (row.tab_label || "").trim();
    const digits = label.replace(/^tab /i, "");
    if (digits && /^\d+$/.test(digits)) return digits;
    return String(row.tab_number || "");
  }

  /* The order a finger gave the projects.

     Held here so the list is right before the next poll rather than after it,
     and pushed back to Herdr with workspace.move so the laptop follows the
     phone instead of arguing with it. A project this order has never seen -
     made since the last drag - falls back to when it was created, which is
     the end of the list. */
  const ORDER_KEY = "sheepit.order";

  function loadOrder() {
    try {
      const raw = JSON.parse(readPref("order") || "[]");
      return Array.isArray(raw) ? raw.filter((key) => typeof key === "string") : [];
    } catch (err) {
      return [];
    }
  }

  function saveOrder() {
    const serialized = JSON.stringify(state.customOrder);
    savePref(ORDER_KEY, serialized);
    fetch("/api/project-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: state.customOrder }),
    }).catch(() => {});
  }

  async function loadServerOrder() {
    try {
      const res = await fetch("/api/project-order");
      if (!res.ok) return;
      const data = await res.json();
      if (data.saved) state.customOrder = data.order || [];
      else if (state.customOrder.length) saveOrder(); // one-time migration from this device
      orderAgents();
      renderAgentList();
    } catch (err) {
      // Keep the cached order when the gateway cannot be reached.
    }
  }

  const FOLDERS_KEY = "sheepit.folders";

  function loadFolders() {
    try {
      const raw = JSON.parse(readPref("folders") || "[]");
      return Array.isArray(raw) ? raw.filter(validFolder) : [];
    } catch (err) {
      return [];
    }
  }

  function validFolder(f) {
    return f && typeof f.id === "string" && typeof f.name === "string" &&
      Array.isArray(f.projects);
  }

  function saveFolders() {
    savePref(FOLDERS_KEY, JSON.stringify(state.folders));
    fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders: state.folders }),
    }).catch(() => {});
  }

  async function loadServerFolders() {
    try {
      const res = await fetch("/api/folders");
      if (!res.ok) return;
      const data = await res.json();
      if (data.saved) state.folders = (data.folders || []).filter(validFolder);
      else if (state.folders.length) saveFolders();
      orderAgents();
      renderAgentList();
    } catch (err) {
      // Keep the cached folders when the gateway cannot be reached.
    }
  }

  // A project carried from one slot to another, as a list of keys.
  function reorder(keys, from, to) {
    const next = keys.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }

  /* Herdr inserts a workspace before whatever is at insert_index *counting the
     one being moved*, so a project dropped below where it started lands one
     slot further along than the index it ends up at. Off by one here is a
     project that creeps a place every time it is moved. */
  function insertIndexFor(from, to) {
    return to > from ? to + 1 : to;
  }

  /* A hand-made order wins. Otherwise keep each project's last displayed
     position and append newly discovered projects, even if their workspace
     number is older than projects already on screen. */
  function sortGroups(groups) {
    const rank = new Map(state.customOrder.map((key, i) => [key, i]));
    const seen = new Map(state.groups.map((group, i) => [group.key, i]));
    const at = (map, key) => map.has(key) ? map.get(key) : Number.MAX_SAFE_INTEGER;
    groups.sort((a, b) =>
      at(rank, a.key) - at(rank, b.key) ||
      at(seen, a.key) - at(seen, b.key) ||
      a.born - b.born
    );
  }

  /* ---------------------------------------------------------- Folders ---
   *
   * Nine projects is a list you scroll to the end of to find the one you
   * wanted, and most of them are ones you are not touching this week. A
   * folder is somewhere to put those: a name, and the projects dragged into
   * it, drawn together and folded shut until you want them.
   *
   * The top level is still `customOrder`, with a folder standing in it as
   * `folder:<id>` - so a folder is carried about exactly like a project is -
   * and what is inside a folder is in the folder's own `projects`, in the
   * order they are drawn. A project is in at most one folder; the first one
   * that names it wins. A key whose panes are all closed stays in its folder,
   * so reopening the project next week puts it back where it was filed.
   *
   * The folders are the gateway's, like the order. Which of them are folded
   * shut is this device's: a laptop has room for everything open and a phone
   * does not.
   * ---------------------------------------------------------------------- */
  const FOLDER_PREFIX = "folder:";

  function folderKey(folder) {
    return FOLDER_PREFIX + folder.id;
  }

  function folderOfProject(key) {
    return (state.folders || []).find((f) => f.projects.includes(key)) || null;
  }

  /* The top level as drawn: every project that is in no folder, and every
     folder, placed by `customOrder`. Projects arrive already sorted, and the
     ones the order knows form a prefix of them (sortGroups), so a folder the
     order knows slots in among that prefix by rank and one it does not goes
     at the end. Each folder carries the groups filed in it that are open. */
  function layoutGroups(groups) {
    const folders = state.folders || [];
    const byKey = new Map(groups.map((g) => [g.key, g]));
    const filed = new Map();
    for (const folder of folders) {
      for (const key of folder.projects) if (!filed.has(key)) filed.set(key, folder);
    }
    const rank = new Map(state.customOrder.map((key, i) => [key, i]));
    const at = (key) => (rank.has(key) ? rank.get(key) : Number.MAX_SAFE_INTEGER);
    const items = groups
      .filter((g) => !filed.has(g.key))
      .map((group) => ({ kind: "project", key: group.key, group }));
    const shelved = folders
      .map((folder) => ({
        kind: "folder",
        key: folderKey(folder),
        folder,
        groups: folder.projects
          .filter((key) => filed.get(key) === folder && byKey.has(key))
          .map((key) => byKey.get(key)),
      }))
      .sort((a, b) => at(a.key) - at(b.key));
    for (const item of shelved) {
      const r = at(item.key);
      const i = items.findIndex((other) => at(other.key) > r);
      if (i < 0) items.push(item);
      else items.splice(i, 0, item);
    }
    return items;
  }

  // The projects in the order the layout draws them, folders opened out.
  function layoutProjects(items) {
    return items.flatMap((item) => (item.kind === "folder" ? item.groups : [item.group]));
  }

  /* Where a carried project or folder was put down. `target` is either a slot
     at the top level (`{ index }`, counted without the thing being carried)
     or a place inside a folder (`{ folder: id, index }`). Returns the new
     top-level order and the new folders; the caller saves them. A folder is
     never put in a folder. */
  function dropInto(items, key, target) {
    if (target.folder && key.startsWith(FOLDER_PREFIX)) {
      return { order: items.map((item) => item.key), folders: state.folders || [] };
    }
    const folders = (state.folders || []).map((f) => ({
      ...f,
      projects: f.projects.filter((k) => k !== key),
    }));
    const top = items.map((item) => item.key).filter((k) => k !== key);
    if (target.folder) {
      const folder = folders.find((f) => f.id === target.folder);
      if (folder) {
        /* The index counts what the folder draws, which is only the projects
           that are open; the closed ones filed around them keep their place
           relative to those. */
        const shown = folder.projects.filter((k) => items.some(
          (item) => item.kind === "folder" && item.folder.id === folder.id &&
            item.groups.some((g) => g.key === k)
        ));
        const before = shown[target.index];
        const i = before === undefined ? folder.projects.length : folder.projects.indexOf(before);
        folder.projects.splice(i, 0, key);
        return { order: top, folders };
      }
    }
    const index = Math.max(0, Math.min(top.length, target.index || 0));
    top.splice(index, 0, key);
    return { order: top, folders };
  }

  /* A new folder goes at the top, where it can be seen being made and is
     right there for the first project to be dragged into. */
  function addFolder(name) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const folder = { id, name, projects: [] };
    state.folders = [...(state.folders || []), folder];
    const top = (state.layout || []).map((item) => item.key);
    state.customOrder = [folderKey(folder), ...top.filter((k) => k !== folderKey(folder))];
    return folder;
  }

  /* Taking a folder away files nothing anywhere else: what was in it goes back
     to the top level in the folder's place, in the order it was in. */
  function removeFolder(id) {
    const folder = (state.folders || []).find((f) => f.id === id);
    if (!folder) return;
    const key = folderKey(folder);
    const inside = folder.projects;
    state.folders = state.folders.filter((f) => f !== folder);
    const top = (state.layout || []).map((item) => item.key);
    const at = top.indexOf(key);
    if (at < 0) state.customOrder = [...top, ...inside];
    else state.customOrder = [...top.slice(0, at), ...inside, ...top.slice(at + 1)];
    state.collapsed.delete("f:" + id);
  }

  /* What is folded shut on this device: `f:<folder id>`, `p:<project key>`
     and `w:<workspace id>`. Kept in the device's own storage, because how
     much of the flock fits on a screen is a fact about the screen. */
  const COLLAPSED_KEY = "sheepit.collapsed";

  function loadCollapsed() {
    try {
      const raw = JSON.parse(readPref("collapsed") || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : []);
    } catch (err) {
      return new Set();
    }
  }

  function isCollapsed(key) {
    return Boolean(state.collapsed && state.collapsed.has(key));
  }

  function toggleCollapsed(key) {
    if (!state.collapsed) state.collapsed = new Set();
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    savePref(COLLAPSED_KEY, JSON.stringify([...state.collapsed]));
  }

  /* Never reshuffle a list under a hand: an agent changing state would slide a
     row out from under the thumb about to tap it. This used to hold for as
     long as the picker was open, which was the length of a glance - now that
     the flock is the home screen that would be the length of the session, and
     an agent with a question would never rise to the top again. So it holds
     for the gesture and the few seconds after it instead: a finger on the
     list, a project being carried, a scroll still coming to rest. */
  const LIST_SETTLE_MS = 3000;

  function touchList() {
    state.listTouchedAt = Date.now();
  }

  function listBusy() {
    return Boolean(state.swiping) || Date.now() - (state.listTouchedAt || 0) < LIST_SETTLE_MS;
  }

  function orderAgents() {
    const held = listBusy() && state.order.length;
    if (held) {
      const rank = new Map(state.order.map((id, i) => [id, i]));
      const at = (id) => (rank.has(id) ? rank.get(id) : Number.MAX_SAFE_INTEGER);
      state.agents.sort((a, b) => at(a.pane_id) - at(b.pane_id));
      // A pane that appeared while you were reading joins its own project at
      // the end, rather than being stranded below every group.
      const pens = collapseTabs(groupByProject(state.agents));
      state.layout = layoutGroups(pens);
      state.groups = layoutProjects(state.layout);
      orderChats(true);
      return;
    }

    const groups = groupByProject(state.agents);
    for (const group of groups) {
      group.agents.sort(
        (a, b) => attentionOf(b) - attentionOf(a) || bornAt(a) - bornAt(b)
      );
      // A project is as loud as its loudest sheep: a question ahead of a
      // finished turn, both ahead of a project that wants nothing.
      group.wants = Math.max(0, ...group.agents.map(attentionOf));
      group.born = Math.min(...group.agents.map(bornAt));
    }
    sortGroups(groups);
    collapseTabs(groups);

    state.layout = layoutGroups(groups);
    state.groups = layoutProjects(state.layout);
    state.agents = state.groups.flatMap((g) => g.agents);
    state.order = state.agents.map((a) => a.pane_id);
    orderChats(false);
  }

  // Opening a project is activity too, even when its agent sat still.
  function touchAgent(paneId) {
    const rec = state.activity[paneId];
    state.activity[paneId] = { seq: rec ? rec.seq : 0, ts: Date.now() };
    saveActivity();
  }

  /* "3m" - the age of the last change we actually watched happen. Deliberately
     blank for a project we have only ever seen sitting still, rather than
     claiming it changed the moment this phone first looked. */
  function agoLabel(paneId) {
    const rec = state.activity[paneId];
    if (!rec || rec.seeded) return "";
    return agoText(Date.now() - rec.ts);
  }

  function agoText(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 45) return "now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  function savePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      /* ignore */
    }
  }

  // Event Listeners
  elAgentSelect.addEventListener("click", () => {
    if (!wide.matches && state.chatVisible) {
      document.dispatchEvent(new CustomEvent("sheepit:chat-dismiss"));
      return;
    }
    // The console is the one full-view that leaves this header showing, since
    // it sits below --app-header-height rather than covering it - so this is
    // its only way back, and skipping the close left it fixed on top of the
    // flock this button just opened underneath it.
    if (!wide.matches && !elConsoleView.classList.contains("hidden")) closeConsole();
    openPicker();
  });
  elBtnClosePicker.addEventListener("click", closePicker);

  /* The strip: a tap switches tabs, and the two things a chip can do to itself
     are the x it draws and a hold. Rename is a hold rather than a button
     because a chip is the width of its own name and a second glyph on it would
     be most of the chip - and it is the same gesture the rows answer to. */
  const CHIP_HOLD_MS = 500;
  let chipTimer = null;
  let chipHeld = false;

  function cancelChipHold() {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = null;
  }

  elTabStrip.addEventListener("click", (e) => {
    const shut = e.target.closest("[data-tab-close]");
    if (shut) {
      closeTab(shut.dataset.tabClose);
      return;
    }
    const add = e.target.closest("[data-tab-new]");
    if (add) {
      openNewInWorkspace(add.dataset.tabNew);
      return;
    }
    const chip = e.target.closest(".tab-chip");
    if (!chip) return;
    // The hold already did something with this chip; the lift is not a tap.
    if (chipHeld) {
      chipHeld = false;
      return;
    }
    selectAgent(chip.dataset.paneId);
  });

  elTabStrip.addEventListener("touchstart", (e) => {
    const chip = e.target.closest(".tab-chip");
    chipHeld = false;
    cancelChipHold();
    if (!chip || e.target.closest("[data-tab-close]")) return;
    chipTimer = setTimeout(() => {
      chipHeld = true;
      triggerHaptic();
      renameTabByPane(chip.dataset.paneId);
    }, CHIP_HOLD_MS);
  }, { passive: true });

  ["touchmove", "touchend", "touchcancel"].forEach((name) =>
    elTabStrip.addEventListener(name, cancelChipHold, { passive: true })
  );

  // A mouse has no hold, and the menu it would get instead is no use here.
  elTabStrip.addEventListener("contextmenu", (e) => {
    const chip = e.target.closest(".tab-chip");
    if (!chip) return;
    e.preventDefault();
    renameTabByPane(chip.dataset.paneId);
  });

  elAgentList.addEventListener("click", (e) => {
    const projectAdd = e.target.closest(".agent-group-add");
    if (projectAdd) {
      e.preventDefault();
      e.stopPropagation();
      const project = projectAdd.closest(".agent-group")?.dataset.project ||
        projectAdd.dataset.project;
      openNewInProject(project);
      return;
    }
    const action = e.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "close") closeWorkspace(action.dataset.workspaceId);
      else if (action.dataset.action === "rename") renameRow(action.dataset.workspaceId);
      else if (action.dataset.action === "remove") removeWorktree(action.dataset.workspaceId);
      else if (action.dataset.action === "worktree") openNewInProject(action.dataset.project);
      else if (action.dataset.action === "tab-new") createTab(action.dataset.workspaceId);
      else if (action.dataset.action === "chat-delete") deleteChat(action.dataset.chatId);
      else if (action.dataset.action === "fold") {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        fold(action.dataset.fold);
      }
      else if (action.dataset.action === "folder-rename") renameFolder(action.dataset.folderId);
      else if (action.dataset.action === "folder-delete") deleteFolder(action.dataset.folderId);
      /* A tab of an opened pen, which is the only row whose drawer acts on
         something smaller than the worktree. Closing is the same one the
         strip's x calls, so it asks the same question before it stops an
         agent mid-turn. */
      else if (action.dataset.action === "tab-rename") renameTabByPane(action.dataset.paneId);
      else if (action.dataset.action === "tab-close") {
        resetSwipe();
        closeTab(action.dataset.tabId);
      }
      return;
    }
    const row = e.target.closest(".agent-row");
    if (!row) return;
    // A tap on a swiped-open row puts it back rather than selecting it.
    if (row.classList.contains("swiped")) {
      resetSwipe();
      return;
    }
    /* The finger that just carried this project somewhere is still on it: the
       lift was the gesture, and opening the project was not part of it. The
       flag is cleared by the click it swallows, or by the next touch if
       preventing the drag's default swallowed the click as well. */
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (row.dataset.folderId) fold("f:" + row.dataset.folderId);
    else if (row.dataset.chatId) openChat(row.dataset.chatId);
    else if (row.dataset.paneId && !openAsChat(row.dataset.paneId)) selectAgent(row.dataset.paneId);
  });

  function fold(key) {
    triggerHaptic();
    resetSwipe();
    toggleCollapsed(key);
    renderAgentList();
  }

  /* Folders are this app's own, not Herdr's, so these ask nothing of the
     laptop: the gateway keeps them and the next poll draws them. */
  function newFolder() {
    const name = prompt("New folder", "");
    if (name === null || !name.trim()) return;
    triggerHaptic();
    addFolder(name.trim().slice(0, 200));
    saveFolders();
    saveOrder();
    orderAgents();
    renderAgentList();
  }

  function renameFolder(id) {
    const folder = state.folders.find((f) => f.id === id);
    resetSwipe();
    if (!folder) return;
    const name = prompt("Rename folder", folder.name);
    if (name === null || !name.trim() || name.trim() === folder.name) return;
    triggerHaptic();
    folder.name = name.trim().slice(0, 200);
    saveFolders();
    renderAgentList();
  }

  // Only the folder goes: its projects are put back where it stood.
  function deleteFolder(id) {
    resetSwipe();
    triggerHaptic();
    removeFolder(id);
    saveFolders();
    saveOrder();
    orderAgents();
    renderAgentList();
  }

  /* A headless chat has no pane behind it, so there is nothing to select and
     nothing to show a transcript of: on a phone it is the chat page, and past
     900px it is the same page in the frame that a pane's chat uses, with the
     tab strip gone because there are no tabs to switch between. */
  function openChat(chatId) {
    if (!chatId) return;
    triggerHaptic();
    switchDraft(() => { state.activeChatId = chatId; });
    state.chatVisible = true;
    // Neither the console nor the diff has a pane to read here.
    closePaneViews();
    renderAgentBar();
    if (!wide.matches) closePicker();
  }

  /* The only thing the drawer on a chat row offers. It used to be two taps on
     a list that no longer exists, and it is still the only way a chat goes
     away, so it asks once - a chat is a session log, and nothing brings one
     back. */
  async function deleteChat(chatId) {
    const chat = state.chats.find((c) => c.id === chatId);
    const name = (chat && chat.title) || "this chat";
    if (!confirm(`Delete ${name}? The conversation is gone for good.`)) {
      resetSwipe();
      return;
    }
    triggerHaptic("warning");
    try {
      const res = await fetch("/api/chat/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: chatId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "refused");
      clearDraft("chat:" + chatId);
      if (state.activeChatId === chatId) state.activeChatId = null;
      resetSwipe();
      await fetchAgents();
      renderAgentList();
    } catch (err) {
      alert("Could not delete chat: " + err.message);
    }
  }

  /* A pane's chat and transcript share this page and its header. On a phone
     chat covers the transcript; on a wide screen the pane view is remembered
     alongside the flock. */
  function setPaneView(view) {
    // Desktop has no Normal pane view. Keep stale callers and old controls
    // from ever restoring the transcript there.
    if (wide.matches && view === "transcript") view = "chat";
    state.paneView = view;
    state.chatVisible = view === "chat";
    savePref("sheepit.view", view);
    renderAgentBar();
  }

  /* The pane chat lives in this document. The same event stream drives the
     wide right column and the phone's full screen. */
  function renderChatSurface(target) {
    const show = !!target && (state.activeChatId
      || (wide.matches ? state.paneView === "chat" : state.chatVisible));
    const targetId = show ? (state.activeChatId || target) : "";
    elChatView.classList.toggle("hidden", !show);
    // The pane chat owns its queue strip; the dock queue belongs to transcript view.
    renderChatQueue();
    // The transcript used to sit behind a chat that was `position: fixed`
    // over the whole screen, so leaving it in the document did nothing. Now
    // both are flex items in the same flow, and an unhidden transcript is a
    // sibling above the chat - one long scroll up from the top of a chat and
    // you are reading the pane's raw output instead.
    elHistoryContainer.classList.toggle("hidden", show);
    elPromptForm.classList.toggle("chat-mode", show);
    elPromptInput.placeholder = show ? "Message agent…" : "Prompt or tap mic…";
    // The composer is initially measured while its app pane may still be
    // display:none behind the flock. Measure again after the mobile view has
    // been laid out so its first appearance has the right height.
    requestAnimationFrame(autoResizeTextarea);
    if (targetId !== chatTarget) {
      chatTarget = targetId;
      document.dispatchEvent(new CustomEvent("sheepit:chat-target", { detail: targetId }));
    }
  }

  elViewSwitcher.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view]")?.dataset.view;
    if (!view) return;
    // Guard this at the action boundary as well as hiding the desktop control.
    if (wide.matches && view === "normal") {
      setPaneView("chat");
      return;
    }
    if (view === "console") {
      if (!elConsoleView.classList.contains("hidden")) return;
      // On a phone the console has the whole screen; on desktop the flock
      // remains active alongside it.
      if (!wide.matches) stopPolling();
      openConsole();
      return;
    }
    if (!elConsoleView.classList.contains("hidden")) closeConsole();
    setPaneView(view === "chat" ? "chat" : "transcript");
  });
  document.addEventListener("sheepit:chat-open", (event) => {
    const chat = event.detail;
    if (chat && chat.kind === "pane") {
      switchDraft(() => {
        state.activeChatId = null;
        state.activePaneId = chat.pane_id || state.activePaneId;
      });
      closePicker();
      setPaneView("chat");
    } else if (chat) {
      switchDraft(() => { state.activeChatId = chat.id; });
      state.chatVisible = true;
      closePicker();
      renderAgentBar();
    }
  });
  // The chat half of this file queues its own prompts; they get the same grace.
  document.addEventListener("sheepit:queued", (event) => holdBack(event.detail));
  document.addEventListener("sheepit:chat-close", () => {
    const headless = !!state.activeChatId;
    switchDraft(() => { state.activeChatId = null; });
    state.chatVisible = false;
    if (!headless) state.paneView = wide.matches ? "chat" : "transcript";
    elChatView.classList.add("hidden");
    elPromptForm.classList.remove("chat-mode");
    chatTarget = "";
    renderAgentBar();
    if (!headless && wide.matches && state.activePaneId) openConsole();
    if (headless) fetchAgents();
    // This event always means "back to the flock" - a pane's chat included,
    // or the Claude Code transcript it falls back to (a view its own button
    // is hidden for) shows behind it instead of the project list.
    if (!wide.matches) openPicker();
  });
  wide.addEventListener("change", () => {
    renderAgentBar();
    if (wide.matches && state.activePaneId && state.paneView !== "chat"
        && elConsoleView.classList.contains("hidden")) openConsole();
  });

  function openAsChat(paneId) {
    const agent = state.agents.find((a) => a.pane_id === paneId);
    if (!paneHasChat(agent)) return false;
    selectAgent(paneId, false);
    if (!wide.matches) closePicker();
    setPaneView("chat");
    return true;
  }

  /* Two gestures share these rows, and which one it is only becomes clear
     after the finger has been down a moment.

     Sideways is a swipe, revealing what the row can do: Rename and Close.
     Still is a lift: hold a row for a moment and its whole project comes up
     off the list to be carried somewhere else. Either one rules the other
     out, so the first few pixels of movement decide, and a project picked up
     is a project no longer being swiped. */
  const SWIPE_WIDTH = 92;
  const SWIPE_SLOP = 8;
  const LIFT_MS = 420;
  const LIFT_SLOP = 10;
  // How close to an end of the list a carried project starts scrolling it, and
  // how fast: a nine-project list is taller than a phone.
  const DRAG_EDGE = 56;
  const DRAG_SPEED = 9;

  let swipe = null;
  let drag = null;
  let liftTimer = null;
  let suppressClick = false;

  function cancelLift() {
    if (liftTimer) clearTimeout(liftTimer);
    liftTimer = null;
  }

  function resetSwipe() {
    elAgentList.querySelectorAll(".agent-row.swiped").forEach((r) => {
      r.classList.remove("swiped");
      r.style.transform = "";
    });
  }

  // Hold a row aside so its actions show, which is where the swipe ends.

  function openRowActions(row) {
    const actions = row.parentElement.querySelector(".agent-row-actions");
    const width = (actions && actions.offsetWidth) || SWIPE_WIDTH;
    row.style.transition = "";
    row.classList.add("swiped");
    row.style.transform = `translateX(${-width}px)`;
  }

  /* Anywhere else puts it away, including the heading and the list's own gaps.
     A right-click does not open one any more: the drawer was lent to a mouse
     back when Rename and Close were only reachable by dragging a row aside,
     and the icons in the corner are that, without taking the browser's own
     menu away from the row. */
  document.addEventListener("pointerdown", (e) => {
    if (!elAgentList.querySelector(".agent-row.swiped")) return;
    if (e.target.closest(".agent-row-wrap")) return;
    resetSwipe();
  });

  // And the key a keyboard reaches for to back out of anything: a row's
  // drawer first, then the flock itself - but only into a chat that exists.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (elAgentList.querySelector(".agent-row.swiped")) {
      resetSwipe();
      return;
    }
    if (state.pickerOpen && canLeaveFlock()) closePicker();
  });

  /* A window dragged past the breakpoint: the flock stops being a sheet and
     becomes the column on the left, or the other way about. */
  wide.addEventListener("change", () => {
    if (wide.matches) {
      state.pickerOpen = true; // the column is there whether it was open or not
      renderQuota();
      fetchQuota();
      renderAgentList();
    } else {
      state.pickerOpen = !elAgentPicker.classList.contains("hidden");
    }
    syncPickerChrome();
    syncThemeColor();
  });

  // A hand on the list, by any of the ways it can be on one: while it is, the
  // order is held exactly where it was last drawn.
  elAgentList.addEventListener("scroll", touchList, { passive: true });
  // The list only has a scroll event of its own while it is a column. On a
  // phone the document is what moved, so that is where the hand is heard.
  window.addEventListener("scroll", touchList, { passive: true });
  elAgentList.addEventListener("pointerdown", touchList, { passive: true });
  elAgentList.addEventListener("pointermove", touchList, { passive: true });
  elAgentList.addEventListener("wheel", touchList, { passive: true });

  // Touch dragging uses the long press below. A mouse has no long press, so
  // start carrying a project once its heading or row moves a few pixels.
  let pointerDrag = null;
  elAgentList.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    suppressClick = false;
    if (!canCarry()) return;
    // Not from a folder's own contents that are no project, like its hint.
    if (!e.target.closest(".agent-group, .folder-head-wrap")) return;
    if (e.target.closest(".agent-row-actions")) return;
    pointerDrag = { row: e.target, x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointermove", (e) => {
    if (!pointerDrag) return;
    if (!drag && Math.hypot(e.clientX - pointerDrag.x, e.clientY - pointerDrag.y) < 5) return;
    if (!drag) {
      startDrag(pointerDrag.row, pointerDrag.y);
      state.swiping = true;
    }
    e.preventDefault();
    dragTo(e.clientY);
  }, { passive: false });
  window.addEventListener("pointerup", () => {
    if (!pointerDrag) return;
    pointerDrag = null;
    if (drag) endDrag();
  });
  window.addEventListener("pointercancel", () => {
    pointerDrag = null;
    if (drag) endDrag();
  });

  elAgentList.addEventListener("touchstart", (e) => {
    touchList();
    const row = e.target.closest(".agent-row");
    // A project's heading lifts it too, which is the only handle a folded
    // project has left - but it has no drawer behind it to swipe open.
    const head = !row && e.target.closest(".agent-group-head");
    if (!row && !head) return;
    suppressClick = false;
    if (!row || !row.classList.contains("swiped")) resetSwipe();
    const touch = e.touches[0];
    const actions = row && row.parentElement.querySelector(".agent-row-actions");
    swipe = {
      row,
      width: (actions && actions.offsetWidth) || SWIPE_WIDTH,
      x: touch.clientX,
      y: touch.clientY,
      dx: 0,
      axis: null,
    };
    state.swiping = true; // hold the redraw until the finger is off the row
    // The project is what gets carried, whichever of its rows the finger is
    // on - and there is nothing to reorder in a list of one.
    if (canCarry()) {
      const held = row || head;
      cancelLift();
      liftTimer = setTimeout(() => startDrag(held, touch.clientY), LIFT_MS);
    }
  }, { passive: true });

  /* Not passive, because a project being carried has to hold the list still
     underneath it - which is a preventDefault, which a passive listener is not
     allowed to make. */
  elAgentList.addEventListener("touchmove", (e) => {
    touchList();
    const touch = e.touches[0];
    if (drag) {
      e.preventDefault();
      dragTo(touch.clientY);
      return;
    }
    if (!swipe) return;
    const dx = touch.clientX - swipe.x;
    const dy = touch.clientY - swipe.y;
    if (Math.abs(dx) > LIFT_SLOP || Math.abs(dy) > LIFT_SLOP) cancelLift();
    if (!swipe.row) return; // a heading: held or scrolled, never swiped
    if (swipe.axis === null) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (swipe.axis !== "x") return; // let the list scroll
    /* Nothing behind the row to reveal on a machine with a pointer: the drawer
       is off there (`style.css`), and a hybrid laptop is a finger on a row that
       has the icons. */
    if (mouse.matches) return;
    const base = swipe.row.classList.contains("swiped") ? -swipe.width : 0;
    swipe.dx = Math.max(-swipe.width, Math.min(0, base + dx));
    swipe.row.style.transition = "none";
    swipe.row.style.transform = `translateX(${swipe.dx}px)`;
  }, { passive: false });

  elAgentList.addEventListener("touchend", () => {
    cancelLift();
    if (drag) {
      endDrag();
      return;
    }
    state.swiping = false;
    if (!swipe) return;
    const { row, dx, axis, width } = swipe;
    swipe = null;
    if (axis !== "x") return;
    row.style.transition = "";
    if (dx < -width / 2) {
      openRowActions(row);
      triggerHaptic();
    } else {
      row.classList.remove("swiped");
      row.style.transform = "";
    }
  }, { passive: true });

  // A call or a notification cancels the touch: do not hold the redraw for
  // good, and put down whatever was being carried where it now is.
  elAgentList.addEventListener("touchcancel", () => {
    cancelLift();
    if (drag) {
      endDrag();
      return;
    }
    state.swiping = false;
    swipe = null;
  }, { passive: true });

  // Something to carry and somewhere else to put it: two things at the top,
  // or two projects anywhere, or one project and a folder to file it in.
  function canCarry() {
    if (state.flockTab === "chats") return false;
    return (state.layout || []).length > 1 || state.groups.length > 1;
  }

  /* Whichever of the two is actually scrolling: on a phone the flock is the
     document, past 900px it is a column with its own overflow. */
  function listScroller() {
    return wide.matches ? elAgentList : document.scrollingElement;
  }

  /* A finger's height in the list's own coordinates, which is what every
     position below is measured in. The list's box has to be read now rather
     than remembered: when the document is the scroller the list itself slides
     up under the finger, and a top captured when the drag began is wrong by
     however far the page has gone since. In the other case the box stands
     still and scrollTop moves instead - reading both covers the two, since
     whichever is not scrolling contributes nothing. */
  function pointInList(y) {
    return y - elAgentList.getBoundingClientRect().top + elAgentList.scrollTop;
  }

  /* Carrying a project, or a folder.

     Every position is measured once, when it comes up, and in the list's own
     coordinates rather than the screen's - so the arithmetic still holds when
     the list scrolls itself at the edges. Nothing moves while the finger is
     down but the thing being carried: where it would land is a line between
     two others, or a folder lit up to take it, and the list is only rebuilt
     once it is put down. Sliding the rest out of the way worked while the
     list was one level deep; with folders there is no one row to slide past. */
  function startDrag(el, y) {
    const unit = el.closest(".agent-group, .folder");
    if (!unit) return;
    swipe = null; // this finger is lifting, not swiping
    resetSwipe();
    suppressClick = true;

    const listTop = elAgentList.getBoundingClientRect().top;
    const scroll = elAgentList.scrollTop;
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return { top: r.top - listTop + scroll, bottom: r.bottom - listTop + scroll };
    };
    const isFolder = unit.classList.contains("folder");
    const blocks = Array.from(elAgentList.children)
      .filter((node) => node !== unit && node.matches(".agent-group, .folder"))
      .map((node) => {
        const block = { node, ...box(node), folder: null };
        if (node.classList.contains("folder")) {
          const head = node.querySelector(".folder-head-wrap");
          block.folder = {
            id: node.dataset.folder,
            head: head ? box(head) : { top: block.top, bottom: block.top },
            open: !node.classList.contains("folded"),
            children: Array.from(node.querySelectorAll(".folder-body > .agent-group"))
              .filter((child) => child !== unit)
              .map(box),
          };
        }
        return block;
      });
    const origin = box(unit).top;

    drag = {
      unit,
      key: isFolder ? FOLDER_PREFIX + unit.dataset.folder : unit.dataset.project,
      isFolder,
      blocks,
      origin,
      grab: pointInList(y) - origin,
      target: null,
      line: document.createElement("div"),
      y,
    };
    drag.line.className = "drop-line hidden";
    elAgentList.appendChild(drag.line);
    unit.classList.add("dragging");
    elAgentList.classList.add("dragging");
    triggerHaptic("warning");
    dragTo(y);
    requestAnimationFrame(edgeScroll);
  }

  /* Where the finger is pointing, as a place `dropInto` understands. Over a
     folder is into it - at the top when it is folded or the finger is on its
     name, between two of its projects when it is open - except for the top of
     its name and the very bottom of it, which are the way past it. A folder
     being carried only ever goes between things. */
  function dropTarget(p) {
    if (!drag.isFolder) {
      for (const block of drag.blocks) {
        const folder = block.folder;
        if (!folder) continue;
        const head = folder.head;
        const edge = head.top + (head.bottom - head.top) * 0.3;
        if (p < edge || p > block.bottom - 6) continue;
        const kids = folder.children;
        if (!folder.open || p <= head.bottom || !kids.length) {
          return { folder: folder.id, index: 0, node: block.node, line: null };
        }
        let index = 0;
        for (const kid of kids) if (p > (kid.top + kid.bottom) / 2) index++;
        const line = index < kids.length ? kids[index].top - 4 : kids[kids.length - 1].bottom + 2;
        return { folder: folder.id, index, node: block.node, line };
      }
    }
    const blocks = drag.blocks;
    let index = 0;
    for (const block of blocks) if (p > (block.top + block.bottom) / 2) index++;
    const line = !blocks.length
      ? drag.origin
      : index < blocks.length
        ? blocks[index].top - 7
        : blocks[blocks.length - 1].bottom + 7;
    return { index, node: null, line };
  }

  function dragTo(y) {
    drag.y = y;
    const top = pointInList(y) - drag.grab;
    drag.unit.style.transform = `translateY(${top - drag.origin}px)`;

    const target = dropTarget(pointInList(y));
    const before = drag.target;
    drag.target = target;
    if (target.line === null) drag.line.classList.add("hidden");
    else {
      drag.line.classList.remove("hidden");
      drag.line.style.top = `${target.line}px`;
    }
    if (before && before.node && before.node !== target.node) {
      before.node.classList.remove("drop-into");
    }
    if (target.node) target.node.classList.add("drop-into");
    if (!before || before.folder !== target.folder || before.index !== target.index) {
      triggerHaptic();
    }
  }

  function edgeScroll() {
    if (!drag) return;
    /* The edges to carry a project past are the ones you can see. Past 900px
       that is the column's own box; on a phone the list runs off both ends of
       the screen, so the screen is what its edges are. */
    const vv = window.visualViewport;
    const box = wide.matches
      ? elAgentList.getBoundingClientRect()
      : { top: 0, bottom: vv ? vv.height : window.innerHeight };
    let by = 0;
    if (drag.y < box.top + DRAG_EDGE) by = -DRAG_SPEED;
    else if (drag.y > box.bottom - DRAG_EDGE) by = DRAG_SPEED;
    if (by) {
      const scroller = listScroller();
      const before = scroller.scrollTop;
      scroller.scrollTop += by;
      if (scroller.scrollTop !== before) dragTo(drag.y);
    }
    requestAnimationFrame(edgeScroll);
  }

  function endDrag() {
    const { unit, key, isFolder, target, line } = drag;
    unit.style.transform = "";
    unit.classList.remove("dragging");
    elAgentList.classList.remove("dragging");
    elAgentList.querySelectorAll(".drop-into").forEach((n) => n.classList.remove("drop-into"));
    line.remove();
    drag = null;
    state.swiping = false;
    if (!target) return;

    const items = state.layout || [];
    const before = layoutProjects(items).map((g) => g.key);
    const next = dropInto(items, key, target);
    const same =
      JSON.stringify(next.order) === JSON.stringify(items.map((item) => item.key)) &&
      JSON.stringify(next.folders) === JSON.stringify(state.folders || []);
    if (same) return;
    state.customOrder = next.order;
    state.folders = next.folders;
    saveOrder();
    saveFolders();
    triggerHaptic();
    /* The held order exists to stop the list shuffling itself while somebody
       reads it; this is somebody rearranging it on purpose, so let go of it
       and sort afresh. */
    state.order = [];
    orderAgents();
    renderAgentList();
    if (!isFolder) moveProject(key, before, layoutProjects(state.layout).map((g) => g.key));
  }

  /* Tell the laptop, when there is something unambiguous to tell it. A project
     is a repository and Herdr reorders workspaces, so the two only line up
     while the project holds a single workspace - which is every project that
     has not been cut into worktrees. The rest keep their order on this phone
     alone, because moving one of several workspaces would leave Herdr's strip
     saying something nobody asked for. */
  function moveProject(key, before, after) {
    const ids = [
      ...new Set(
        state.agents.filter((a) => projectKey(a) === key).map((a) => a.workspace_id)
      ),
    ];
    if (ids.length !== 1) return;
    const from = workspaceOrder(before).indexOf(ids[0]);
    const to = workspaceOrder(after).indexOf(ids[0]);
    if (from < 0 || to < 0 || from === to) return;
    moveWorkspace(ids[0], insertIndexFor(from, to));
  }

  // The workspaces behind a list of projects, in that list's order: what
  // Herdr's own strip would look like if it agreed with the phone.
  function workspaceOrder(keys) {
    const ids = [];
    for (const key of keys) {
      for (const agent of state.agents) {
        if (projectKey(agent) !== key) continue;
        if (!ids.includes(agent.workspace_id)) ids.push(agent.workspace_id);
      }
    }
    return ids;
  }

  /* Failing here is survivable: the phone keeps the order the finger gave it,
     and only the laptop is left disagreeing. */
  async function moveWorkspace(workspaceId, insertIndex) {
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insert_index: insertIndex }),
      });
      if (!res.ok) throw new Error("move refused");
    } catch (err) {
      console.warn("moveWorkspace:", err);
    }
  }

  elBtnNewWorkspace.addEventListener("click", openNewAnything);
  elFlockTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-flock-tab]");
    if (!btn) return;
    triggerHaptic();
    setFlockTab(btn.dataset.flockTab);
  });
  elBtnCloseNewSheet.addEventListener("click", closeNewSheet);


  function closeComposerMenu() {
    elComposerMenuPanel.classList.add("hidden");
    elBtnMore.setAttribute("aria-expanded", "false");
  }
  elBtnMore.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = elComposerMenuPanel.classList.contains("hidden");
    elComposerMenuPanel.classList.toggle("hidden", !open);
    elBtnMore.setAttribute("aria-expanded", String(open));
  });
  elComposerMenuPanel.addEventListener("click", (e) => {
    if (e.target.closest("button")) closeComposerMenu();
  });
  document.addEventListener("click", (e) => {
    if (!elComposerMenu.contains(e.target)) closeComposerMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeComposerMenu();
  });

  /* The backdrop dismisses the new-item sheet. */
  elSheetBackdrop.addEventListener("click", () => {
    closeNewSheet();
  });

  elHistoryContainer.addEventListener("scroll", onHistoryScroll, { passive: true });
  window.addEventListener("scroll", onHistoryScroll, { passive: true });
  elBtnScrollBottom.addEventListener("click", () => scrollToBottom(true));

  elPromptInput.addEventListener("input", () => {
    autoResizeTextarea();
    rememberDraft();
    if (state.chatVisible || state.activeChatId) return;
    scheduleCompletion();
    elBtnSend.disabled = !elPromptInput.value.trim() && !attachStrip.list.length;
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
    syncPinned();
    elPromptInput.classList.add("expanded");
    autoResizeTextarea();
    if (state.chatVisible || state.activeChatId) return;
    setTimeout(() => {
      syncViewportHeight();
      scrollToBottom();
    }, 150);
  });

  elPromptInput.addEventListener("blur", () => {
    syncViewportHeight();
    elPromptInput.classList.remove("expanded");
    autoResizeTextarea();
  });

  elBtnRecall.addEventListener("click", recallPrev);
  SheepItComposer.bindSubmit(elPromptForm, submitPrompt);

  /* ^C arms itself before it fires, rather than asking through confirm():
     iOS stops showing confirm() in a home screen web app after the user has
     dismissed a few, and a suppressed dialog returns false - so the button
     quietly sent nothing at all. Arming keeps the same protection against a
     stray tap and stays live afterwards, because leaving an agent takes two
     interrupts in a row and a modal between them misses the agent's window. */
  const CTRL_C_ARM_MS = 4000;
  let ctrlCArmTimer = null;

  function setCtrlCArmed(armed) {
    if (ctrlCArmTimer) clearTimeout(ctrlCArmTimer);
    ctrlCArmTimer = null;
    elBtnCtrlC.classList.toggle("armed", armed);
    elBtnCtrlC.textContent = armed ? "^C?" : "^C";
    if (armed) {
      ctrlCArmTimer = setTimeout(() => setCtrlCArmed(false), CTRL_C_ARM_MS);
    }
  }

  elBtnCtrlC.addEventListener("click", () => {
    if (!elBtnCtrlC.classList.contains("armed")) {
      triggerHaptic("warning");
      setCtrlCArmed(true);
      return;
    }
    sendKey("ctrl+c", elBtnCtrlC);
    setCtrlCArmed(true); // a second tap exits the agent the first one stopped
  });

  elComposerStop.addEventListener("click", () => {
    if (elPromptForm.classList.contains("chat-mode")) return;
    sendKey("ctrl+c", elComposerStop);
  });

  elBtnEsc.addEventListener("click", () => sendKey("esc", elBtnEsc));

  // Pull the desktop's draft into the composer to carry on editing it here.
  elBtnAdopt.addEventListener("click", () => {
    const draft = elTerminalInput.textContent.trim();
    if (!draft) return;
    triggerHaptic();
    const existing = elPromptInput.value.trim();
    elPromptInput.value = existing ? `${existing} ${draft}` : draft;
    elPromptInput.focus();
    elPromptInput.dispatchEvent(new Event("input"));
  });

  /* Empty the console's own input, so what was left typed at the desk is not
     sent along with the next prompt the queue delivers. Backspaces rather than
     ^C: in a working agent ^C is an interrupt, not an erase. The caret is
     taken to the end first, and a few more than the mirror shows, since the
     mirror trims what the agent draws around a wrapped line. */
  elBtnUnadopt.addEventListener("click", async () => {
    const draft = elTerminalInput.textContent;
    if (!draft || !state.activePaneId) return;
    triggerHaptic("warning");
    elBtnUnadopt.disabled = true;
    const erase = Array(Math.min(draft.length + 16, 4000)).fill("backspace");
    const post = (keys) => fetch(`/api/agents/${encodeURIComponent(state.activePaneId)}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    try {
      let res = await post(["end", ...erase]);
      // A Herdr that does not know "end" refuses the whole list.
      if (!res.ok) res = await post(erase);
      if (!res.ok) throw new Error("refused");
      renderLiveInput("");
      setTimeout(() => fetchHistory(true), 300);
    } catch (err) {
      alert("Could not clear the console's input");
    } finally {
      elBtnUnadopt.disabled = false;
    }
  });
  elBtnCopy.addEventListener("click", copyHistory);

  /* One vocabulary for both key rows. #keys-bar sends a name to Herdr over
     agent.send_keys (sendKey, below) and asks nothing more of this table; the
     console has no RPC, only a pty, so #console-keys looks up the bytes a
     real terminal would send for the same name (sendConsoleKey, near
     sendConsole). Keeping both readings of "esc" or "ctrl+c" in one place
     means the name never means two different things in two places. */
  const KEY_VOCAB = {
    esc: { bytes: "" },
    tab: { bytes: "\t" },
    "ctrl+c": { bytes: "" },
    enter: { bytes: "\r" },
    up: { bytes: "[A" },
    down: { bytes: "[B" },
    left: { bytes: "[D" },
    right: { bytes: "[C" },
  };

  // Key palette: the single keypresses agents ask for at confirmation prompts.
  function setKeysBar(show) {
    state.showKeys = show;
    elKeysBar.classList.toggle("hidden", !show);
    elBtnKeys.classList.toggle("active", show);
    elBtnKeys.setAttribute("aria-pressed", String(show));
    savePref("sheepit.keys", show ? "1" : "0");
  }

  elBtnKeys.addEventListener("click", () => {
    triggerHaptic();
    setKeysBar(!state.showKeys);
  });

  elKeysBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".key-btn");
    if (btn && btn.dataset.key) sendKey(btn.dataset.key, btn);
  });

  // shift+tab cycles the agent between auto, manual and plan mode.
  elBtnCycleMode.addEventListener("click", async () => {
    await sendKey("shift+tab");
    setTimeout(() => fetchHistory(true), 400);
  });

  elToggleBleat.addEventListener("change", (e) => {
    state.bleat = e.target.checked;
    savePref("sheepit.bleat", state.bleat ? "1" : "0");
    if (state.bleat) unlockAudio().then(playBleat); // so you hear what you enabled
  });

  /* The strip appears with the next poll rather than this tap: what it draws
     are rates, and a first reading has no previous pass to measure against, so
     the reading asked for here is the one the poll after it can put numbers
     on. Turning it off blanks it at once. */
  elToggleMachine.addEventListener("change", (e) => {
    state.machineStrip = e.target.checked;
    savePref("sheepit.machine", state.machineStrip ? "1" : "0");
    if (state.machineStrip) state.quotaAt = 0; // ask again, with the machine in it
    else renderQuota();
    fetchQuota();
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
    // Safari ignores `interactive-widget`: its keyboard covers the layout
    // viewport rather than shrinking it, and only the visual one says so.
    keyboardCovered = window.innerHeight - vv.height * vv.scale > 150;
    syncPinned();
  }
  let keyboardCovered = false;

  /* While the keyboard is up or the console is open, a phone's chat leaves
     the document and becomes a fixed box the size of what is visible
     (`.pinned` in style.css), riding the visual viewport the way the
     `.full-view`s do. In the flow, the sticky header and composer sat in a
     layout viewport the keyboard was covering, so Safari slid the whole page
     about to find the caret - the composer climbing out of sight, the page
     draggable sideways, and above the console the header slid off the top,
     sometimes for good once the keyboard was gone. The transcript scrolls
     inside the box meanwhile, so how far from its end you were is carried
     across the swap by hand. */
  function syncPinned() {
    const root = document.documentElement;
    const on = !wide.matches && (keyboardCovered
      || document.activeElement === elPromptInput
      || !elConsoleView.classList.contains("hidden"));
    if (root.classList.contains("pinned") === on) return;
    const chatView = document.getElementById("chat-chat-view");
    const inner = chatView.classList.contains("hidden")
      ? elHistoryContainer
      : document.getElementById("chat-messages");
    const outer = document.scrollingElement;
    const from = on ? outer : inner;
    const fromEnd = from.scrollHeight - from.scrollTop - from.clientHeight;
    root.classList.toggle("pinned", on);
    const to = on ? inner : outer;
    to.scrollTop = to.scrollHeight - to.clientHeight - fromEnd;
    boxHeight.set(to, to.clientHeight);
  }

  /* The box then shrinks under the transcript twice more - the keyboard
     finishing its slide, the composer growing a line - so one that was at its
     end at its old height is kept there, as the document's own scroll would
     have been. The scroll event would say so a frame too late. */
  const boxHeight = new WeakMap();
  if (window.ResizeObserver) {
    const keepAtEnd = new ResizeObserver((entries) => {
      for (const { target: el } of entries) {
        const before = boxHeight.get(el);
        boxHeight.set(el, el.clientHeight);
        if (!document.documentElement.classList.contains("pinned") || before == null) continue;
        if (el.scrollHeight - el.scrollTop - before < 4) el.scrollTop = el.scrollHeight;
      }
    });
    keepAtEnd.observe(elHistoryContainer);
    keepAtEnd.observe(document.getElementById("chat-messages"));
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
    window.visualViewport.addEventListener("scroll", syncViewportHeight);
    syncViewportHeight();
  }

  /* The picker head's height, which the project headings stick below. It is
     re-read rather than worked out because it is the status bar inset plus a
     button, and both of those change with the device and with rotation. */
  if (elPickerHead && window.ResizeObserver) {
    new ResizeObserver(measurePickerHead).observe(elPickerHead);
  }
  window.addEventListener("orientationchange", measurePickerHead);
  measurePickerHead();

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
      elBtnTestPush.disabled = !sub;
      setPushHint(sub ? "on for this device" : "");
    } catch (err) {
      elBtnTestPush.disabled = true;
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
    elBtnTestPush.disabled = false;
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
    elBtnTestPush.disabled = true;
    setPushHint("");
  }

  elBtnTestPush.addEventListener("click", async () => {
    elBtnTestPush.disabled = true;
    setPushHint("sending test…");
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "request failed");
      setPushHint(result.sent ? "test sent" : "no active subscription found");
    } catch (err) {
      setPushHint("test failed: " + err.message);
    } finally {
      elBtnTestPush.disabled = !(elTogglePush.checked && Notification.permission === "granted");
    }
  });

  elTogglePush.addEventListener("change", async (e) => {
    try {
      if (e.target.checked) await enablePush();
      else await disablePush();
    } catch (err) {
      elTogglePush.checked = false;
      setPushHint("failed: " + err.message);
    }
  });

  /* Where chats live, in the settings: read from the gateway, since it is the
     gateway's to keep and every phone shares it. Changed through the same
     folder picker the first chat asked with. */
  function renderChatHomeSetting(home) {
    if (!elChatHomePath) return;
    elChatHomePath.textContent = home || "not chosen yet - the first chat asks";
    elChatHomePath.classList.toggle("unset", !home);
  }

  async function refreshChatHomeSetting() {
    try {
      renderChatHomeSetting((await loadChatOptions()).home);
    } catch (err) {
      /* gateway offline */
    }
  }

  if (elBtnChatHome) {
    elBtnChatHome.addEventListener("click", () => {
      openNewSheet("settings", { step: "home" });
      browseDir("");
    });
  }

  async function refreshGlobalSettings() {
    refreshPushState();
    refreshChatHomeSetting();
    if (!elHeartbeatsList) return;
    try {
      const res = await fetch("/api/heartbeat");
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;
      const heartbeats = data.heartbeats || [];
      await renderHeartbeats(heartbeats);
    } catch (err) {
      /* gateway offline */
    }
  }
  function getRootProjects() {
    const rootProjects = [];
    const seen = new Set();
    for (const a of (state.agents || [])) {
      if (a.main_checkout && a.workspace_id && !seen.has(a.project_name || a.project)) {
        const key = a.project_name || a.project;
        seen.add(key);
        rootProjects.push({
          workspace_id: a.workspace_id,
          name: a.project_name || a.name || key,
        });
      }
    }
    if (!rootProjects.length) {
      const groups = groupByProject(state.agents || []);
      for (const g of groups) {
        if (g.from && !seen.has(g.name)) {
          seen.add(g.name);
          rootProjects.push({
            workspace_id: g.from,
            name: g.name,
          });
        }
      }
    }
    return rootProjects;
  }


  // Cached per agent kind for the session: the harness's own model catalog
  // doesn't change mid-session, and re-fetching on every render is wasted work.
  const hbModelsCache = {};
  async function fetchHeartbeatModels(kind) {
    if (hbModelsCache[kind]) return hbModelsCache[kind];
    let models = [{ val: "", label: "Default" }];
    try {
      const res = await fetch(`/api/heartbeat/models?kind=${encodeURIComponent(kind)}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.models)) {
        models = data.models.map((m) => ({ val: m.value, label: m.label }));
      }
    } catch (err) {
      /* gateway offline; card falls back to Default/Custom */
    }
    hbModelsCache[kind] = models;
    return models;
  }

  async function renderHeartbeats(heartbeats) {
    if (!elHeartbeatsList) return;
    if (!heartbeats.length) {
      elHeartbeatsList.innerHTML = '<div class="sheet-hint" style="padding: 12px 0;">No heartbeats configured. Tap "+ Add" above to create one.</div>';
      return;
    }

    const kinds = Array.from(new Set(heartbeats.map((hb) => hb.agent_kind || "claude")));
    const modelsByKind = {};
    await Promise.all(kinds.map(async (kind) => { modelsByKind[kind] = await fetchHeartbeatModels(kind); }));

    elHeartbeatsList.innerHTML = heartbeats
      .map((hb) => {
        const lastTimeText = hb.last_run_at
          ? new Date(hb.last_run_at * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
          : "Never";
        let statusBadge = "";
        if (hb.last_status === "ok") {
          statusBadge = '<span class="heartbeat-status-badge heartbeat-status-ok">OK</span>';
        } else if (hb.last_status === "alert") {
          statusBadge = '<span class="heartbeat-status-badge heartbeat-status-alert">ALERT</span>';
        } else if (hb.last_status === "running") {
          statusBadge = '<span class="heartbeat-status-badge heartbeat-status-running">RUNNING</span>';
        }
        const rootProjects = getRootProjects();
        let hasSelected = false;
        const projectOptions = rootProjects
          .map((p) => {
            const isSel = hb.target_workspace === p.workspace_id;
            if (isSel) hasSelected = true;
            return `<option value="${escapeHtml(p.workspace_id)}" ${isSel ? "selected" : ""}>New agent in ${escapeHtml(p.name)}</option>`;
          })
          .join("");
        let offlineOption = "";
        if (!hasSelected && hb.target_workspace) {
          offlineOption = `<option value="${escapeHtml(hb.target_workspace)}" selected>New agent in ${escapeHtml(hb.target_workspace)} (offline / not found)</option>`;
        }

        // Models come from the harness itself (fetched in renderHeartbeats),
        // not a pinned list here that would go stale the day a model ships.
        const catalog = modelsByKind[hb.agent_kind || "claude"] || [{ val: "", label: "Default" }];
        const isCustomModel = Boolean(hb.model && !catalog.some((m) => m.val === hb.model));

        const modelOptions = catalog
          .map((m) => {
            const isSel = !isCustomModel && hb.model === m.val;
            return `<option value="${escapeHtml(m.val)}" ${isSel ? "selected" : ""}>${escapeHtml(m.label)}</option>`;
          })
          .join("") + `<option value="custom" ${isCustomModel ? "selected" : ""}>Custom…</option>`;

        return `
          <div class="heartbeat-card" data-id="${escapeHtml(hb.id)}">
            <div class="heartbeat-card-head">
              <input type="text" class="heartbeat-name-input" value="${escapeHtml(hb.name)}" placeholder="Check Name">
              <div class="heartbeat-card-controls">
                <input type="checkbox" class="heartbeat-toggle" ${hb.enabled ? "checked" : ""}>
                <button type="button" class="btn-icon-danger heartbeat-delete" title="Delete check">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="heartbeat-card-row">
              <label>Target project</label>
              <select class="heartbeat-target-select">
                <option value="">Select root project…</option>
                ${offlineOption}
                ${projectOptions}
              </select>
            </div>
            <div class="heartbeat-card-row">
              <label for="hb-clear-${escapeHtml(hb.id)}">
                Clear session before run
                <span class="sheet-hint">sends /clear so context never runs full</span>
              </label>
              <input type="checkbox" id="hb-clear-${escapeHtml(hb.id)}" class="heartbeat-clear-toggle" ${hb.clear_session !== false ? "checked" : ""}>
            </div>
            <div class="heartbeat-card-row">
              <label for="hb-autoclose-${escapeHtml(hb.id)}">
                Auto-close tab on success
                <span class="sheet-hint">closes tab when HEARTBEAT_OK; leaves open on alert</span>
              </label>
              <input type="checkbox" id="hb-autoclose-${escapeHtml(hb.id)}" class="heartbeat-autoclose-toggle" ${hb.auto_close !== false ? "checked" : ""}>
            </div>
            <div class="heartbeat-card-row">
              <label>Interval</label>
              <select class="heartbeat-interval-select">
                <option value="1" ${Math.round(hb.interval_hours) === 1 ? "selected" : ""}>Every 1 hour</option>
                <option value="6" ${Math.round(hb.interval_hours) === 6 ? "selected" : ""}>Every 6 hours</option>
                <option value="12" ${Math.round(hb.interval_hours) === 12 ? "selected" : ""}>Every 12 hours</option>
                <option value="24" ${Math.round(hb.interval_hours) === 24 ? "selected" : ""}>Every 24 hours (daily)</option>
              </select>
            </div>
            <div class="heartbeat-card-row">
              <label>Harness</label>
              <select class="heartbeat-harness-select">
                <option value="claude" ${hb.agent_kind === "claude" || !hb.agent_kind ? "selected" : ""}>Claude Code</option>
                <option value="codex" ${hb.agent_kind === "codex" ? "selected" : ""}>Codex</option>
                <option value="omp" ${hb.agent_kind === "omp" ? "selected" : ""}>OMP (Oh My Pi)</option>
              </select>
            </div>
            <div class="heartbeat-card-row">
              <label>Model</label>
              <div style="display: flex; gap: 6px; align-items: center;">
                <select class="heartbeat-model-select">
                  ${modelOptions}
                </select>
                <input type="text" class="heartbeat-custom-model ${isCustomModel ? "" : "hidden"}" value="${escapeHtml(hb.model || "")}" placeholder="Model name" style="width: 120px;">
              </div>
            </div>
            <div class="sheet-row-stacked">
              <label style="font-size: 13px; color: var(--text-secondary);">
                Prompt
                <span class="sheet-hint">sentinel ${escapeHtml(hb.ok_sentinel || "HEARTBEAT_OK")} suppresses push</span>
              </label>
              <textarea class="sheet-textarea heartbeat-prompt-input" rows="3">${escapeHtml(hb.prompt || "")}</textarea>
            </div>
            <div class="heartbeat-card-footer">
              <div class="sheet-agent-text" style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span class="sheet-hint">Last: ${lastTimeText}</span>
                  ${statusBadge}
                </div>
                <span class="sheet-hint" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(hb.last_summary || "")}</span>
              </div>
              <button type="button" class="sheet-btn-small heartbeat-run-btn">Run now</button>
            </div>
          </div>
        `;
      })
      .join("");

    // Attach event listeners for each card
    elHeartbeatsList.querySelectorAll(".heartbeat-card").forEach((card) => {
      const id = card.dataset.id;
      const nameInput = card.querySelector(".heartbeat-name-input");
      const toggleInput = card.querySelector(".heartbeat-toggle");
      const targetSelect = card.querySelector(".heartbeat-target-select");
      const harnessSelect = card.querySelector(".heartbeat-harness-select");
      const modelSelect = card.querySelector(".heartbeat-model-select");
      const customModelInput = card.querySelector(".heartbeat-custom-model");
      const intervalSelect = card.querySelector(".heartbeat-interval-select");
      const promptTextarea = card.querySelector(".heartbeat-prompt-input");
      const autoCloseToggle = card.querySelector(".heartbeat-autoclose-toggle");
      const runBtn = card.querySelector(".heartbeat-run-btn");
      const deleteBtn = card.querySelector(".heartbeat-delete");
      const clearToggle = card.querySelector(".heartbeat-clear-toggle");

      if (targetSelect) {
        targetSelect.addEventListener("change", () => {
          const ws_id = targetSelect.value;
          updateHeartbeat(id, {
            target_type: "new_agent",
            target_workspace: ws_id,
            target_pane: "",
          });
        });
      }
      if (harnessSelect) {
        harnessSelect.addEventListener("change", () => {
          updateHeartbeat(id, { agent_kind: harnessSelect.value, model: "" });
          refreshGlobalSettings();
        });
      }
      if (modelSelect) {
        modelSelect.addEventListener("change", () => {
          if (modelSelect.value === "custom") {
            if (customModelInput) {
              customModelInput.classList.remove("hidden");
              customModelInput.focus();
            }
          } else {
            if (customModelInput) customModelInput.classList.add("hidden");
            updateHeartbeat(id, { model: modelSelect.value });
          }
        });
      }
      if (customModelInput) {
        customModelInput.addEventListener("blur", () => {
          const model = customModelInput.value.trim();
          updateHeartbeat(id, { model });
        });
      }
      if (clearToggle) {
        clearToggle.addEventListener("change", () => {
          updateHeartbeat(id, { clear_session: clearToggle.checked });
        });
      }
      if (autoCloseToggle) {
        autoCloseToggle.addEventListener("change", () => {
          updateHeartbeat(id, { auto_close: autoCloseToggle.checked });
        });
      }
      if (nameInput) {
        nameInput.addEventListener("blur", () => {
          const name = nameInput.value.trim();
          if (name) updateHeartbeat(id, { name });
        });
      }
      if (toggleInput) {
        toggleInput.addEventListener("change", () => {
          updateHeartbeat(id, { enabled: toggleInput.checked });
        });
      }
      if (intervalSelect) {
        intervalSelect.addEventListener("change", () => {
          updateHeartbeat(id, { interval_hours: parseFloat(intervalSelect.value) });
        });
      }
      if (promptTextarea) {
        promptTextarea.addEventListener("blur", () => {
          const prompt = promptTextarea.value.trim();
          if (prompt) updateHeartbeat(id, { prompt });
        });
      }
      if (runBtn) {
        runBtn.addEventListener("click", async () => {
          triggerHaptic();
          runBtn.disabled = true;
          runBtn.textContent = "Running…";
          try {
            await fetch("/api/heartbeat/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id }),
            });
          } catch (err) {
            /* ignore */
          } finally {
            setTimeout(async () => {
              runBtn.disabled = false;
              runBtn.textContent = "Run now";
              await refreshGlobalSettings();
            }, 1000);
          }
        });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener("click", async () => {
          triggerHaptic();
          try {
            await fetch("/api/heartbeat/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id }),
            });
            await refreshGlobalSettings();
          } catch (err) {
            /* ignore */
          }
        });
      }
    });
  }

  async function updateHeartbeat(id, updates) {
    try {
      await fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heartbeat: { id, ...updates } }),
      });
    } catch (err) {
      /* ignore */
    }
  }

  async function addHeartbeat() {
    triggerHaptic();
    const rootProjects = getRootProjects();
    const firstWs = rootProjects.length ? rootProjects[0].workspace_id : "";
    try {
      await fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          heartbeat: {
            name: "New Check",
            enabled: true,
            target_workspace: firstWs,
            clear_session: true,
            auto_close: true,
          },
        }),
      });
      await refreshGlobalSettings();
    } catch (err) {
      /* ignore */
    }
  }

  if (elBtnFlockSettings) elBtnFlockSettings.addEventListener("click", openGlobalSettings);
  if (elBtnCloseGlobalSettings) elBtnCloseGlobalSettings.addEventListener("click", closeGlobalSettings);
  if (elBtnAddHeartbeat) elBtnAddHeartbeat.addEventListener("click", addHeartbeat);

  if (pushSupported()) {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        refreshPushState();
        /* A registered worker is only re-checked on navigation, and a push
           does not count - so a home screen app left open can go on notifying
           you with last week's wording. Ask on every open, and again whenever
           it comes back to the foreground. */
        const check = () => reg.update().catch(() => {});
        check();
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) check();
        });
      })
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


  /* ----------------------------------------------------------------------
     The console

     The transcript above is a verbatim reading of a pane. Sometimes you want
     the pane itself - a full-screen
     editor an agent opened, a curses installer, a prompt the parser has no
     shape for. So: xterm.js here, Herdr's own client socket at the far end of
     a WebSocket, and the pane's bytes flowing both ways with nothing in
     between deciding what they mean.

     Herdr streams the viewport rather than a scrolling log, so scrolling is
     not xterm's to do: a wheel or a drag asks Herdr to move its own scrollback
     and the next frame arrives already scrolled.
     ---------------------------------------------------------------------- */
  /* A monospace cell, as a fraction of the font size. The width is close
     enough to pick a font that fits the pane's columns; the height is only an
     opening guess, because xterm rounds every row up and the roundings add up
     over a tall pane - the real one is measured off the first grid it draws
     and kept in consoleState.cellHeight. */
  const CELL_WIDTH = 0.6;
  const CELL_HEIGHT = 1.35;
  // What a font has to be before it stops being worth reading on a phone.
  const MIN_FONT = 4.5;
  const MAX_FONT = 15;
  const FIT_FONT = 11;
  // Matches the padding .console-term draws with.
  const CONSOLE_PAD_X = 12;
  const CONSOLE_PAD_Y = 12;

  /* Frames held while the screen is being selected from. A cap, because a
     selection left standing on a pane that is still printing would otherwise
     buffer the night: past it the hold gives up and the screen catches up,
     which loses the selection but never loses output. */
  const CONSOLE_HOLD_MAX = 256 * 1024;

  const consoleState = {
    term: null, ws: null, paneId: null, scrollAcc: 0, cols: 80, rows: 24,
    loading: null, cellHeight: CELL_HEIGHT, held: [], heldBytes: 0,
    fitPending: false, fitTarget: null, fitRetryCount: 0,
  };
  const encoder = new TextEncoder();

  function consoleTheme() {
    const css = getComputedStyle(document.documentElement);
    const pick = (name, fallback) =>
      (css.getPropertyValue(name) || "").trim() || fallback;
    return {
      background: pick("--bg-base", "#090a0f"),
      foreground: pick("--text-primary", "#f0f3f8"),
      cursor: pick("--accent-primary", "#2f81f7"),
      selectionBackground: "rgba(47, 129, 247, 0.35)",
    };
  }

  /* Half a megabyte of terminal, fetched the first time the console is opened
     rather than on every load: most of the time the app is a transcript and a
     composer, and the phone should not pay for what it is not showing. */
  function loadTerminalLibrary() {
    if (window.Terminal) return Promise.resolve(true);
    if (!consoleState.loading) {
      consoleState.loading = new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "/vendor/xterm.js";
        script.onload = () => resolve(Boolean(window.Terminal));
        script.onerror = () => {
          consoleState.loading = null;   // a flaky tailnet gets another go
          resolve(false);
        };
        document.head.appendChild(script);
      });
    }
    return consoleState.loading;
  }

  function ensureTerminal() {
    if (consoleState.term) return consoleState.term;
    if (!window.Terminal) return null;
    const term = new window.Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 12,
      lineHeight: 1.15,
      // Herdr repaints the viewport, so a local scrollback would only hold
      // copies of frames that have already been replaced.
      scrollback: 0,
      theme: consoleTheme(),
    });
    consoleState.term = term;
    term.open(elConsoleTerm);
    // Keystrokes as bytes. A terminal has no notion of a key name, and the
    // gateway forwards what arrives without looking at it.
    term.onData((data) => sendConsole(encoder.encode(data)));
    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
      sendConsole(bytes);
    });
    attachConsoleScroll();
    return term;
  }

  function sendConsole(bytes) {
    const ws = consoleState.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(bytes);
    return true;
  }

  async function sendConsoleWhenConnected(paneId, bytes) {
    const deadline = Date.now() + 8000;
    while (!elConsoleView.classList.contains("hidden")
        && state.activePaneId === paneId
        && (consoleState.paneId !== paneId || !consoleState.ws)
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ws = consoleState.ws;
    if (!ws || consoleState.paneId !== paneId) return false;
    if (ws.readyState === WebSocket.CONNECTING) {
      const opened = await new Promise((resolve) => {
        let timer;
        const done = (ok) => {
          clearTimeout(timer);
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("close", onClose);
          resolve(ok);
        };
        const onOpen = () => done(true);
        const onClose = () => done(false);
        ws.addEventListener("open", onOpen, { once: true });
        ws.addEventListener("close", onClose, { once: true });
        timer = setTimeout(() => done(false), 8000);
        if (ws.readyState === WebSocket.OPEN) done(true);
        else if (ws.readyState !== WebSocket.CONNECTING) done(false);
      });
      if (!opened) return false;
    }
    if (elConsoleView.classList.contains("hidden")
        || consoleState.paneId !== paneId
        || consoleState.ws !== ws
        || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(bytes);
    return true;
  }

  async function attachConsoleFiles(files) {
    const paneId = state.activePaneId;
    if (!files?.length || !paneId) return;
    setConsoleSub("uploading…");
    try {
      const paths = await Promise.all([...files].map(async (file) => {
        const blob = (file.type || "").startsWith("image/") ? await SheepItComposer.shrinkImage(file) : file;
        const res = await fetch(`/api/agents/${encodeURIComponent(paneId)}/attach`, {
          method: "POST",
          headers: uploadHeaders(blob, file.name),
          body: blob,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "the gateway would not take it");
        return data.path;
      }));
      if (!await sendConsoleWhenConnected(
        paneId,
        encoder.encode(paths.map((path) => `@${path}`).join(" ") + " "),
      )) {
        if (elConsoleView.classList.contains("hidden") || consoleState.paneId !== paneId) return;
        setConsoleSub(`saved as @${paths.join(" @")}; terminal disconnected`);
        return;
      }
      setConsoleSub(`ready: ${paths.map((path) => `@${path}`).join(" ")}`);
    } catch (err) {
      setConsoleSub(`could not attach it: ${err.message}`);
    }
  }

  async function pasteConsolePhotoFromClipboard() {
    try {
      // This is called directly from a tap so iOS can grant clipboard access.
      const images = await SheepItComposer.clipboardImages();
      if (!images.length) {
        setConsoleSub("no photo in clipboard; use the attachment button to choose one");
        return;
      }
      await attachConsoleFiles(images);
    } catch (err) {
      setConsoleSub(`could not read clipboard: ${err.message || "permission denied"}`);
    }
  }

  // #console-keys: the fixed row's buttons, looked up in KEY_VOCAB rather
  // than carrying an escape sequence of their own in the markup.
  function sendConsoleKey(name) {
    const entry = KEY_VOCAB[name];
    if (entry) sendConsole(encoder.encode(entry.bytes));
  }

  function sendConsoleControl(message) {
    const ws = consoleState.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /* Herdr owns the scrollback, so a gesture here is a request, not a local
     move: wheel notches and finger drags both become lines for it to scroll. */
  function consoleCellAt(clientX, clientY) {
    const term = consoleState.term;
    const screen = elConsoleTerm.querySelector(".xterm-screen");
    if (!term || !screen || !term.cols || !term.rows) return {};
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return {};
    return {
      column: Math.max(0, Math.min(term.cols - 1,
        Math.floor((clientX - rect.left) / (rect.width / term.cols)))),
      row: Math.max(0, Math.min(term.rows - 1,
        Math.floor((clientY - rect.top) / (rect.height / term.rows)))),
    };
  }

  function attachConsoleScroll() {
    elConsoleTerm.addEventListener(
      "wheel",
      (e) => {
        if (!consoleState.ws) return;
        e.preventDefault();
        // Herdr uses the cell beneath the wheel to route mouse-aware apps.
        // Capture before xterm so one wheel movement is sent only once.
        e.stopImmediatePropagation();
        // Wheel deltas can be pixels (trackpads), lines (many mice and
        // Firefox), or pages. Convert to pixels before accumulating so a
        // line-mode wheel notch does not take many turns to move one line.
        const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * 40
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * consoleState.rows * 40
            : e.deltaY;
        if (consoleState.scrollAcc && Math.sign(delta) !== Math.sign(consoleState.scrollAcc)) {
          consoleState.scrollAcc = 0;
        }
        consoleState.scrollAcc += delta;
        const lines = Math.trunc(consoleState.scrollAcc / 40);
        if (!lines) return;
        consoleState.scrollAcc -= lines * 40;
        sendConsoleControl({
          type: "scroll",
          direction: lines < 0 ? "up" : "down",
          lines: Math.min(100, Math.abs(lines)),
          ...consoleCellAt(e.clientX, e.clientY),
        });
      },
      { passive: false, capture: true }
    );

    /* A drag on the screen scrolls Herdr's scrollback - except while there is
       a selection on it, where the same drag is somebody moving a selection
       handle and scrolling the pane under it would take the text away. */
    let touchY = null;
    elConsoleTerm.addEventListener("touchstart", (e) => {
      touchY = e.touches.length === 1 && !consoleHeld() ? e.touches[0].clientY : null;
    }, { passive: true });
    elConsoleTerm.addEventListener("touchmove", (e) => {
      if (touchY === null || !consoleState.ws || consoleHeld()) return;
      const y = e.touches[0].clientY;
      const moved = touchY - y;
      // A tap that drifts is still a tap; only a real drag scrolls.
      if (Math.abs(moved) < 24) return;
      // This is remote terminal scrollback, not a local page scroll. Stop
      // Safari and xterm competing to interpret the same finger movement.
      e.preventDefault();
      touchY = y;
      sendConsoleControl({
        type: "scroll",
        direction: moved < 0 ? "up" : "down",
        lines: Math.min(10, Math.max(1, Math.round(Math.abs(moved) / 24))),
        ...consoleCellAt(e.touches[0].clientX, y),
      });
    }, { passive: false });
    elConsoleTerm.addEventListener("touchend", () => { touchY = null; }, { passive: true });
  }

  /* Attaching is not a read-only act: the connection names a size in its
     handshake and Herdr gives the pane that size, and the pane runtime is the
     same one the desktop is drawing. So the size asked for is the one that
     suits this screen, and the font then follows whatever Herdr actually
     settled on - which is not always what was asked. */
  function showPaneSize(cols, rows) {
    const term = consoleState.term;
    if (!term || !cols || !rows) return;
    consoleState.cols = cols;
    consoleState.rows = rows;
    if (keyboardOpen()) {
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      return;
    }
    const box = consoleBox();
    if (!box) return;
    const byWidth = box.width / (cols * CELL_WIDTH);
    const byHeight = box.height / (rows * consoleState.cellHeight);
    const size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.min(byWidth, byHeight)));
    term.options.fontSize = Math.round(size * 10) / 10;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    /* The numbers above are an estimate of a cell from the font size, and an
       estimate is not what the terminal then draws: xterm rounds every row's
       height up, so a tall pane overflows by those roundings added together -
       and what falls off the bottom is the composer, the one line you came to
       read. So measure the grid it actually produced and correct. */
    requestAnimationFrame(() => correctConsoleOverflow(cols, rows, 0));
  }

  function correctConsoleOverflow(cols, rows, pass) {
    const term = consoleState.term;
    const grid = elConsoleTerm.querySelector(".xterm-rows");
    const box = consoleBox();
    if (!term || !grid || !box || pass > 2 || keyboardOpen()) return;
    const drawn = grid.getBoundingClientRect();
    /* What a cell really costs, in multiples of the font size. Remembering it
       means the next size asked for is one that fits at a readable font,
       rather than one the estimate said would fit and then did not. */
    const measured = drawn.height / (term.rows * term.options.fontSize);
    if (measured > 0.8 && measured < 3) consoleState.cellHeight = measured;
    const overflow = Math.max(drawn.height / box.height, drawn.width / box.width);
    if (overflow <= 1.001) return;
    const size = Math.max(MIN_FONT, term.options.fontSize / overflow);
    const rounded = Math.floor(size * 10) / 10;
    if (rounded >= term.options.fontSize) return;
    term.options.fontSize = rounded;
    requestAnimationFrame(() => correctConsoleOverflow(cols, rows, pass + 1));
  }

  /* The room the rows actually get, padding taken off - a terminal sized to
     the box including its padding loses its bottom line under the key row. */
  function consoleBox() {
    const width = elConsoleTerm.clientWidth - CONSOLE_PAD_X;
    const height = elConsoleTerm.clientHeight - CONSOLE_PAD_Y;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  /* What this screen can show comfortably, in cells. */
  function phoneSize() {
    const box = consoleBox();
    if (!box) return null;
    return {
      cols: Math.max(20, Math.floor(box.width / (FIT_FONT * CELL_WIDTH))),
      rows: Math.max(5, Math.floor(box.height / (FIT_FONT * consoleState.cellHeight))),
    };
  }

  // After a rotation, or once the keyboard has given the screen back.
  let consoleFitTimer = null;
  let consoleFitRetryTimer = null;
  function clearConsoleFitRetry() {
    if (consoleFitRetryTimer) clearTimeout(consoleFitRetryTimer);
    consoleFitRetryTimer = null;
  }

  function retryConsoleFit() {
    clearConsoleFitRetry();
    consoleFitRetryTimer = setTimeout(() => {
      consoleFitRetryTimer = null;
      const target = consoleState.fitTarget;
      if (!target || elConsoleView.classList.contains("hidden") || keyboardOpen()) return;
      if (consoleState.cols === target.cols && consoleState.rows === target.rows) {
        consoleState.fitTarget = null;
        return;
      }
      if (!consoleState.ws || consoleState.ws.readyState !== WebSocket.OPEN) return;
      if (consoleState.fitRetryCount >= 3) {
        consoleState.fitTarget = null;
        return;
      }
      consoleState.fitRetryCount++;
      sendConsoleControl({ type: "resize", ...target });
      retryConsoleFit();
    }, 350);
  }

  function requestFit() {
    if (elConsoleView.classList.contains("hidden") || keyboardOpen()) return false;
    const size = phoneSize();
    const ws = consoleState.ws;
    if (!size || !ws || ws.readyState !== WebSocket.OPEN) return false;
    clearConsoleFitRetry();
    if (consoleState.cols === size.cols && consoleState.rows === size.rows) {
      consoleState.fitTarget = null;
      return true;
    }
    consoleState.fitTarget = size;
    consoleState.fitRetryCount = 0;
    sendConsoleControl({ type: "resize", ...size });
    retryConsoleFit();
    return true;
  }

  /* The keyboard takes half the screen, and re-fitting a 43-row pane into what
     is left would put the font somewhere near six pixels. So while it is open
     the size is left alone and the terminal is scrolled to its bottom instead -
     which is where the prompt you are typing at lives. */
  function keyboardOpen() {
    const vv = window.visualViewport;
    return Boolean(vv && vv.height < window.innerHeight * 0.75);
  }

  function fitConsole() {
    if (elConsoleView.classList.contains("hidden")) return;
    if (keyboardOpen()) {
      if (consoleFitTimer) clearTimeout(consoleFitTimer);
      consoleFitTimer = null;
      return;
    }
    if (consoleFitTimer) clearTimeout(consoleFitTimer);
    consoleFitTimer = setTimeout(() => {
      consoleFitTimer = null;
      if (requestFit()) consoleState.fitPending = false;
    }, 180);
  }
  /* xterm keeps its desktop-sized grid while the phone keyboard is open. The
     console viewport gets shorter, so keep its bottom (where the active prompt
     and xterm's mobile input target sit) in view as visualViewport animates. */
  function keepConsoleInputVisible() {
    if (elConsoleView.classList.contains("hidden") || !keyboardOpen()) return;
    requestAnimationFrame(() => {
      if (elConsoleView.classList.contains("hidden") || !keyboardOpen()) return;
      elConsoleTerm.scrollTop = elConsoleTerm.scrollHeight;
    });
  }

  function setConsoleSub(text) {
    elConsoleSub.textContent = text;
    elConsoleSub.classList.remove("hidden");
  }

  async function openConsole() {
    if (!state.activePaneId) return;
    const paneId = state.activePaneId;
    triggerHaptic();
    elConsoleView.classList.remove("hidden");
    syncPinned();
    elAppHeader.classList.add("console-open");
    elConsoleSub.classList.remove("hidden");
    renderAgentBar();
    setConsoleSub("loading…");
    if (!(await loadTerminalLibrary())) {
      setConsoleSub("could not load the terminal");
      return;
    }
    // Closed again while it was loading: do not attach behind their back.
    if (elConsoleView.classList.contains("hidden") || state.activePaneId !== paneId) return;
    const term = ensureTerminal();
    if (!term) {
      setConsoleSub("terminal unavailable");
      return;
    }
    // A different pane is a different terminal: drop what is on screen rather
    // than drawing the new pane's frames over the old pane's.
    if (consoleState.paneId !== paneId) {
      term.reset();
      // Including anything held for a selection: it is the old pane's screen.
      consoleState.held = [];
      consoleState.heldBytes = 0;
      consoleState.paneId = paneId;
    }
    // Focusing xterm opens the software keyboard on iOS. Keep the terminal
    // ready for typing on desktop, but let mobile users choose when to bring
    // up the keyboard by tapping the terminal themselves.
    if (wide.matches) term.focus();
    connectConsole();
  }

  function connectConsole() {
    closeConsoleSocket();
    const term = consoleState.term;
    const paneId = consoleState.paneId;
    if (!term || !paneId) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const size = phoneSize() || { cols: term.cols, rows: term.rows };
    const url = `${scheme}://${location.host}/ws/terminal/${encodeURIComponent(paneId)}` +
      `?cols=${size.cols}&rows=${size.rows}`;
    consoleState.fitPending = true;
    setConsoleSub("connecting…");
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      setConsoleSub("could not connect");
      return;
    }
    ws.binaryType = "arraybuffer";
    consoleState.ws = ws;
    ws.onopen = () => {
      elConsoleSub.classList.add("hidden");
      if (consoleFitTimer) clearTimeout(consoleFitTimer);
      consoleFitTimer = null;
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // The only text the gateway sends is a failure it could not report as
        // a status code, the socket having already been upgraded.
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "size") {
            showPaneSize(msg.cols, msg.rows);
            if (consoleState.fitTarget
              && msg.cols === consoleState.fitTarget.cols
              && msg.rows === consoleState.fitTarget.rows) {
              consoleState.fitTarget = null;
              clearConsoleFitRetry();
            }
            // The first size report confirms the pane has started drawing;
            // the socket's open event alone is too early to resize it.
            if (consoleState.fitPending && requestFit()) consoleState.fitPending = false;
          }
          else if (msg.type === "error") setConsoleSub(msg.message || "error");
        } catch (err) {
          /* not ours */
        }
        return;
      }
      const bytes = new Uint8Array(event.data);
      /* Copying something off the screen means the screen has to stand still.
         What arrives meanwhile is written the moment the selection goes. */
      if (consoleHeld() && consoleState.heldBytes + bytes.length <= CONSOLE_HOLD_MAX) {
        consoleState.held.push(bytes);
        consoleState.heldBytes += bytes.length;
        return;
      }
      if (consoleState.held.length) {
        for (const held of consoleState.held) term.write(held);
        consoleState.held = [];
      }
      consoleState.heldBytes = 0;
      term.write(bytes);
    };
    ws.onclose = () => {
      if (consoleState.ws === ws) consoleState.ws = null;
      if (!elConsoleView.classList.contains("hidden")) setConsoleSub("detached");
    };
    ws.onerror = () => setConsoleSub("connection failed");
  }

  function closeConsoleSocket() {
    const ws = consoleState.ws;
    consoleState.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }

  function closeConsole() {
    elConsoleView.classList.add("hidden");
    syncPinned();
    elAppHeader.classList.remove("console-open");
    elConsoleSub.classList.add("hidden");
    consoleState.fitPending = false;
    consoleState.fitTarget = null;
    clearConsoleFitRetry();
    if (consoleFitTimer) clearTimeout(consoleFitTimer);
    consoleFitTimer = null;
    closeConsoleSocket();
    renderAgentBar();
    // The transcript was left out of the loop while the console was up, and on
    // a phone the loop was stopped outright; it is its turn again either way.
    startPolling();
    loop();
  }

  // Shortcut taps should not move focus off xterm's hidden textarea. On
  // mobile that blur dismisses the system keyboard before the key is sent.
  elConsoleKeys.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".key-btn")) e.preventDefault();
  });
  elConsoleKeys.addEventListener("click", (e) => {
    const btn = e.target.closest(".key-btn");
    if (btn && btn.dataset.key) sendConsoleKey(btn.dataset.key);
  });
  const elConsoleAttach = document.getElementById("console-attach");
  const elConsoleAttachInput = document.getElementById("console-attach-input");
  const elConsolePastePhoto = document.getElementById("console-paste-photo");
  elConsoleAttach.addEventListener("click", () => elConsoleAttachInput.click());
  elConsolePastePhoto.addEventListener("click", pasteConsolePhotoFromClipboard);
  elConsoleAttachInput.addEventListener("change", () => {
    const files = [...(elConsoleAttachInput.files || [])];
    elConsoleAttachInput.value = "";
    attachConsoleFiles(files);
  });
  elConsoleTerm.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
  });
  elConsoleTerm.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    attachConsoleFiles(files);
  });
  window.addEventListener("resize", fitConsole);
  window.addEventListener("resize", keepConsoleInputVisible);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitConsole);
    window.visualViewport.addEventListener("resize", keepConsoleInputVisible);
    window.visualViewport.addEventListener("scroll", keepConsoleInputVisible);
  }
  if (window.ResizeObserver) {
    new ResizeObserver(fitConsole).observe(elConsoleTerm);
  }

  /* ----------------------------------------------------------------------
     Changed files

     What an agent says it did and what it did to the working tree are two
     different claims. This is the second one: git's own porcelain, read in
     the pane's directory, with each file's diff fetched only when you ask for
     it. Unified by default because a phone is narrow; side by side for when
     the change is a replacement and the two versions want to be level.
     ---------------------------------------------------------------------- */
  function diffSplitPref() {
    return state.diffSplit ? "1" : "0";
  }

  function setDiffLayout(split) {
    state.diffSplit = split;
    elBtnDiffLayout.setAttribute("aria-pressed", split ? "true" : "false");
    elBtnDiffLayout.textContent = split ? "Unified" : "Split";
    savePref("sheepit.diffsplit", diffSplitPref());
    // Re-render whatever is already open, in the other shape.
    elChangesList.querySelectorAll(".diff-body[data-patch]").forEach((body) => {
      body.innerHTML = renderPatch(body.getAttribute("data-patch"));
      syncSplitScroll(body);
    });
  }

  function statusLabel(file) {
    if (file.untracked) return "new";
    const letters = (file.index_status + file.worktree_status).replace(/\s/g, "");
    const words = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict" };
    return words[letters[0]] || letters.toLowerCase() || "changed";
  }

  async function openChanges() {
    if (!state.activePaneId) return;
    if (state.chatVisible && !state.activeChatId) setPaneView("transcript");
    triggerHaptic();
    elChangesView.classList.remove("hidden");
    elChangesList.innerHTML = '<div class="history-empty">Reading the working tree…</div>';
    elChangesSub.textContent = "";
    await refreshChanges();
  }

  async function refreshChanges() {
    const paneId = state.activePaneId;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(paneId)}/changes`);
      const data = await res.json();
      if (paneId !== state.activePaneId) return;
      if (!data.ok) throw new Error(data.error || "could not read git");
      renderChanges(data);
    } catch (err) {
      elChangesList.innerHTML = `<div class="history-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderChanges(data) {
    if (!data.repo) {
      elChangesSub.textContent = "";
      setChangesBadge(0);
      elChangesList.innerHTML =
        '<div class="history-empty">This agent is not working in a git repository.</div>';
      return;
    }
    setChangesBadge(data.files.length);
    elChangesSub.textContent = data.files.length
      ? `${data.branch} · +${data.added} −${data.removed}`
      : `${data.branch} · nothing changed`;
    if (!data.files.length) {
      elChangesList.innerHTML =
        '<div class="history-empty">The working tree is clean.</div>';
      return;
    }
    // Opening a row needs more than its path: whether it is a picture, and
    // which side of it still exists.
    state.changedFiles = {};
    for (const file of data.files) state.changedFiles[file.path] = file;
    elChangesList.innerHTML = data.files
      .map((file) => {
        const name = file.path.split("/").pop();
        const dir = file.path.slice(0, file.path.length - name.length);
        const counts = file.image
          ? '<span class="diff-binary">image</span>'
          : file.binary
          ? '<span class="diff-binary">binary</span>'
          : `<span class="diff-add">+${file.added}</span>` +
            `<span class="diff-del">−${file.removed}</span>`;
        return `
          <div class="change-row-wrap">
            <button class="change-row" data-path="${escapeHtml(file.path)}">
              <span class="change-status status-${escapeHtml(statusLabel(file))}">${escapeHtml(statusLabel(file))}</span>
              <span class="change-name">
                <span class="change-dir">${escapeHtml(dir)}</span>${escapeHtml(name)}
                ${file.old_path ? `<span class="change-dir">← ${escapeHtml(file.old_path)}</span>` : ""}
              </span>
              <span class="change-counts">${counts}</span>
            </button>
            <div class="diff-body hidden"></div>
          </div>`;
      })
      .join("");
  }

  function setChangesBadge(count) {
    if (!count) {
      elChangesCount.classList.add("hidden");
      return;
    }
    elChangesCount.textContent = count > 99 ? "99+" : String(count);
    elChangesCount.classList.remove("hidden");
  }

  /* ------------------------------------------------------- Pictures ---
   *
   * A patch for a PNG says "Binary files differ" and stops, which is true and
   * useless: what somebody wants to know about a changed screenshot or icon
   * is what it looks like now, and what it looked like before. So an image is
   * drawn rather than parsed - the working tree on one side, HEAD on the
   * other, and only the sides that exist. A new file has no before; a deleted
   * one has no after.
   */
  function imageUrl(path, side) {
    return (
      `/api/agents/${encodeURIComponent(state.activePaneId)}/image` +
      `?path=${encodeURIComponent(path)}&side=${side}`
    );
  }

  /* Which halves of a picture there are to show. git's letters, not the word
     `statusLabel` makes of them: a staged addition has nothing at HEAD even
     though it is not untracked, and a deletion has nothing on disk. */
  function imageSides(file) {
    const letters = (file.index_status + file.worktree_status).replace(/\s/g, "");
    return {
      before: !file.untracked && !letters.includes("A"),
      after: !letters.includes("D"),
    };
  }

  function shotHtml(label, path, side) {
    return `
      <figure class="diff-shot">
        <figcaption class="diff-shot-label">${escapeHtml(label)}</figcaption>
        <img class="diff-shot-img" alt="${escapeHtml(path)}, ${escapeHtml(label)}"
             src="${escapeHtml(imageUrl(path, side))}">
        <figcaption class="diff-shot-size"></figcaption>
      </figure>`;
  }

  function imageDiffHtml(file) {
    const sides = imageSides(file);
    const shots = [];
    // A rename is the same picture under a new name, so its before is the
    // name it had.
    if (sides.before) shots.push(shotHtml("before", file.old_path || file.path, "head"));
    if (sides.after) shots.push(shotHtml("after", file.path, "work"));
    if (!shots.length) return '<div class="diff-loading">Nothing to show.</div>';
    return `<div class="diff-images${shots.length > 1 ? " two" : ""}">${shots.join("")}</div>`;
  }

  /* Each picture says its own size once the browser knows it, which is the
     one number a diff of an image would have told you. An image the gateway
     refused - too big, or gone from disk since the listing - says so where it
     would have been, rather than leaving a broken frame. */
  function measureShots(body) {
    body.querySelectorAll(".diff-shot-img").forEach((img) => {
      const caption = img.parentElement.querySelector(".diff-shot-size");
      const say = () => {
        if (caption) caption.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
      };
      if (img.complete && img.naturalWidth) say();
      else img.addEventListener("load", say, { once: true });
      img.addEventListener("error", () => {
        img.classList.add("hidden");
        if (caption) caption.textContent = "could not be read";
      }, { once: true });
    });
  }

  async function toggleDiff(row) {
    const body = row.parentElement.querySelector(".diff-body");
    if (!body.classList.contains("hidden")) {
      body.classList.add("hidden");
      row.classList.remove("open");
      return;
    }
    row.classList.add("open");
    body.classList.remove("hidden");
    if (body.getAttribute("data-patch") !== null || body.hasAttribute("data-shot")) return;
    body.innerHTML = '<div class="diff-loading">Reading…</div>';
    const path = row.getAttribute("data-path");
    const file = state.changedFiles[path];
    if (file && file.image) {
      /* Drawn, not parsed. Marked with its own attribute rather than an empty
         `data-patch`, because that is what Unified/Split redraws - and a
         picture has no second layout to be drawn in. */
      body.setAttribute("data-shot", "1");
      body.innerHTML = imageDiffHtml(file);
      measureShots(body);
      return;
    }
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(state.activePaneId)}/diff` +
          `?path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "could not read the diff");
      const patch = data.patch + (data.truncated ? "\n… diff truncated\n" : "");
      body.setAttribute("data-patch", patch);
      body.innerHTML = renderPatch(patch);
      syncSplitScroll(body);
    } catch (err) {
      body.innerHTML = `<div class="diff-loading">${escapeHtml(err.message)}</div>`;
    }
  }

  /* A patch is hunks, and a hunk is lines that are context, removals or
     additions. Both layouts are drawn from the same parse: unified keeps the
     file's order, split pairs each run of removals with the run of additions
     that replaced it, so the two versions sit level. */
  function parsePatch(patch) {
    const hunks = [];
    let hunk = null;
    for (const line of patch.split("\n")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (header) {
        hunk = {
          heading: header[3].trim(),
          oldLine: Number(header[1]),
          newLine: Number(header[2]),
          lines: [],
        };
        hunks.push(hunk);
        continue;
      }
      if (!hunk) continue; // the diff --git preamble
      const kind = line[0];
      if (kind === "+") hunk.lines.push({ kind: "add", text: line.slice(1) });
      else if (kind === "-") hunk.lines.push({ kind: "del", text: line.slice(1) });
      else if (kind === "\\") continue; // "\ No newline at end of file"
      else hunk.lines.push({ kind: "ctx", text: line.slice(1) });
    }
    return hunks;
  }

  function numberedRows(hunk) {
    let oldNo = hunk.oldLine;
    let newNo = hunk.newLine;
    return hunk.lines.map((line) => {
      const row = { ...line, oldNo: null, newNo: null };
      if (line.kind !== "add") row.oldNo = oldNo++;
      if (line.kind !== "del") row.newNo = newNo++;
      return row;
    });
  }

  function renderPatch(patch) {
    const hunks = parsePatch(patch);
    if (!hunks.length) {
      return '<div class="diff-loading">No textual change to show.</div>';
    }
    return hunks
      .map((hunk) => {
        const rows = numberedRows(hunk);
        const body = state.diffSplit ? renderSplitRows(rows) : renderUnifiedRows(rows);
        const heading = hunk.heading
          ? `<div class="diff-hunk">${escapeHtml(hunk.heading)}</div>`
          : '<div class="diff-hunk"></div>';
        return heading + body;
      })
      .join("");
  }

  function renderUnifiedRows(rows) {
    const marks = { add: "+", del: "−", ctx: " " };
    return (
      '<div class="diff-grid unified">' +
      rows
        .map(
          (row) => `
        <div class="diff-line ${row.kind}">
          <span class="diff-no">${row.oldNo || ""}</span>
          <span class="diff-no">${row.newNo || ""}</span>
          <span class="diff-mark">${marks[row.kind]}</span>
          <span class="diff-text">${escapeHtml(row.text) || "&nbsp;"}</span>
        </div>`
        )
        .join("") +
      "</div>"
    );
  }

  /* Side by side is two columns, not one grid: a grid sized to its content
     puts the right-hand column past the edge of a phone, where the longest
     line in the file decides where it starts. Each side scrolls on its own -
     and each mirrors the other, so a line and its replacement stay level. */
  function renderSplitRows(rows) {
    const pairs = [];
    let dels = [];
    let adds = [];
    const flush = () => {
      const height = Math.max(dels.length, adds.length);
      for (let i = 0; i < height; i++) {
        pairs.push({ left: dels[i] || null, right: adds[i] || null });
      }
      dels = [];
      adds = [];
    };
    for (const row of rows) {
      if (row.kind === "del") dels.push(row);
      else if (row.kind === "add") adds.push(row);
      else {
        flush();
        pairs.push({ left: row, right: row });
      }
    }
    flush();

    const column = (side) =>
      '<div class="diff-col">' +
      pairs
        .map(({ left, right }) => {
          const row = side === "left" ? left : right;
          if (!row) return '<div class="diff-side pad"><span class="diff-no"></span></div>';
          const no = side === "left" ? row.oldNo : row.newNo;
          return (
            `<div class="diff-side ${row.kind}">` +
            `<span class="diff-no">${no || ""}</span>` +
            `<span class="diff-text">${escapeHtml(row.text) || "&nbsp;"}</span>` +
            "</div>"
          );
        })
        .join("") +
      "</div>";

    return `<div class="diff-grid split">${column("left")}${column("right")}</div>`;
  }

  /* Two columns, one gesture: scrolling either side moves the other, so the
     two versions of a line stay opposite each other. */
  function syncSplitScroll(root) {
    root.querySelectorAll(".diff-grid.split").forEach((grid) => {
      const columns = grid.querySelectorAll(".diff-col");
      if (columns.length !== 2) return;
      columns.forEach((column, i) => {
        column.addEventListener("scroll", () => {
          const other = columns[i === 0 ? 1 : 0];
          if (other.scrollLeft !== column.scrollLeft) other.scrollLeft = column.scrollLeft;
        }, { passive: true });
      });
    });
  }

  function closeChanges() {
    elChangesView.classList.add("hidden");
  }

  elBtnChanges.addEventListener("click", openChanges);
  elBtnCloseChanges.addEventListener("click", closeChanges);
  elBtnDiffLayout.addEventListener("click", () => setDiffLayout(!state.diffSplit));
  elChangesList.addEventListener("click", (e) => {
    const row = e.target.closest(".change-row");
    if (row) toggleDiff(row);
  });

  /* ---- Tokens over time ---------------------------------------------------
   *
   * The strip above the flock says what is *left* of a window. This page says
   * where it went: tokens per hour and per day, which is the question a
   * percentage cannot answer - "am I spending more than last week", "which
   * project ate Tuesday", "was that one afternoon or all of it".
   *
   * Nothing new is recorded for it. Both agents write every turn down in their
   * own session logs and the gateway reads those, so the history is as old as
   * the logs on the day this ships rather than starting from now.
   *
   * The counting is deliberately total tokens, cache reads included: that is
   * what was sent to a model and what a window is priced on. The split - how
   * much of it was cache, how much was written back - is under the chart,
   * because a bar that hid the cache would be a smaller number than the one the
   * subscription is actually spending.
   */

  // One fixed hue per model, assigned in name order and never cycled: the same
  // model is the same colour whichever range is showing, so switching from a
  // week to a day does not repaint what is left on screen. Past five, the
  // smallest fold into one grey "other" rather than inventing a sixth hue.
  const SERIES_COLOURS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
  const OTHER_COLOUR = "#5e6678";
  const SERIES_MAX = SERIES_COLOURS.length;
  const OTHER = "other";

  const KINDS = [
    ["output", "output"],
    ["input", "input"],
    ["cache_write", "cache write"],
    ["cache_read", "cache read"],
  ];

  const HOUR_MS = 3600000;

  /* Big numbers, short enough to sit on a phone. Tokens run to the hundreds of
     millions in a week, so this goes up to billions and never spends more than
     three characters of digits: 1.2M, 125K, 12K. A round one keeps no decimal,
     because the axis it labels is round on purpose - "1.0K" on a gridline reads
     as a measurement rather than as the scale. */
  function fmtTokens(n) {
    const v = Math.max(0, Math.round(n || 0));
    const scale = (unit, by) => `${trimZero((v / by).toFixed(v / by >= 10 ? 0 : 1))}${unit}`;
    if (v >= 1e9) return scale("B", 1e9);
    if (v >= 1e6) return scale("M", 1e6);
    if (v >= 1e3) return scale("K", 1e3);
    return String(v);
  }

  function trimZero(text) {
    return text.endsWith(".0") ? text.slice(0, -2) : text;
  }

  function fmtCount(n) {
    return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function rowTotal(row) {
    return (row.input || 0) + (row.output || 0) +
      (row.cache_read || 0) + (row.cache_write || 0);
  }

  /* "claude-opus-5" is the id; "opus 5" is what a legend on a 360px screen can
     afford. The vendor is already the agent's own line, and a dated id
     ("-20250514") says nothing anybody is asking here. */
  function modelLabel(model) {
    return String(model || "")
      .replace(/^(claude|anthropic)-/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-latest$/, "")
      .replace(/-/g, " ");
  }

  /* The columns the chart draws, every one of them, including the empty ones.
     A day nothing was spent is a fact about the week and has to take up its
     own width - a chart that only plots the days that happened compresses a
     quiet Sunday out of existence and makes Monday look adjacent to Friday.

     Buckets are local: the gateway counts in UTC hours because it cannot know
     which day that was for you, and this is where it becomes Tuesday. */
  function usageColumns(rows, days, now = new Date()) {
    const byHour = days <= 1;
    const count = byHour ? 24 : days;
    const columns = [];
    const index = new Map();
    for (let i = count - 1; i >= 0; i--) {
      const at = new Date(now);
      if (byHour) {
        at.setMinutes(0, 0, 0);
        at.setTime(at.getTime() - i * HOUR_MS);
      } else {
        at.setHours(0, 0, 0, 0);
        // Days are stepped rather than subtracted in milliseconds, so the one
        // the clocks change on is still a day.
        at.setDate(at.getDate() - i);
      }
      const column = {
        at,
        key: slotKey(at, byHour),
        label: slotLabel(at, byHour),
        total: 0,
        turns: 0,
        parts: {},
        kinds: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      };
      index.set(column.key, column);
      columns.push(column);
    }

    for (const row of rows || []) {
      const at = new Date(row.hour);
      if (isNaN(at)) continue;
      const column = index.get(slotKey(at, byHour));
      if (!column) continue;  // older than the range, or a clock skewed ahead
      const total = rowTotal(row);
      column.total += total;
      column.turns += row.messages || 0;
      column.parts[row.model] = (column.parts[row.model] || 0) + total;
      for (const [kind] of KINDS) column.kinds[kind] += row[kind] || 0;
    }
    return columns;
  }

  function slotKey(at, byHour) {
    const day = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
    return byHour ? `${day}T${at.getHours()}` : day;
  }

  function slotLabel(at, byHour) {
    if (byHour) return `${String(at.getHours()).padStart(2, "0")}:00`;
    return at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  }

  /* Which models get a colour, and which are folded away. The order is by name
     rather than by size on purpose: rank changes with the range, and a legend
     that repaints itself when you tap "24h" is one nobody can learn. */
  function usageSeries(rows) {
    const totals = new Map();
    for (const row of rows || []) {
      totals.set(row.model, (totals.get(row.model) || 0) + rowTotal(row));
    }
    const named = [...totals.keys()].sort();
    const kept = named.length <= SERIES_MAX
      ? named
      : [...named].sort((a, b) => totals.get(b) - totals.get(a))
          .slice(0, SERIES_MAX).sort();
    const series = kept.map((model, i) => ({
      model,
      label: modelLabel(model),
      colour: SERIES_COLOURS[i],
      total: totals.get(model) || 0,
    }));
    const folded = named.filter((model) => !kept.includes(model));
    if (folded.length) {
      series.push({
        model: OTHER,
        label: `other (${folded.length})`,
        colour: OTHER_COLOUR,
        total: folded.reduce((sum, model) => sum + totals.get(model), 0),
        folds: folded,
      });
    }
    return series;
  }

  // What a column is worth in a series, with the folded models counted once.
  function partOf(column, series) {
    if (!series.folds) return column.parts[series.model] || 0;
    return series.folds.reduce((sum, model) => sum + (column.parts[model] || 0), 0);
  }

  /* A top gridline on a number somebody can hold in their head: 1, 2 or 5 with
     zeroes after it. The bars are read against this line, so it being round is
     most of what makes the chart readable at a glance. */
  function niceMax(value) {
    if (!(value > 0)) return 0;
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    const scaled = value / power;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * power;
  }

  /* Geometry, in the pixels the chart is actually drawn at. The SVG is built
     to the width it was measured at rather than scaled to fit: a viewBox
     stretched across a desktop window takes the axis labels with it, and 11px
     type at 2.4× is not a label any more. */
  const PLOT_H = 132;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 16;   // the row of x labels
  const PAD_LEFT = 34;     // the y labels, right-aligned against the plot
  const PAD_RIGHT = 4;
  const BAR_MAX = 24;      // a mark is never thicker than this, however few
  const SEGMENT_GAP = 2;   // surface showing between two stacked segments
  const BAR_CAP = 4;       // the rounded data-end, square at the baseline

  function usageChart(columns, series, width, picked = -1) {
    const w = Math.max(200, Math.round(width || 320));
    const h = PAD_TOP + PLOT_H + PAD_BOTTOM;
    const plotW = w - PAD_LEFT - PAD_RIGHT;
    const base = PAD_TOP + PLOT_H;
    const top = niceMax(Math.max(...columns.map((c) => c.total), 0));
    const slot = plotW / Math.max(1, columns.length);
    const barW = Math.max(2, Math.min(BAR_MAX, slot - 2));

    const parts = [];
    // Gridlines first, so every mark is drawn over them: nothing but the data
    // is allowed to sit on top.
    for (const share of [0, 0.5, 1]) {
      const y = Math.round(base - share * PLOT_H) + 0.5;
      parts.push(`<line class="usage-grid" x1="${PAD_LEFT}" y1="${y}" x2="${w - PAD_RIGHT}" y2="${y}"/>`);
      if (top && share) {
        parts.push(`<text class="usage-tick" x="${PAD_LEFT - 5}" y="${y + 3.5}">${
          fmtTokens(top * share)}</text>`);
      }
    }

    columns.forEach((column, i) => {
      const x = PAD_LEFT + i * slot + (slot - barW) / 2;
      if (i === picked) {
        parts.push(`<rect class="usage-pick" x="${(PAD_LEFT + i * slot).toFixed(1)}" y="${
          PAD_TOP}" width="${slot.toFixed(1)}" height="${PLOT_H}"/>`);
      }
      if (!top || !column.total) return;
      let cursor = base;
      const drawn = series
        .map((s) => ({ s, value: partOf(column, s) }))
        .filter(({ value }) => value > 0);
      drawn.forEach(({ s, value }, depth) => {
        const full = (value / top) * PLOT_H;
        const isTop = depth === drawn.length - 1;
        // The gap is taken off the top of every segment but the last, so the
        // stack still adds up to its own height at the baseline.
        const height = Math.max(1, full - (isTop ? 0 : SEGMENT_GAP));
        const y = cursor - full;
        cursor -= full;
        parts.push(isTop
          ? `<path d="${capPath(x, y, barW, height)}" fill="${s.colour}"/>`
          : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${
              height.toFixed(1)}" fill="${s.colour}"/>`);
      });
    });

    // Every label would be a smear at 24 columns on a phone, so they are
    // thinned to the ones worth reading: the quarter hours, or every few days.
    const every = columns.length > 20 ? 6 : columns.length > 10 ? 5 : 1;
    columns.forEach((column, i) => {
      if (i % every || (columns.length - i) <= every / 2) return;
      const x = PAD_LEFT + i * slot + slot / 2;
      parts.push(`<text class="usage-tick" x="${x.toFixed(1)}" y="${h - 4}" text-anchor="middle">${
        escapeHtml(shortSlot(column))}</text>`);
    });

    return `<svg class="usage-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
      `role="img" aria-label="Tokens per ${columns.length > 24 ? "day" : "bucket"}">${
        parts.join("")}</svg>`;
  }

  // A bar with its data-end rounded and its baseline square.
  function capPath(x, y, w, h) {
    const r = Math.min(BAR_CAP, h, w / 2);
    return `M${x.toFixed(1)} ${(y + h).toFixed(1)}V${(y + r).toFixed(1)}` +
      `a${r} ${r} 0 0 1 ${r} ${-r}h${(w - 2 * r).toFixed(1)}` +
      `a${r} ${r} 0 0 1 ${r} ${r}V${(y + h).toFixed(1)}z`;
  }

  // The axis version of a column's name: an hour, or a day and its month.
  function shortSlot(column) {
    const at = column.at;
    return column.key.includes("T")
      ? `${String(at.getHours()).padStart(2, "0")}`
      : `${at.getDate()}.${at.getMonth() + 1}.`;
  }

  /* One line under the chart: the bucket you are touching, or the whole range
     when you are touching nothing. A tooltip that follows a finger is a
     tooltip under a finger on a phone, so the reading is parked somewhere it
     can always be seen instead.

     Under it, the legend - which is also the reading, per model. Every model in
     the range is always listed, in its own fixed order, whether or not this
     bucket used it: a legend that appeared and disappeared as you dragged
     across the chart would be one more thing moving, and a model showing
     nothing in the hour you are looking at is worth knowing. */
  function usageReadout(columns, series, picked) {
    const column = columns[picked];
    const scope = column ? [column] : columns;
    const sum = (of) => scope.reduce((total, c) => total + of(c), 0);
    const turns = sum((c) => c.turns);
    const keys = series
      .map((s) => ({ s, value: sum((c) => partOf(c, s)) }))
      .map(({ s, value }) => `<span class="usage-chip${value ? "" : " muted"}"><i style="background:${
        s.colour}"></i>${escapeHtml(s.label)} ${fmtTokens(value)}</span>`)
      .join("");
    return `
      <div class="usage-readout">
        <span class="usage-readout-head">${escapeHtml(column ? column.label : "everything shown")}${
          turns ? ` · ${fmtCount(turns)} turns` : ""}</span>
        <span class="usage-readout-total">${fmtTokens(sum((c) => c.total))}</span>
      </div>
      <div class="usage-chips">${
        keys || '<span class="usage-chip muted">nothing spent</span>'}</div>`;
  }

  /* What the range was made of: the four kinds of token, then the projects it
     was spent on. Both are tables rather than more charts - they are a ranking
     of a handful of things, and a ranking is a list. */
  function usageKinds(columns) {
    const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    for (const column of columns) {
      for (const [kind] of KINDS) totals[kind] += column.kinds[kind];
    }
    const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
    return `<div class="usage-tiles">${KINDS.map(([kind, label]) => `
      <div class="usage-tile">
        <span class="usage-tile-label">${label}</span>
        <span class="usage-tile-value">${fmtTokens(totals[kind])}</span>
        <span class="usage-tile-share">${Math.round((totals[kind] / sum) * 100)}%</span>
      </div>`).join("")}</div>`;
  }

  // The projects the range was spent on, biggest first. Ranked, so this one is
  // ordered by size - unlike the series, whose colours have to stay put.
  const PROJECTS_SHOWN = 8;

  function usageProjects(rows, since) {
    const totals = new Map();
    for (const row of rows || []) {
      if (since && new Date(row.hour) < since) continue;
      totals.set(row.project, (totals.get(row.project) || 0) + rowTotal(row));
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return "";
    const top = ranked[0][1] || 1;
    const shown = ranked.slice(0, PROJECTS_SHOWN);
    const rest = ranked.slice(PROJECTS_SHOWN);
    if (rest.length) {
      shown.push([`${rest.length} more`, rest.reduce((sum, [, v]) => sum + v, 0)]);
    }
    return `
      <h2 class="usage-heading">Projects</h2>
      <div class="usage-rows">${shown.map(([name, value]) => `
        <div class="usage-row">
          <span class="usage-row-name">${escapeHtml(name)}</span>
          <span class="usage-row-bar"><i style="width:${
            Math.max(2, (value / top) * 100)}%"></i></span>
          <span class="usage-row-value">${fmtTokens(value)}</span>
        </div>`).join("")}</div>`;
  }

  /* Where the numbers came from, at the foot of the page. It is the one thing
     about this page somebody has to be told once: nothing here was recorded for
     it, so it goes as far back as the agents' own logs do - and it counts what
     they were asked, which is not the same as what a subscription was billed
     for. */
  function usageNote() {
    return '<p class="usage-note">Counted from the agents\' own session logs, ' +
      'which is every token sent to a model — cache reads included.</p>';
  }

  /* The page itself: what is fetched, what is drawn, and what a finger on the
     chart does. Everything above this line is arithmetic on rows and takes no
     part in the DOM, which is what `tools/test-usage.js` drives. */
  const USAGE_RANGES = { 1: "the last 24 hours", 7: "the last 7 days", 30: "the last 30 days" };

  async function openUsage() {
    triggerHaptic();
    elUsageView.classList.remove("hidden");
    if (!state.usage.rows) {
      elUsageBody.innerHTML = '<div class="history-empty">Reading the agents\' logs…</div>';
    }
    await fetchUsage();
  }

  function closeUsage() {
    elUsageView.classList.add("hidden");
  }

  async function fetchUsage() {
    const days = state.usage.days;
    try {
      const res = await fetch(`/api/usage?days=${days}`);
      const data = await res.json();
      if (days !== state.usage.days) return;  // the range moved while we asked
      if (!data.ok) throw new Error(data.error || "could not read the logs");
      state.usage.rows = data.rows || [];
      state.usage.error = "";
    } catch (err) {
      state.usage.error = err.message;
    }
    state.usage.picked = -1;
    renderUsage();
  }

  function renderUsage() {
    if (elUsageView.classList.contains("hidden")) return;
    const { rows, days, error } = state.usage;
    if (error && !rows) {
      elUsageSub.textContent = "";
      elUsageBody.innerHTML = `<div class="history-empty">${escapeHtml(error)}</div>`;
      return;
    }
    const columns = usageColumns(rows || [], days);
    const series = usageSeries(rows || []);
    const total = columns.reduce((sum, c) => sum + c.total, 0);
    // The chart is built at the width it has, so it has to be measured first -
    // and the body is the only thing on the page that knows it.
    const width = Math.max(240, elUsageBody.clientWidth - 24);

    // The head has a title and three range buttons on it already, so what is
    // left of a phone's width is a few words: the turns, counted over what is
    // actually drawn rather than over every row that came back.
    elUsageSub.textContent = error
      ? error
      : `${fmtCount(columns.reduce((sum, c) => sum + c.turns, 0))} turns`;
    elUsageBody.innerHTML = `
      <div class="usage-hero">
        <span class="usage-hero-value">${fmtTokens(total)}</span>
        <span class="usage-hero-label">tokens in ${USAGE_RANGES[days] || `${days} days`}</span>
      </div>
      <div id="usage-chart" class="usage-chart">${
        usageChart(columns, series, width, state.usage.picked)}</div>
      ${usageReadout(columns, series, state.usage.picked)}
      ${usageKinds(columns)}
      ${usageProjects(rows || [], columns.length ? columns[0].at : null)}
      ${usageNote()}`;
    state.usage.columns = columns;
  }

  /* Touching the chart picks a column. The hit area is the whole slot rather
     than the bar in it: a 6px bar on a 24 hour range is not something a finger
     can be asked to find, and an empty hour is worth picking too - "nothing,
     at 14:00" is an answer. */
  function pickColumn(e) {
    const chart = document.getElementById("usage-chart");
    if (!chart || !state.usage.columns) return;
    const box = chart.getBoundingClientRect();
    const plotLeft = box.left + PAD_LEFT;
    const slot = (box.width - PAD_LEFT - PAD_RIGHT) / state.usage.columns.length;
    const index = Math.floor((e.clientX - plotLeft) / slot);
    const picked = index >= 0 && index < state.usage.columns.length ? index : -1;
    if (picked === state.usage.picked) return;
    state.usage.picked = picked;
    renderUsage();
  }

  elBtnUsage.addEventListener("click", openUsage);
  elBtnCloseUsage.addEventListener("click", closeUsage);

  elUsageRanges.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-days]");
    if (!btn) return;
    state.usage.days = Number(btn.dataset.days);
    state.usage.picked = -1;
    [...elUsageRanges.querySelectorAll("button")].forEach((b) => {
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });
    renderUsage();   // redraw at the new range while the rows are on their way
    fetchUsage();
  });

  elUsageBody.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#usage-chart")) return;
    state.usage.scrubbing = true;
    pickColumn(e);
  });

  /* Dragging across the chart reads a column at a time. Whether a finger is
     down is tracked here rather than taken from `pressure`, which is 0 on a
     phone without a force-sensitive screen - the whole gesture would be
     ignored on exactly the device this is for. */
  elUsageBody.addEventListener("pointermove", (e) => {
    if (!state.usage.scrubbing && e.pointerType !== "mouse") return;
    if (e.target.closest("#usage-chart")) pickColumn(e);
  });

  for (const done of ["pointerup", "pointercancel", "pointerleave"]) {
    elUsageBody.addEventListener(done, () => { state.usage.scrubbing = false; });
  }

  // A rotated phone is a different width, and the chart was built in pixels.
  window.addEventListener("resize", () => {
    if (!elUsageView.classList.contains("hidden")) renderUsage();
  });

  // Init
  loadPrefs();
  // Show the flock while the agent list loads, then open the first pane.
  showFlock();
  // The first touch anywhere is what buys the page the right to make noise.
  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("touchstart", unlockAudio, { once: true });
  autoResizeTextarea();
  Promise.all([loadServerOrder(), loadServerFolders()]).finally(() => {
    loop();
    startPolling();
  });
})();


/* Structured pane and headless chat renderer, hosted in the main app document. */
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

  const $ = (id) => document.getElementById("chat-" + id);
  const elChat = $("chat-view");
  const elMessages = $("messages"), elInput = document.getElementById("prompt-input");
  const elSend = document.getElementById("btn-send"), elStop = $("btn-stop");
  const elStrip = $("attach-strip"), elAttachInput = $("attach-input");
  const elBtnScrollBottom = $("btn-scroll-bottom");

  let current = null;          // the open chat's summary
  let targetRequest = 0;       // ignore a chat fetch after another view wins
  let events = [];
  let epoch = "";
  let poll = null;             // AbortController of the running long poll
  let drawn = [];              // the markup of each message now on the page
  const openTools = new Set(); // tool cards somebody unfolded
  const picks = new Map();     // request_id -> {question: Set(labels)}
  let commands = null;         // [{name, description, hint}] for the open chat's project
  let queued = [];             // what the queue is still holding for this pane
  let queueTimer = null;
  let queueRequest = 0;
  const settling = new Map();  // queue id -> when it stops being "just sent"

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
    return data;
  }

  const esc = window.SheepItEscapeHtml;
  const shortDir = (p) => (p || "").split("/").slice(-2).join("/");
  const imageUrl = (name) => `/api/chat/image?id=${encodeURIComponent(current.id)}&name=${encodeURIComponent(name)}`;

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
        const tail = u.match(/[.,;:!?)\]*_]*$/)[0];
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

  // A picture is drawn; anything else is a link to the file, named by its kind.
  function attachmentHtml(name) {
    const ext = String(name).split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "heic", "avif"].includes(ext)) {
      return `<img src="${esc(imageUrl(name))}" alt="">`;
    }
    return `<a class="file-chip" href="${esc(imageUrl(name))}" target="_blank" rel="noopener">${esc(ext.toUpperCase())} file</a>`;
  }

  function itemHtml(it) {
    switch (it.kind) {
      case "user":
        return `<div class="msg user">` +
          (it.images.length ? `<div class="imgs">${it.images.map(attachmentHtml).join("")}</div>` : "") +
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

  /* Why a pane's chat is empty. Three different reasons read as one blank
     screen otherwise, and only the last of them is worth waiting through. */
  function paneEmpty(chat) {
    if (!chat.supported) return "There is no supported agent in this pane.";
    if (!chat.session) return "No session history yet. Send a message to start chatting; it will appear here once the agent has named the session.";
    return "Nothing in this session yet.";
  }

  /* ---- Scrolling. Past 900px the flock sits beside the chat and neither the
     window nor `#chat-chat-view` scrolls (see style.css), so the messages list
     is its own scroller there; on a phone the document scrolls instead, the
     same way it does behind the transcript (see fetchHistory's note in the
     other half of this file) - `elMessages` itself has `overflow-y: visible`
     on a phone and reports no scroll of its own, so reading its scrollTop
     there would always say "at the bottom" and drag you back down on every
     poll no matter where you had scrolled to. */
  const chatWide = window.matchMedia("(min-width: 900px)");
  let userScrolledUp = false;

  function chatScroller() {
    return chatWide.matches || document.documentElement.classList.contains("pinned")
      ? elMessages : document.scrollingElement;
  }

  function scrollChatToBottom(smooth = false) {
    const scroller = chatScroller();
    if (smooth) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    else scroller.scrollTop = scroller.scrollHeight;
    userScrolledUp = false;
    elBtnScrollBottom.classList.add("hidden");
  }

  function onChatScroll() {
    const scroller = chatScroller();
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    userScrolledUp = distance > 80;
    elBtnScrollBottom.classList.toggle("hidden", !userScrolledUp);
  }

  elMessages.addEventListener("scroll", onChatScroll, { passive: true });
  window.addEventListener("scroll", onChatScroll, { passive: true });
  chatWide.addEventListener("change", onChatScroll);
  elBtnScrollBottom.addEventListener("click", () => scrollChatToBottom(true));

  function render() {
    const running = !!(current && current.running);
    const nearBottom = !userScrolledUp;
    const html = build(events, current).map(itemHtml);
    if (!html.length) html.push(current && current.kind === "pane"
      ? `<div class="empty">${paneEmpty(current)}</div>`
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
    if (nearBottom) scrollChatToBottom();
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
        if (ctrl.signal.aborted || current?.id !== chatId) return;
        if (!data.ok) throw new Error(data.error);
        if (data.from === 0) events = [];
        events = events.concat(data.events);
        epoch = data.epoch;
        since = data.next;
        current = data.chat;
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
    queued = []; settling.clear(); drawQueue();
    loadCommands(chat.id);
    elMessages.innerHTML = "";
    userScrolledUp = false;
    elBtnScrollBottom.classList.add("hidden");
    attachStrip.clear();
    const pane = chat.kind === "pane";
    $("btn-delete").classList.toggle("hidden", pane);
    elChat.classList.remove("hidden");
    document.dispatchEvent(new CustomEvent("sheepit:chat-open", { detail: chat }));
    if (location.hash !== "#" + chat.id) history.replaceState(null, "", "#" + chat.id);
    render();
    fetchQueue();
    follow(chat.id);
  }

  document.addEventListener("sheepit:chat-target", (event) => {
    const id = event.detail;
    if (id) openById(id);
    else clearChat();
  });

  function clearChat() {
    targetRequest++;
    if (poll) poll.abort();
    poll = null; current = null;
    elChat.classList.add("hidden");
    if (location.hash) history.replaceState(null, "", location.pathname);
  }

  /* A dismissed chat goes back to the flock. Clearing its target while
     switching panes only closes the old chat; it does not open the flock. */
  function backToFlock() {
    clearChat();
    document.dispatchEvent(new CustomEvent("sheepit:chat-close"));
  }

  document.addEventListener("sheepit:chat-dismiss", backToFlock);

  /* A push names the chat in the hash; the page may already be open. */
  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (current && current.id === id) return;
    if (id) openById(id);
    else backToFlock();
  });

  /* Everything this page shows is fetched by id - a headless chat's own, or
     `pane:<pane id>` for a Herdr pane read as a chat. `chat.get` resolves
     both, so there is one way in. */
  async function openById(id) {
    const request = ++targetRequest;
    if (poll) poll.abort();
    poll = null;
    if (current?.id !== id) {
      current = null;
      events = []; epoch = ""; drawn = [];
      elChat.classList.add("hidden");
    }
    try {
      const data = await api(`/api/chat/events?id=${encodeURIComponent(id)}`);
      if (request === targetRequest) openChat(data.chat);
    } catch (e) {
      if (request !== targetRequest) return;
      alert(e.message);
      backToFlock();
    }
  }

  /* ---- Images: scaled down on the phone, kept by the gateway, sent inline.
     The strip and its hidden [{name, url}] array are composer.js, shared with
     the plain view - only how an upload happens is chat's own. */
  const attachStrip = SheepItComposer.createAttachStrip(
    elStrip,
    async (blob, scope, filename) => {
      const res = await fetch(`/api/chat/upload?id=${encodeURIComponent(current.id)}`, {
        method: "POST", headers: window.SheepItUploadHeaders(blob, filename), body: blob,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      return data.name;
    },
    (message) => alert("Could not attach it — " + message)
  );

  function attachFiles(files) {
    if (!current) return;
    return attachStrip.add(files).then(() => {
      elSend.disabled = !elInput.value.trim() && !attachStrip.list.length;
    });
  }

  elAttachInput.addEventListener("change", () => { attachFiles([...elAttachInput.files]); elAttachInput.value = ""; });
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
    typed();
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

  /* ---- The queue. A pane's prompt does not go to the pane: it goes to
     /api/queue, and the dispatcher delivers it once the pane is free and the
     subscription has room. That is the whole reason this strip exists - what
     was sent into a spent window used to vanish between the composer and the
     log, because nothing on this page was holding it. */
  const elQueue = $("queue-strip");
  const QUEUE_EVERY = 5000;
  // Give ordinary dispatch a few seconds before moving the composer to show
  // a waiting prompt. The desktop composer uses the same settling interval.
  const SETTLE_MS = 5000;

  function owed(prompts) {
    const now = Date.now();
    return prompts.filter((p) => {
      if (p.state === "sent") return false;
      const until = settling.get(p.id);
      if (until && now >= until) settling.delete(p.id);
      return !(settling.has(p.id) && p.state === "waiting");
    });
  }

  async function fetchQueue() {
    if (!current || current.kind !== "pane") { queued = []; drawQueue(); return; }
    // A poll answered mid-send has the new row in it but not yet its grace.
    if (sendingMessage) return;
    const request = ++queueRequest;
    const pane = current.pane_id;
    try {
      const data = await api("/api/queue");
      if (!current || current.pane_id !== pane || request !== queueRequest || sendingMessage) return;
      queued = owed((data.prompts || []).filter((p) => p.pane_id === pane));
    } catch (e) {
      return; // the poll's own error line already says the gateway is away
    }
    drawQueue();
  }

  /* A second client can queue a prompt while this chat is open, even when its
     queue was empty at open time. Keep watching the active pane. */
  function keepWatching() {
    if (queueTimer) clearInterval(queueTimer);
    queueTimer = null;
    if (!current || current.kind !== "pane") return;
    queueTimer = setInterval(fetchQueue, QUEUE_EVERY);
  }

  function drawQueue() {
    queueStrip.render(queued);
    keepWatching();
  }

  function queueRow(p) {
      const failed = p.state === "failed";
      return `<div class="queued${failed ? " failed" : ""}">
        <span class="queued-state">${esc(failed ? "failed" : "queued")}</span>
        <span class="queued-text">${esc(p.prompt || "")}</span>
        ${failed && p.last_error ? `<span class="queued-why">${esc(p.last_error)}</span>` : ""}
        <span class="queued-acts">
          <button type="button" class="queued-act" data-composer-action="edit" data-composer-id="${p.id}">Edit</button>
          <button type="button" class="queued-act accent" data-composer-action="send" data-composer-id="${p.id}">Send now</button>
          <button type="button" class="queued-act danger" data-composer-action="delete" data-composer-id="${p.id}">Delete</button>
        </span>
      </div>`;
  }

  async function queueAct(id, action) {
    try {
      await api(`/api/queue/${id}/${action}`, {});
    } catch (e) {
      alert(`Could not ${action} the prompt — ${e.message}`);
    }
    await fetchQueue();
  }

  function onQueueAction(action, id) {
    if (action === "send") { queueAct(id, "send"); return; }
    if (action === "delete") { queueAct(id, "delete"); return; }
    // Editing takes it back: the text lands in the box it was typed in, where
    // the keyboard is already open, and sending it queues it again.
    const row = queued.find((p) => String(p.id) === String(id));
    if (!row) return;
    elInput.value = row.prompt || "";
    typed();
    elInput.focus();
    queueAct(id, "delete");
  }
  const queueStrip = SheepItComposer.createQueueStrip(elQueue, queueRow, onQueueAction);

  /* ---- Composer. A pane's message waits for the window in the queue; a
     headless chat's goes to its own process, where one sent mid-answer waits
     its turn inside Claude Code the way typing ahead in the terminal does. */
  function grow() {
    SheepItComposer.resizeTextarea(elInput, Math.max(140, Math.round(window.innerHeight * 0.4)));
    elSend.disabled = !elInput.value.trim() && !attachStrip.list.length;
  }
  elInput.addEventListener("input", grow);
  // Text put in the box by anything but a keystroke still has to reach the
  // other half of this file, which keeps it as this chat's draft - or, sent,
  // forgets it.
  function typed() {
    elInput.dispatchEvent(new Event("input"));
  }
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
      SheepItComposer.submit(document.getElementById("prompt-form"));
    }
  });
  let sendingMessage = false;
  async function submitMessage() {
    if (elChat.classList.contains("hidden")) return;
    if (sendingMessage) return;
    const text = elInput.value;
    if (attachStrip.list.some((a) => !a.name)) return; // still uploading
    const images = attachStrip.list.map((a) => a.name);
    if ((!text.trim() && !images.length) || !current) return;
    sendingMessage = true;
    queueRequest++; // and one already asked is answered too early
    elSend.disabled = true;
    try {
      const data = await api("/api/chat/send", { id: current.id, text, images });
      current = data.chat;
      elInput.value = ""; typed();
      hideMenu();
      attachStrip.clear();
      if (current.kind === "pane" && (current.agent === "codex" || current.agent === "claude")
          && text.trim() === "/clear") {
        if (poll) poll.abort();
        events = []; epoch = ""; drawn = [];
        openTools.clear(); picks.clear();
        elMessages.innerHTML = "";
        follow(current.id);
      }
      scrollChatToBottom();
      render();
      // A pane's prompt is a queue row now. Held back for as long as delivery
      // takes, then shown: one that is still waiting when the grace is up is
      // waiting on something, and that is worth a line on the screen.
      if (data.queued) {
        settling.set(data.queued, Date.now() + SETTLE_MS);
        setTimeout(fetchQueue, SETTLE_MS + 50);
        document.dispatchEvent(new CustomEvent("sheepit:queued", { detail: data.queued }));
      }
    } catch (err) { alert(err.message); }
    finally {
      sendingMessage = false;
      elSend.disabled = false;
    }
    fetchQueue();
  }
  SheepItComposer.bindSubmit(document.getElementById("prompt-form"), submitMessage);
  elStop.addEventListener("click", () => {
    if (!elChat.classList.contains("hidden") && current) {
      api("/api/chat/stop", { id: current.id }).catch(() => {});
    }
  });
  $("btn-delete").addEventListener("click", async () => {
    if (!current || !confirm("Delete this chat from SheepIt? Its conversation stays in Claude Code (claude --resume).")) return;
    await api("/api/chat/delete", { id: current.id }).catch(() => {});
    backToFlock();
  });

  /* Opened with no chat named - a stale bookmark of the list that used to be
     here, or a hash that pointed at something since deleted. */
  const opening = decodeURIComponent(location.hash.slice(1));
  if (opening) openById(opening);
})();
