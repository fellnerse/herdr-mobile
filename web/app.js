// Sheep It - the phone client for the SheepIt gateway

(function () {
  let state = {
    agents: [],
    activePaneId: null,
    historyText: "",
    linesCount: 100,
    showStatusBar: false,
    plainView: false,
    diffSplit: false,
    numberKeys: 3,
    badgeCount: -1,
    activity: {},
    drafts: {},
    order: [],
    groups: [],
    pickerOpen: false,
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
    quota: null,
    quotaAt: 0,
    queueOpen: false,
    queueSignature: null,
    editingId: null,
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
  const elKeysNumbers = document.getElementById("keys-numbers");
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
  const elTogglePlain = document.getElementById("toggle-plain");
  const elTogglePush = document.getElementById("toggle-push");
  const elToggleBleat = document.getElementById("toggle-bleat");
  const elPushHint = document.getElementById("push-hint");
  const elBtnQueue = document.getElementById("btn-queue");
  const elQueueBadge = document.getElementById("queue-badge");
  const elQueueView = document.getElementById("queue-view");
  const elBtnCloseQueue = document.getElementById("btn-close-queue");
  const elQuotaStrip = document.getElementById("quota-strip");
  const elPickerQuota = document.getElementById("picker-quota");
  const elTaskList = document.getElementById("task-list");
  const elBtnNewTask = document.getElementById("btn-new-task");
  const elTaskSheet = document.getElementById("task-sheet");
  const elTaskPrompt = document.getElementById("task-prompt");
  const elTaskError = document.getElementById("task-error");
  const elBtnSubmitTask = document.getElementById("btn-submit-task");
  const elBtnCancelTask = document.getElementById("btn-cancel-task");
  const elTaskSheetTitle = document.getElementById("task-sheet-title");
  const elTaskSheetCwd = document.getElementById("task-sheet-cwd");
  const elBtnConsole = document.getElementById("btn-console");
  const elConsoleView = document.getElementById("console-view");
  const elConsoleTerm = document.getElementById("console-term");
  const elConsoleSub = document.getElementById("console-sub");
  const elBtnCloseConsole = document.getElementById("btn-close-console");
  const elBtnConsoleKeyboard = document.getElementById("btn-console-keyboard");
  const elBtnConsoleFit = document.getElementById("btn-console-fit");
  const elBtnChanges = document.getElementById("btn-changes");
  const elChangesView = document.getElementById("changes-view");
  const elChangesList = document.getElementById("changes-list");
  const elChangesSub = document.getElementById("changes-sub");
  const elChangesCount = document.getElementById("changes-count");
  const elBtnCloseChanges = document.getElementById("btn-close-changes");
  const elBtnDiffLayout = document.getElementById("btn-diff-layout");

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
  /* Two agents, two sets of glyphs for the same handful of roles. Claude Code
     marks a turn with "⏺" and a tool result with "⎿"; Codex uses "•" and "└".
     `bol` pins a marker to the left margin: Codex's bullet always starts a
     turn there, while a "•" further in is a list item in somebody's prose. */
  const MARKERS = [
    { re: /^❯/, cls: "user" },        // > user message / live input
    { re: /^⏺/, cls: "assistant" },   // assistant message or tool call
    { re: /^⎿/, cls: "tool" },        // tool result
    { re: /^[✻✽✳]/, cls: "meta" }, // "Worked for 1m 8s"
    { re: /^※/, cls: "tip" },         // tips
    { re: /^⏵⏵/, cls: "status" }, // "auto mode on ..."
    { re: /^›\s/, cls: "user" },      // "› what changed in the indexer?"
    { re: /^•\s/, cls: "assistant", bol: true }, // "• Ran docker compose ps"
    { re: /^[✓✔✗✘]\s/, cls: "meta", bol: true },  // "✔ You approved codex to ..."
    { re: /^└\s/, cls: "tool" },                 // "  └ {"acknowledged":true}"
  ];
  const RE_BOX = /^[┌┐└┘├┤┬┴┼│╭╮╯╰┏┓┗┛┣┫┳┻╋┃║╔╗╚╝╠╣╦╩╬]/;
  // "❯ 2. app.bodyweight.plus", "› 1. Yes, proceed (y)" - one choice in a
  // selection prompt.
  const RE_OPTION = /^\s*[❯›>]?\s*(\d{1,2})\.\s/;
  /* The footer a terminal prints under the prompt it is waiting on: Claude
     Code's "Enter to select", Codex's "Press enter to confirm or esc to
     cancel". RE_PROMPT_HINT is the half only a prompt says - "Esc to cancel"
     on its own is also what an autocomplete menu offers. */
  const RE_PROMPT_HINT = /Enter to select|keys? to navigate|Enter to confirm/i;
  const RE_SELECT_HINT = /Esc to cancel|Esc to reject/i;
  // The composer's own glyph: "❯" in Claude Code, "›" in Codex.
  const RE_COMPOSER = /^[❯›](?:\s|$)/;
  // What a composer shows when nothing has been typed into it.
  const RE_PLACEHOLDER = /^(?:ask codex to do anything|try ".*")$/i;
  /* Codex's footer - its model and the directory it works in - is the only
     thing it prints under the composer. Claude Code closes the box with a
     rule instead, so between them they say where the composer ends. */
  const RE_AGENT_FOOTER = /·\s*[~/]/;
  // Long runs of rule glyphs anywhere in a line, not just whole-line rules.
  const RE_INLINE_RULE = /([─━┄┅┈┉═—–_=*.])\1{7,}/g;
  // Both the composer and a pending prompt sit at the foot of the pane. This
  // far above it, the same glyphs are something the agent printed.
  const TAIL_REACH = 24;

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

  function classifyLine(line, trimmed) {
    if (!trimmed) return null;
    // Markers before boxes: Codex's "└ " tool result would otherwise read as
    // the bottom-left corner of one.
    for (const m of MARKERS) {
      if (m.re.test(m.bol ? line : trimmed)) return m.cls;
    }
    if (RE_BOX.test(trimmed)) return "table";
    if (ruleLabel(trimmed) !== null) return "rule";
    return null; // continuation of whatever came before
  }

  /* The terminal's own furniture at the foot of the pane: the composer, and
     the status bar under it. Claude Code frames the composer in a pair of
     rules and marks it "❯"; Codex prints "›" with nothing around it at all,
     then names its model and cwd.

     Anchoring on that glyph rather than on the last pair of rules is what
     keeps a message whole. A markdown table's separator row is a rule too, so
     taking the last two of those lifted the tail of the agent's answer into
     the input mirror - a strip built for one line - and deleted the rest. */
  function findChrome(raw) {
    let idx = -1;
    for (let i = raw.length - 1; i >= Math.max(0, raw.length - TAIL_REACH); i--) {
      const trimmed = raw[i].trim();
      if (!RE_COMPOSER.test(trimmed)) continue;
      // "❯ 1. Yes, proceed" is a choice being offered, not the composer.
      if (RE_OPTION.test(trimmed)) return null;
      idx = i;
      break;
    }
    if (idx < 0) return null;

    // Claude Code's box: a rule opens it just above the "❯", the next rule
    // closes it, and an autocomplete menu can sit in between.
    let open = -1;
    for (let i = idx - 1; i >= 0 && idx - i <= 3; i--) {
      if (ruleLabel(raw[i].trim()) !== null) { open = i; break; }
      if (raw[i].trim()) break;
    }
    let close = -1;
    if (open >= 0) {
      for (let i = idx + 1; i < raw.length && i - idx <= 12; i++) {
        if (ruleLabel(raw[i].trim()) !== null) { close = i; break; }
      }
    }

    /* The composer is the last thing in the pane, so nothing may stand under
       it but blanks and the agent's own footer. An agent quoting a line back
       - a pasted transcript, the instruction it is acting on - starts it with
       the same glyph, and mistaking that for the composer lifts it into the
       one-line mirror and drops every line below it as chrome. */
    if (close < 0) {
      for (let i = idx + 1; i < raw.length; i++) {
        const trimmed = raw[i].trim();
        if (!trimmed || RE_AGENT_FOOTER.test(trimmed)) continue;
        if (ruleLabel(trimmed) !== null) continue;
        return null;
      }
    }

    const value = raw
      .slice(idx, close >= 0 ? close : idx + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(RE_COMPOSER, "")
      .trim();
    return {
      // The opening rule stays: it carries the session title.
      dropFrom: open >= 0 ? open + 1 : idx,
      dropTo: close >= 0 ? close : idx,
      statusFrom: close >= 0 ? close : idx,
      liveInput: RE_PLACEHOLDER.test(value) ? "" : value,
    };
  }

  /* The prompt an agent has stopped on - a tool confirmation, a plan
     approval, AskUserQuestion. Claude Code frames it in the same pair of
     rules that otherwise frames its composer; Codex frames it in nothing at
     all. So find it by what it says - numbered choices and the footer under
     them - rather than by the furniture around it. Getting this wrong is how
     the question vanishes from the phone entirely. */
  function findSelection(raw) {
    const floor = Math.max(0, raw.length - TAIL_REACH);
    let hintIdx = -1;
    for (let i = floor; i < raw.length; i++) {
      if (RE_PROMPT_HINT.test(raw[i]) || RE_SELECT_HINT.test(raw[i])) hintIdx = i;
    }
    let firstOption = -1;
    let lastOption = -1;
    const labels = new Set();
    for (let i = floor; i <= (hintIdx >= 0 ? hintIdx : raw.length - 1); i++) {
      const m = RE_OPTION.exec(raw[i]);
      if (!m) continue;
      if (firstOption < 0) firstOption = i;
      lastOption = i;
      labels.add(Number(m[1]));
    }
    /* How many choices are on offer - the run of labels from 1, not the
       highest number seen, so a stray "12." in the text above cannot invent
       nine keys that answer nothing. */
    let optionCount = 0;
    while (labels.has(optionCount + 1)) optionCount++;

    /* A footer only a prompt prints is proof by itself. Numbered choices are
       not: an agent listing three things to try mid-run looks exactly like a
       question, and the missing composer is no help - Codex hides its own
       while it works. So they need a footer under them too. */
    const promptFooter = hintIdx >= 0 && RE_PROMPT_HINT.test(raw[hintIdx]);
    if (!promptFooter && !(optionCount >= 2 && hintIdx >= 0)) return null;

    /* Walk up to the head of the prompt: the rule that opens Claude Code's
       box, or - Codex having no box - the line after the last thing the agent
       printed for itself. */
    const head = firstOption >= 0 ? firstOption : hintIdx;
    let start = Math.max(0, head - TAIL_REACH);
    for (let i = head - 1; i >= start; i--) {
      const trimmed = raw[i].trim();
      if (ruleLabel(trimmed) !== null) { start = i; break; }
      if (classifyLine(raw[i], trimmed)) { start = i + 1; break; }
    }
    return { start, end: Math.max(hintIdx, lastOption), optionCount };
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

    const chrome = findChrome(raw);
    const sel = findSelection(raw);
    /* Where the two overlap the prompt wins. A question folded into the input
       mirror is a question nobody ever sees. */
    const box = sel && chrome && chrome.dropFrom <= sel.end ? null : chrome;

    const liveInput = box ? box.liveInput : "";
    const statusFrom = box ? box.statusFrom : -1;

    // The status bar names the current mode; shift+tab cycles through them.
    let mode = "";
    const tail = raw
      .slice(statusFrom >= 0 ? statusFrom : Math.max(0, raw.length - 6))
      .join(" ");
    const m = /\b(auto|plan|manual|accept edits|bypass\w*)\s+mode\b/i.exec(tail);
    if (m) mode = m[1].toLowerCase();

    const blocks = [];
    let current = "assistant";
    raw.forEach((line, i) => {
      /* Drop the composer and everything under it: that is live UI state, not
         conversation, and rendering it as a past user message is how the
         phone ends up arguing with the laptop. */
      if (box && i >= box.dropFrom && i <= box.dropTo) return;

      const trimmed = line.trim();
      let cls = classifyLine(line, trimmed);

      if (sel && i >= sel.start && i <= sel.end) {
        // A rule inside the prompt would break it into several cards.
        if (cls === "rule") { if (i !== sel.start) return; }
        else cls = "select";
      } else if (statusFrom >= 0 && i > statusFrom && cls !== "rule") {
        cls = "status";
      }

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

    return {
      blocks: kept,
      rows,
      liveInput,
      mode,
      optionCount: sel ? sel.optionCount : 0,
    };
  }

  /* What the desktop currently has typed into the pane, mirrored above the
     phone's composer so the two inputs do not look like one. */
  function renderLiveInput(textValue) {
    const show = Boolean(textValue);
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

  /* The pane exactly as it arrived, minus the terminal's own padding: every
     line in the order the agent drew it, coloured by its own escape codes and
     classified as nothing at all.

     The parsed view is a set of guesses - which glyph starts a turn, which
     rules frame the composer, which of the last lines are the status bar - and
     a guess that goes wrong hides something. Most of what it drops is padding
     and furniture, but not all of it: a caption on a rule directly under
     another rule is overwritten by it, a line of the agent's own "=" or "."
     is read as a rule and collapsed, and everything below Claude Code's input
     box - usage warnings, background tasks, errors - is filed under the status
     bar and hidden with it. This view is the answer to "the phone is not
     showing me something": no classification, no collapsing, nothing
     dropped. */
  function plainHtml(rows) {
    return `<div class="t-block t-plain">${rows
      .map((row) => runsToHtml(row.runs))
      .join("\n")}</div>`;
  }

  function renderTranscript(text) {
    if (!text) {
      renderLiveInput("");
      renderNumberKeys(0);
      elHistoryContent.innerHTML =
        '<div class="history-empty">(No output recorded yet)</div>';
      return;
    }

    // Resolve each block to its final text, dropping the ones that render
    // to nothing: an empty input box, or the status bar when hidden.
    const parsed = parseTranscript(text);
    renderLiveInput(parsed.liveInput);
    renderNumberKeys(parsed.optionCount);
    state.mode = parsed.mode;
    elModeCurrent.textContent = parsed.mode || "unknown";

    /* Parsing still runs in the plain view: the keypad, the mode and the input
       mirror are read out of it, and they are as useful when the transcript is
       drawn verbatim as when it is not. Only the drawing changes. */
    if (state.plainView) {
      elHistoryContent.innerHTML = plainHtml(parsed.rows);
      return;
    }

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
      bleatForFinished(state.agents);
      trackActivity();
      orderAgents();
      renderAgentBar();
      updateBadge();

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
    const waiting = state.agents.filter(
      (a) => a.has_agent && WAITING.includes(a.status)
    ).length;
    if (waiting === state.badgeCount) return;
    state.badgeCount = waiting;
    const done = waiting > 0 ? navigator.setAppBadge(waiting) : navigator.clearAppBadge();
    Promise.resolve(done).catch(() => {
      // Permission not granted: badges stay hidden, nothing else breaks.
    });
  }

  // Header button showing the current project
  function renderAgentBar() {
    const agent = state.agents.find((a) => a.pane_id === state.activePaneId);
    elAgentSelectName.textContent = agent
      ? agent.name || agent.pane_id
      : state.agents.length
      ? "Select project"
      : "No agents";
    elAgentSelectDot.className = `agent-dot ${knownStatus(agent && agent.status)}`;

    if (!elAgentPicker.classList.contains("hidden")) renderAgentList();
  }

  /* One sheep per project, the same animal the home screen icon shows. Colour
     carries the status, but so does the posture: an agent that is working
     grazes, one that is idle stands with its head up, a blocked one pricks its
     ear at you, and a finished one lies down to sleep. A pane with no agent is
     an empty pasture - no sheep at all. Drawn inline so the fleece can inherit
     the row's colour instead of shipping five copies of the file. */
  const POSE = {
    working: "graze",
    idle: "stand",
    done: "sleep",
    blocked: "alert",
    unknown: "empty",
  };

  /* ------------------------------------------------------- Telling them apart
   *
   * Status is a colour and a posture, and two agents working on the same
   * project are therefore the same animal twice. A shepherd has this problem
   * too and solved it long before software did: every sheep wears a numbered
   * ear tag, and you learn the markings on the ones you look at daily.
   *
   * So each pane gets its own: a tag colour, a patch of darker fleece, and the
   * shade of its face, all hashed out of the pane id. It is deterministic -
   * the same pane is the same sheep across a reload, a restart, and this
   * phone's whole life - and it is drawn in the space status does not use.
   * Status stays the fleece and the pose; identity is the small stuff.
   * ------------------------------------------------------------------------ */

  /* FNV-1a, because the ids being hashed are short and nearly identical -
     "wE:p1" and "wJ:p1" differ in one character, and a weaker hash hands them
     the same tag. */
  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /* Tag colours, chosen to stay apart from each other at the size of a pip and
     to sit on any fleece: a sheep's status colour is the whole animal, so the
     tag never has to compete with it. */
  const TAGS = [
    "#ff7ab6", "#ff9f45", "#ffd43b", "#9ae64c", "#3ddc97", "#2ec4d6",
    "#4d9dff", "#8b7bff", "#c77dff", "#ff6b6b", "#d9b38c", "#7de3ff",
  ];

  // Patches of darker fleece. Ink over whatever colour the status painted.
  const PATCH = {
    a: '<circle cx="13.5" cy="17.5" r="3.2"/>',
    b: '<circle cx="21" cy="14.5" r="2.6"/>',
    c: '<circle cx="26.5" cy="18.5" r="2.8"/>',
    d: '<circle cx="17" cy="20.5" r="2.4"/>',
  };
  const FLEECES = [[], ["a"], ["c"], ["a", "c"], ["b", "d"], ["a", "b"], ["c", "d"], ["a", "b", "c"]];

  // Face shades a breed might come in. All stay light enough for a dark eye.
  const FACES = ["#dfe5f0", "#cbb392", "#a7b0c2"];

  function sheepMarks(seed) {
    const hash = fnv1a(String(seed || ""));
    return {
      tag: TAGS[hash % TAGS.length],
      fleece: FLEECES[(hash >>> 5) % FLEECES.length],
      face: FACES[(hash >>> 11) % FACES.length],
    };
  }

  function sheepBody(dy, legs, marks) {
    const patches = marks.fleece.map((key) => PATCH[key]).join("");
    return `
      <g transform="translate(0 ${dy})">
        <g fill="currentColor">
          ${legs ? '<rect x="11" y="21" width="5" height="12" rx="2.5"/>' : ""}
          ${legs ? '<rect x="23" y="21" width="5" height="12" rx="2.5"/>' : ""}
          <circle cx="11.5" cy="16" r="7.5"/>
          <circle cx="18" cy="11" r="8"/>
          <circle cx="25.5" cy="11.5" r="7.5"/>
          <circle cx="31" cy="16" r="7"/>
          <rect x="5" y="13" width="27" height="13" rx="6.5"/>
        </g>
        <g fill="#05070c" opacity="0.22">${patches}</g>
      </g>`;
  }

  /* Each pose puts the ear somewhere else, so the tag hanging from it is part
     of the pose rather than something laid over the top. */
  const HEADS = {
    // Head down in the grass.
    graze: (m) => `
      <ellipse class="sheep-ear" cx="33.2" cy="15.2" rx="3" ry="1.8" transform="rotate(-42 33.2 15.2)"/>
      <circle class="sheep-tag" cx="34.6" cy="13.6" r="2.1" style="fill:${m.tag}"/>
      <ellipse class="sheep-face" cx="36.6" cy="19.4" rx="5.4" ry="4.6" style="fill:${m.face}"/>
      <circle class="sheep-eye" cx="38.2" cy="18" r="1.2"/>`,
    // Head up, ear resting: done, waiting on you.
    stand: (m) => `
      <ellipse class="sheep-ear" cx="32.4" cy="9" rx="3" ry="1.8" transform="rotate(-38 32.4 9)"/>
      <circle class="sheep-tag" cx="33.6" cy="7.2" r="2.1" style="fill:${m.tag}"/>
      <ellipse class="sheep-face" cx="36.4" cy="12.6" rx="5.4" ry="4.6" style="fill:${m.face}"/>
      <circle class="sheep-eye" cx="38.2" cy="11.4" r="1.2"/>`,
    // Ear pricked straight up: something is asking for an answer.
    alert: (m) => `
      <ellipse class="sheep-ear" cx="33.6" cy="6.2" rx="3.2" ry="1.7" transform="rotate(-72 33.6 6.2)"/>
      <circle class="sheep-tag" cx="34.4" cy="3.6" r="2.1" style="fill:${m.tag}"/>
      <ellipse class="sheep-face" cx="36.8" cy="10.2" rx="5.4" ry="4.6" style="fill:${m.face}"/>
      <circle class="sheep-eye" cx="38.6" cy="8.8" r="1.3"/>`,
    // Lying down, eye shut, legs folded under.
    sleep: (m) => `
      <ellipse class="sheep-ear" cx="32.6" cy="20.4" rx="3" ry="1.8" transform="rotate(-30 32.6 20.4)"/>
      <circle class="sheep-tag" cx="33.4" cy="18.4" r="2.1" style="fill:${m.tag}"/>
      <ellipse class="sheep-face" cx="36.4" cy="24.6" rx="5.4" ry="4.6" style="fill:${m.face}"/>
      <path class="sheep-lid" d="M36.4 24.2 q1.6 1.4 3.2 0"/>`,
  };

  /* Nobody home: bare ground where the sheep would stand. Quieter than the
     animals on purpose - it marks the rows with nothing running. */
  const EMPTY_PASTURE = `
      <path d="M2 24 C 10 19, 20 19, 26 22 C 32 25, 38 23, 42 20 L42 32 L2 32 Z"
            fill="currentColor" opacity="0.32"/>
      <path d="M2 24 C 10 19, 20 19, 26 22 C 32 25, 38 23, 42 20" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
      <path d="M11 20 q0.6 -3 2.4 -4.4" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
      <path d="M33 20.6 q-0.8 -2.6 -2.4 -3.8" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>`;

  /* The statuses the app has a sheep, a colour and a class for - anything else
     Herdr grows later reads as unknown rather than an unstyled dot or a sheep
     that is not there. POSE is a plain object, so ask it what it owns:
     POSE["constructor"] is truthy and would draw nothing at all. */
  function knownStatus(status) {
    return Object.prototype.hasOwnProperty.call(POSE, status) ? status : "unknown";
  }

  function sheepSvg(status, seed) {
    const pose = POSE[knownStatus(status)];
    // An empty pasture has nobody to tell apart.
    if (pose === "empty") {
      return `<svg class="sheep" viewBox="0 0 44 34" aria-hidden="true">${EMPTY_PASTURE}</svg>`;
    }
    const marks = sheepMarks(seed);
    const asleep = pose === "sleep";
    return `
      <svg class="sheep" viewBox="0 0 44 34" aria-hidden="true">
        ${sheepBody(asleep ? 5 : 0, !asleep, marks)}
        ${HEADS[pose](marks)}
      </svg>`;
  }

  /* Everything a row draws. The picker is redrawn on every poll, and replacing
     its HTML restarts each sheep's graze mid-cycle and throws away the row a
     swipe is holding open - so redraw only when one of these actually moved. */
  function agentListSignature() {
    return state.groups
      .map((group) =>
        [
          group.key,
          group.name,
          ...group.agents.map((a) =>
            [
              a.pane_id,
              a.workspace_id,
              a.status,
              a.name,
              a.title || a.cwd,
              agoLabel(a.pane_id),
              a.pane_id === state.activePaneId ? "1" : "",
            ].join("\u001f")
          ),
        ].join("\u001e")
      )
      .join("\u001d");
  }

  /* A row under a heading that already names the project should not spend its
     biggest line saying the project again. What you are looking for is which
     of this project's agents this one is - so the terminal title leads, since
     it is whatever you asked it to do, and the workspace label drops to the
     small line, and only when it says something the heading did not: "sheep
     #5", or a name you set by hand. */
  function agentRowHtml(agent, groupName) {
    const isActive = agent.pane_id === state.activePaneId;
    const status = knownStatus(agent.status);
    const label = agent.name || agent.pane_id;
    const headline = agent.title || label;
    let sub = "";
    if (label !== headline && label !== groupName) sub = label;
    else if (!agent.title) sub = agent.cwd || "";
    return `
      <div class="agent-row-wrap">
        <button class="agent-row-delete" data-workspace-id="${escapeHtml(agent.workspace_id)}">Close</button>
        <button class="agent-row ${isActive ? "active" : ""}" data-pane-id="${escapeHtml(agent.pane_id)}">
          <span class="sheep-wrap ${status}">${sheepSvg(status, agent.pane_id)}</span>
          <span class="agent-row-text">
            <span class="agent-row-name">${escapeHtml(headline)}</span>
            ${sub ? `<span class="agent-row-title">${escapeHtml(sub)}</span>` : ""}
          </span>
          <span class="agent-row-side">
            <span class="status-badge status-${status}">${escapeHtml(agent.status || "unknown")}</span>
            <span class="agent-row-ago">${escapeHtml(agoLabel(agent.pane_id))}</span>
          </span>
        </button>
      </div>
    `;
  }

  /* The full-screen overview: a heading per project, that project's own sheep
     under it. The heading counts the ones asking you something, because that
     is the number the list was opened to find. */
  function renderAgentList() {
    if (state.agents.length === 0) {
      state.listSignature = null;
      elAgentList.innerHTML = '<div class="history-empty">No active agents in Herdr.</div>';
      return;
    }

    // Never under the thumb: a rebuild would snap a swiped row shut.
    if (state.swiping || elAgentList.querySelector(".agent-row.swiped")) return;
    const signature = agentListSignature();
    if (signature === state.listSignature) return;
    state.listSignature = signature;

    elAgentList.innerHTML = state.groups
      .map((group) => {
        const waiting = group.agents.filter(wantsInput).length;
        const tally = waiting
          ? `<span class="agent-group-waiting">${waiting} waiting</span>`
          : `<span class="agent-group-count">${group.agents.length}</span>`;
        return `
          <section class="agent-group">
            <h2 class="agent-group-head">
              <span class="agent-group-name">${escapeHtml(group.name)}</span>
              ${tally}
            </h2>
            ${group.agents.map((a) => agentRowHtml(a, group.name)).join("")}
          </section>`;
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
    state.pickerOpen = true;
    renderAgentList();
    renderQuota();
    fetchQuota();
    elAgentPicker.classList.remove("hidden");
  }

  function closePicker() {
    state.pickerOpen = false;
    elAgentPicker.classList.add("hidden");
  }

  // Select an Agent
  function selectAgent(paneId) {
    if (state.activePaneId === paneId) {
      closePicker();
      return;
    }
    closePicker();
    setCtrlCArmed(false);
    // What is in the composer was written for the pane being left.
    rememberDraft(state.activePaneId);
    touchAgent(paneId);
    state.activePaneId = paneId;
    restoreDraft(paneId);
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

    const status = knownStatus(agent.status);
    elAgentStatus.className = `status-badge status-${status}`;
    elAgentStatus.textContent = agent.status || "unknown";
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

  /* Send a prompt - which means queue it. There is deliberately only one path:
     into a free chat with usage left this lands within the second, and into a
     busy one or an empty window it waits, without you having to know which of
     those you were in when you typed it. */
  async function submitPrompt(e) {
    if (e) e.preventDefault();
    const text = elPromptInput.value.trim();
    if (!text || !state.activePaneId || state.isSending) return;

    state.isSending = true;
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

      // Success: the draft has become the agent's problem.
      clearDraft(state.activePaneId);
      elPromptInput.value = "";
      hideCompletions();
      autoResizeTextarea();
      elBtnSend.disabled = true;

      state.isUserScrolledUp = false;
      // The badge should show it the moment it is queued, whether or not it
      // has been handed over yet.
      fetchQueue();
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

  /* ------------------------------------------------------------- Queue --- */

  /* A queued prompt is either still ours or it never made it. Delivered ones
     are filtered out in fetchQueue and never reach this list. */
  const QUEUE_WORD = {
    waiting: "waiting",
    failed: "failed",
  };

  function quotaIsStale() {
    return Date.now() - state.quotaAt > 30000;
  }

  async function fetchQueue() {
    try {
      const res = await fetch("/api/queue");
      const data = await res.json();
      if (!data.ok) return;
      /* What the queue shows is what is still owed: prompts holding for a
         window or a busy chat, plus anything that failed and is going nowhere.
         A delivered prompt belongs to the conversation now - it is in the
         transcript, and leaving it here only buries what still needs you. */
      state.queue = (data.prompts || []).filter((p) => p.state !== "sent");
      renderQueueBadge();
      if (state.queueOpen) renderTaskList();
    } catch (err) {
      /* The connection dot already says the gateway is unreachable; a failed
         queue poll should not also blank the list you were reading. */
    }
  }

  async function fetchQuota() {
    if (!quotaIsStale()) return;
    try {
      const res = await fetch("/api/queue/quota");
      state.quota = await res.json();
      state.quotaAt = Date.now();
      if (state.queueOpen || state.pickerOpen) renderQuota();
    } catch (err) {
      /* keep the last reading */
    }
  }

  function renderQueueBadge() {
    const n = state.queue.length;
    elQueueBadge.textContent = String(n);
    elQueueBadge.classList.toggle("hidden", n === 0);
  }

  function relTime(iso) {
    if (!iso) return "";
    const secs = (new Date(iso).getTime() - Date.now()) / 1000;
    if (secs <= 0) return "now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  }

  /* How much subscription is left. The queue shows it because it decides what
     it may start, and the overview shows it because it is the same question
     asked about the herd already running: what is there left to spend. */
  function quotaHtml() {
    const q = state.quota;
    if (!q) return '<div class="quota-note">Reading usage…</div>';
    if (q.ok === false) {
      return `<div class="quota-note blocked">${escapeHtml(q.error || "usage unavailable")}</div>`;
    }

    /* Buckets that are empty and have no window carry no information - they
       are plan slots this account does not use. */
    const shown = (q.buckets || []).filter((b) => b.utilization > 0 || b.resets_at);
    const rows = shown
      .map((b) => {
        const pct = Math.max(0, Math.min(100, b.utilization));
        const near = pct >= q.threshold * 0.8;
        const cls = b.blocking ? "over" : near ? "warn" : "";
        const name = b.name.replace(/_/g, " ");
        return `
          <div class="quota-row ${cls}">
            <span class="quota-name">${escapeHtml(name)}</span>
            <span class="quota-track"><span class="quota-fill" style="width:${pct}%"></span></span>
            <span class="quota-pct">${pct.toFixed(0)}%</span>
          </div>`;
      })
      .join("");

    const note = q.blocked
      ? `<div class="quota-note blocked">No usage left — next window in ${escapeHtml(relTime(q.resume_at))}</div>`
      : `<div class="quota-note">Clear to run · pauses at ${q.threshold.toFixed(0)}%</div>`;

    return rows + note + (q.stale
      ? '<div class="quota-note">cached — could not reach the usage endpoint</div>'
      : "");
  }

  // Both strips carry the same reading; whichever view is up draws it.
  function renderQuota() {
    const html = quotaHtml();
    elQuotaStrip.innerHTML = html;
    elPickerQuota.innerHTML = html;
  }

  // Which chat a prompt is queued for, named the way the picker names it.
  function chatName(paneId) {
    const agent = state.agents.find((a) => a.pane_id === paneId);
    return agent ? agent.name || paneId : paneId;
  }

  // Same trick as the project list: only redraw when something actually moved.
  function queueSignature() {
    return state.queue
      .map((p) => [p.id, p.state, p.pane_id, p.last_error].join(""))
      .join("");
  }

  function renderTaskList() {
    if (state.queue.length === 0) {
      state.queueSignature = null;
      elTaskList.innerHTML =
        '<div class="history-empty">Nothing queued. Tap New to queue a prompt.</div>';
      return;
    }
    const signature = queueSignature();
    if (signature === state.queueSignature) return;
    state.queueSignature = signature;

    elTaskList.innerHTML = state.queue
      .map((p) => {
        const word = QUEUE_WORD[p.state] || p.state;
        const failed = p.state === "failed";
        /* Opening the chat is the only way to clear a prompt stuck behind a
           question, so it is offered on every row: the transcript and the key
           palette are both there. */
        return `
          <div class="task-row ${failed ? "attention" : ""}">
            <span class="task-main">
              <span class="task-prompt">${escapeHtml(p.prompt || "")}</span>
              <span class="task-meta">${escapeHtml(chatName(p.pane_id))}</span>
              ${failed && p.last_error
                  ? `<span class="task-why">${escapeHtml(p.last_error)}</span>`
                  : ""}
            </span>
            <span class="task-side">
              <span class="status-badge status-${escapeHtml(p.state)}">${escapeHtml(word)}</span>
              <span class="task-acts">
                <button class="task-act accent" data-task-open="${escapeHtml(p.pane_id)}">Open</button>
                ${p.state === "waiting"
                    ? `<button class="task-act" data-task-edit="${p.id}">Edit</button>`
                    : ""}
                <button class="task-act danger" data-task-delete="${p.id}">Delete</button>
              </span>
            </span>
          </div>`;
      })
      .join("");
  }

  async function taskAction(id, action) {
    triggerHaptic();
    try {
      const res = await fetch(`/api/queue/${id}/${action}`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "failed");
      state.queueSignature = null;
      await fetchQueue();
    } catch (err) {
      alert(`Could not ${action} prompt: ${err.message}`);
    }
  }

  function openQueue() {
    triggerHaptic();
    state.queueOpen = true;
    state.queueSignature = null;
    elQueueView.classList.remove("hidden");
    renderQuota();
    renderTaskList();
    fetchQueue();
    fetchQuota();
  }

  function closeQueue() {
    state.queueOpen = false;
    elQueueView.classList.add("hidden");
  }

  /* The chat a new prompt is aimed at: whichever one you are looking at. That
     is the whole targeting model - there is no project to pick, because the
     session already sits in one. */
  function queueTarget(prompt) {
    return prompt ? prompt.pane_id : state.activePaneId;
  }

  async function openTaskSheet(prompt) {
    triggerHaptic();
    state.editingId = prompt ? prompt.id : null;
    elTaskError.classList.add("hidden");
    elTaskSheetTitle.textContent = prompt ? "Edit queued prompt" : "Queue a prompt";
    elTaskSheetCwd.textContent = queueTarget(prompt)
      ? `for ${chatName(queueTarget(prompt))}, when it is free`
      : "pick a chat first";
    elBtnSubmitTask.textContent = prompt ? "Save" : "Queue it";
    elTaskPrompt.value = prompt ? prompt.prompt || "" : "";

    elSheetBackdrop.classList.add("over-queue");
    elSheetBackdrop.classList.remove("hidden");
    elTaskSheet.classList.remove("hidden");
    if (!prompt) elTaskPrompt.focus();
  }

  function closeTaskSheet() {
    elTaskSheet.classList.add("hidden");
    elSheetBackdrop.classList.add("hidden");
    elSheetBackdrop.classList.remove("over-queue");
  }

  async function submitTask() {
    const prompt = elTaskPrompt.value.trim();
    if (!prompt) {
      showTaskError("Say what it should do.");
      return;
    }
    const editing = state.editingId;
    const paneId = editing ? null : state.activePaneId;
    if (!editing && !paneId) {
      showTaskError("Pick a chat to queue this for.");
      return;
    }
    const url = editing ? `/api/queue/${editing}/update` : "/api/queue";
    elBtnSubmitTask.disabled = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { prompt } : { prompt, pane_id: paneId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "could not save");
      elTaskPrompt.value = "";
      closeTaskSheet();
      state.queueSignature = null;
      await fetchQueue();
    } catch (err) {
      showTaskError(err.message);
    } finally {
      elBtnSubmitTask.disabled = false;
    }
  }
  function showTaskError(message) {
    elTaskError.textContent = message;
    elTaskError.classList.remove("hidden");
  }

  /* Hand a task's pane to the main view, so its question can be answered with
     the key palette that is already there. */
  function openTaskPane(paneId) {
    closeQueue();
    if (state.agents.some((a) => a.pane_id === paneId)) {
      selectAgent(paneId);
    } else {
      /* The pane exists but Herdr has not listed it yet, or it is gone. Select
         it anyway: the transcript fetch will say which. */
      state.activePaneId = paneId;
      state.historyText = "";
      fetchHistory(true);
    }
  }

  elBtnQueue.addEventListener("click", openQueue);
  elBtnCloseQueue.addEventListener("click", closeQueue);
  elBtnNewTask.addEventListener("click", () => openTaskSheet(null));
  elBtnCancelTask.addEventListener("click", closeTaskSheet);
  elBtnSubmitTask.addEventListener("click", submitTask);

  elTaskList.addEventListener("click", (e) => {
    const open = e.target.closest("[data-task-open]");
    if (open) return openTaskPane(open.dataset.taskOpen);
    const edit = e.target.closest("[data-task-edit]");
    if (edit) {
      const queued = state.queue.find((p) => String(p.id) === edit.dataset.taskEdit);
      if (queued) openTaskSheet(queued);
      return;
    }
    const del = e.target.closest("[data-task-delete]");
    if (del) return taskAction(del.dataset.taskDelete, "delete");
  });

  // Poll loop
  async function loop() {
    await fetchAgents();
    await fetchHistory();
    // Cheap: a local SQLite read. Keeps the header badge honest even when the
    // queue is closed.
    await fetchQueue();
    if (state.queueOpen || state.pickerOpen) await fetchQuota();
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
      const lines = parseInt(readPref("lines"), 10);
      if (lines) {
        state.linesCount = lines;
        elLinesSelect.value = String(lines);
      }
      state.showStatusBar = readPref("statusbar") === "1";
      elToggleStatusBar.checked = state.showStatusBar;
      state.plainView = readPref("plain") === "1";
      elTogglePlain.checked = state.plainView;
      setDiffLayout(readPref("diffsplit") === "1");
      syncStatusBarRow();
      setKeysBar(readPref("keys") !== "0");
      state.activity = loadActivity();
      state.drafts = loadDrafts();
      state.bleat = readPref("bleat") !== "0";
      elToggleBleat.checked = state.bleat;
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

  function loadDrafts() {
    try {
      const raw = JSON.parse(readPref("drafts") || "{}");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function saveDrafts() {
    const entries = Object.entries(state.drafts);
    if (entries.length > MAX_DRAFTS) {
      // Oldest first: the map is written in touch order, so the tail is the
      // recently used end.
      state.drafts = Object.fromEntries(entries.slice(-MAX_DRAFTS));
    }
    try {
      savePref(DRAFTS_KEY, JSON.stringify(state.drafts));
    } catch (err) {
      // A full or disabled localStorage must not stop anybody typing.
    }
  }

  /* Remember what is in the composer now, against the pane it belongs to.
     Called as you type, and again before the pane changes under it. */
  function rememberDraft(paneId) {
    const id = paneId || state.activePaneId;
    if (!id) return;
    const text = elPromptInput.value;
    if (text.trim()) {
      // Re-inserting keeps the key at the recent end of the map.
      delete state.drafts[id];
      state.drafts[id] = { text, caret: elPromptInput.selectionStart ?? text.length };
    } else if (state.drafts[id]) {
      delete state.drafts[id];
    } else {
      return;
    }
    saveDrafts();
  }

  function restoreDraft(paneId) {
    const draft = state.drafts[paneId];
    elPromptInput.value = draft ? draft.text : "";
    autoResizeTextarea();
    if (!draft) return;
    // Put the caret back where it was, so a half-typed word can be finished
    // rather than found.
    const caret = Math.min(draft.caret ?? draft.text.length, draft.text.length);
    try {
      elPromptInput.setSelectionRange(caret, caret);
    } catch (err) {
      // Not focused, or a browser that refuses: the text is what matters.
    }
  }

  function clearDraft(paneId) {
    if (!paneId || !state.drafts[paneId]) return;
    delete state.drafts[paneId];
    saveDrafts();
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
        // so the stamp orders the list but carries no time to show.
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
   * The single exception is an agent stopped on a question. It is the only
   * state that goes nowhere at all without you, so it rises to the top of its
   * project and carries its project to the top of the list.
   * ------------------------------------------------------------------------ */

  /* When a row was created, as a number that only ever grows. Herdr numbers
     workspaces in the order they were opened and never renumbers them, and a
     pane's own index orders the several agents one workspace can hold. */
  function bornAt(agent) {
    const ws = Number(agent.workspace_number);
    const pane = Number((agent.pane_id || "").split(":p")[1]) || 0;
    return (Number.isFinite(ws) ? ws : Number.MAX_SAFE_INTEGER) * 1000 + pane;
  }

  // The one thing nothing moves off without you: an agent asking a question.
  function wantsInput(agent) {
    return agent.has_agent && agent.status === "blocked";
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
        group = { key, name: agent.project_name || agent.name || key, agents: [] };
        groups.set(key, group);
      }
      group.agents.push(agent);
    }
    return [...groups.values()];
  }

  function orderAgents() {
    /* Never reshuffle a list somebody is looking at: an agent changing state
       would slide a row out from under the thumb about to tap it. Hold the
       last order until the picker closes. */
    const held = !elAgentPicker.classList.contains("hidden") && state.order.length;
    if (held) {
      const rank = new Map(state.order.map((id, i) => [id, i]));
      const at = (id) => (rank.has(id) ? rank.get(id) : Number.MAX_SAFE_INTEGER);
      state.agents.sort((a, b) => at(a.pane_id) - at(b.pane_id));
      // A pane that appeared while you were reading joins its own project at
      // the end, rather than being stranded below every group.
      state.groups = groupByProject(state.agents);
      return;
    }

    const groups = groupByProject(state.agents);
    for (const group of groups) {
      group.agents.sort(
        (a, b) => Number(wantsInput(b)) - Number(wantsInput(a)) || bornAt(a) - bornAt(b)
      );
      group.wants = group.agents.some(wantsInput);
      group.born = Math.min(...group.agents.map(bornAt));
    }
    groups.sort((a, b) => Number(b.wants) - Number(a.wants) || a.born - b.born);

    state.groups = groups;
    state.agents = groups.flatMap((g) => g.agents);
    state.order = state.agents.map((a) => a.pane_id);
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
    const secs = Math.max(0, Math.round((Date.now() - rec.ts) / 1000));
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
    state.swiping = true; // hold the redraw until the finger is off the row
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
    state.swiping = false;
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

  // A call or a notification cancels the touch: do not hold the redraw for good.
  elAgentList.addEventListener("touchcancel", () => {
    state.swiping = false;
    swipe = null;
  }, { passive: true });

  elBtnNewWorkspace.addEventListener("click", createWorkspace);

  elBtnRefresh.addEventListener("click", () => {
    triggerHaptic();
    loop();
  });

  elBtnSettings.addEventListener("click", openSheet);
  elBtnCloseSheet.addEventListener("click", closeSheet);
  /* One backdrop serves both sheets, so it has to dismiss whichever is up -
     closing only the settings sheet left the task sheet stranded on screen
     with nothing behind it to tap. */
  elSheetBackdrop.addEventListener("click", () => {
    if (!elTaskSheet.classList.contains("hidden")) closeTaskSheet();
    else closeSheet();
  });

  elHistoryContainer.addEventListener("scroll", onHistoryScroll, { passive: true });
  elBtnScrollBottom.addEventListener("click", () => scrollToBottom(true));

  elPromptInput.addEventListener("input", () => {
    autoResizeTextarea();
    scheduleCompletion();
    rememberDraft();
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

  elBtnEsc.addEventListener("click", () => sendKey("esc", elBtnEsc));

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
    savePref("sheepit.lines", String(state.linesCount));
    fetchHistory(true);
  });

  // Key palette: the single keypresses agents ask for at confirmation prompts.
  function setKeysBar(show) {
    state.showKeys = show;
    elKeysBar.classList.toggle("hidden", !show);
    elBtnKeys.classList.toggle("active", show);
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

  elToggleStatusBar.addEventListener("change", (e) => {
    state.showStatusBar = e.target.checked;
    savePref("sheepit.statusbar", state.showStatusBar ? "1" : "0");
    renderTranscript(state.historyText);
    scrollToBottom();
  });

  /* The plain view already draws the status bar, so the toggle for it has
     nothing left to say - grey it out rather than leave a switch that does
     nothing when flicked. */
  function syncStatusBarRow() {
    elToggleStatusBar.disabled = state.plainView;
    const row = elToggleStatusBar.closest(".sheet-row");
    if (row) row.classList.toggle("row-muted", state.plainView);
  }

  elTogglePlain.addEventListener("change", (e) => {
    state.plainView = e.target.checked;
    savePref("sheepit.plain", state.plainView ? "1" : "0");
    syncStatusBarRow();
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

     The transcript above is a reading of a pane: parsed into turns, with the
     furniture taken off. Sometimes you want the pane itself - a full-screen
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

  const consoleState = {
    term: null, ws: null, paneId: null, scrollAcc: 0, cols: 80, rows: 24,
    loading: null, cellHeight: CELL_HEIGHT,
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
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
  }

  function sendConsoleControl(message) {
    const ws = consoleState.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /* Herdr owns the scrollback, so a gesture here is a request, not a local
     move: wheel notches and finger drags both become lines for it to scroll. */
  function attachConsoleScroll() {
    elConsoleTerm.addEventListener(
      "wheel",
      (e) => {
        if (!consoleState.ws) return;
        e.preventDefault();
        consoleState.scrollAcc += e.deltaY;
        const lines = Math.trunc(consoleState.scrollAcc / 40);
        if (!lines) return;
        consoleState.scrollAcc -= lines * 40;
        sendConsoleControl({
          type: "scroll",
          direction: lines < 0 ? "up" : "down",
          lines: Math.min(20, Math.abs(lines)),
        });
      },
      { passive: false }
    );

    let touchY = null;
    elConsoleTerm.addEventListener("touchstart", (e) => {
      touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    }, { passive: true });
    elConsoleTerm.addEventListener("touchmove", (e) => {
      if (touchY === null || !consoleState.ws) return;
      const y = e.touches[0].clientY;
      const moved = touchY - y;
      // A tap that drifts is still a tap; only a real drag scrolls.
      if (Math.abs(moved) < 24) return;
      touchY = y;
      sendConsoleControl({
        type: "scroll",
        direction: moved < 0 ? "up" : "down",
        lines: Math.min(10, Math.max(1, Math.round(Math.abs(moved) / 24))),
      });
    }, { passive: true });
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
      pinConsoleBottom();
      return;
    }
    const box = consoleBox();
    if (!box) return;
    const byWidth = box.width / (cols * CELL_WIDTH);
    const byHeight = box.height / (rows * consoleState.cellHeight);
    const size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.min(byWidth, byHeight)));
    term.options.fontSize = Math.round(size * 10) / 10;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    setConsoleSub(`${cols}×${rows} · ${term.options.fontSize}px`);
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
    setConsoleSub(`${cols}×${rows} · ${rounded}px`);
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
  function requestFit() {
    const size = phoneSize();
    if (size) sendConsoleControl({ type: "resize", ...size });
  }

  /* The keyboard takes half the screen, and re-fitting a 43-row pane into what
     is left would put the font somewhere near six pixels. So while it is open
     the size is left alone and the terminal is scrolled to its bottom instead -
     which is where the prompt you are typing at lives. */
  function keyboardOpen() {
    const vv = window.visualViewport;
    return Boolean(vv && vv.height < window.innerHeight * 0.75);
  }

  function pinConsoleBottom() {
    elConsoleTerm.scrollTop = elConsoleTerm.scrollHeight;
  }

  function fitConsole() {
    if (elConsoleView.classList.contains("hidden")) return;
    if (keyboardOpen()) {
      pinConsoleBottom();
      return;
    }
    showPaneSize(consoleState.cols, consoleState.rows);
  }

  function setConsoleSub(text) {
    elConsoleSub.textContent = text;
  }

  async function openConsole() {
    if (!state.activePaneId) return;
    triggerHaptic();
    elConsoleView.classList.remove("hidden");
    setConsoleSub("loading…");
    if (!(await loadTerminalLibrary())) {
      setConsoleSub("could not load the terminal");
      return;
    }
    // Closed again while it was loading: do not attach behind their back.
    if (elConsoleView.classList.contains("hidden")) return;
    const term = ensureTerminal();
    if (!term) {
      setConsoleSub("terminal unavailable");
      return;
    }
    // A different pane is a different terminal: drop what is on screen rather
    // than drawing the new pane's frames over the old pane's.
    if (consoleState.paneId !== state.activePaneId) {
      term.reset();
      consoleState.paneId = state.activePaneId;
    }
    fitConsole();
    term.focus();
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
    ws.onopen = () => setConsoleSub("attached");
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // The only text the gateway sends is a failure it could not report as
        // a status code, the socket having already been upgraded.
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "size") showPaneSize(msg.cols, msg.rows);
          else if (msg.type === "error") setConsoleSub(msg.message || "error");
        } catch (err) {
          /* not ours */
        }
        return;
      }
      term.write(new Uint8Array(event.data));
      if (keyboardOpen()) pinConsoleBottom();
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
    closeConsoleSocket();
    // Polling stopped while the console had the screen; it is the transcript's
    // turn again.
    startPolling();
    loop();
  }

  elBtnConsole.addEventListener("click", () => {
    stopPolling();
    openConsole();
  });
  elBtnCloseConsole.addEventListener("click", closeConsole);
  elBtnConsoleKeyboard.addEventListener("click", () => {
    if (consoleState.term) consoleState.term.focus();
  });
  elBtnConsoleFit.addEventListener("click", requestFit);
  window.addEventListener("resize", fitConsole);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitConsole);
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
    elChangesList.innerHTML = data.files
      .map((file) => {
        const name = file.path.split("/").pop();
        const dir = file.path.slice(0, file.path.length - name.length);
        const counts = file.binary
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

  async function toggleDiff(row) {
    const body = row.parentElement.querySelector(".diff-body");
    if (!body.classList.contains("hidden")) {
      body.classList.add("hidden");
      row.classList.remove("open");
      return;
    }
    row.classList.add("open");
    body.classList.remove("hidden");
    if (body.getAttribute("data-patch") !== null) return;
    body.innerHTML = '<div class="diff-loading">Reading…</div>';
    const path = row.getAttribute("data-path");
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

  elBtnChanges.addEventListener("click", openChanges);
  elBtnCloseChanges.addEventListener("click", () => {
    elChangesView.classList.add("hidden");
  });
  elBtnDiffLayout.addEventListener("click", () => setDiffLayout(!state.diffSplit));
  elChangesList.addEventListener("click", (e) => {
    const row = e.target.closest(".change-row");
    if (row) toggleDiff(row);
  });

  // Init
  loadPrefs();
  // The first touch anywhere is what buys the page the right to make noise.
  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("touchstart", unlockAudio, { once: true });
  autoResizeTextarea();
  loop();
  startPolling();
})();
