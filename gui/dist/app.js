// mux — UI logic.
//
// Four responsibilities:
//   1. keep one xterm.js instance per terminal, alive across view switches
//   2. keep the sidebar buttons in sync with what Rust reports
//   3. tell Rust where to put the native browser webview, since it does not
//      flow with the DOM
//   4. be the window frame — the OS decorations are off, so dragging and the
//      minimise/maximise/close buttons are ours

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The new-tab page reports an empty address, so the bar shows its placeholder
// instead of an internal asset path.
const HOME_PAGE = "";

const els = {
  list: document.getElementById("list"),
  newBtn: document.getElementById("new-btn"),
  host: document.getElementById("term-host"),
  slot: document.getElementById("browser-slot"),
  url: document.getElementById("url"),
  err: document.getElementById("err"),
  errText: document.getElementById("err-text"),
  app: document.querySelector(".app"),
  browserPanel: document.getElementById("browser-panel"),
  browserBar: document.getElementById("browser-bar"),
  browserBtn: document.getElementById("browser-btn"),
  rowMenu: document.getElementById("row-menu"),
  filter: document.getElementById("filter"),
  titlebar: document.getElementById("titlebar"),
  updateChip: document.getElementById("update-chip"),
  winMaxIcon: document.getElementById("win-max-icon"),
};

/** Ctrl+scroll adjusts this, which is the whole of the font UI. */
let fontSize = 13;

/** Substring typed into the rail's search box. */
let filterText = "";

/** Surface a failure instead of swallowing it into the console. */
function showError(where, e) {
  const msg = e && e.message ? e.message : String(e);
  console.error(where, e);
  if (els.errText) {
    els.errText.textContent = `${where}: ${msg}`;
    els.err.hidden = false;
  }
  // Also to disk: a release build has no devtools, so the console is a place
  // errors go to be lost.
  invoke("ui_log", { message: `${where}: ${msg}` }).catch(() => {});
}

/** Note something worth having in the log even when nothing went wrong. */
function logInfo(message) {
  invoke("ui_log", { message }).catch(() => {});
}

/**
 * Reject if a call does not come back in time.
 *
 * A command that hangs is worse than one that fails: the UI simply sits there
 * with no terminal and no explanation. This turns that into a real error.
 */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not respond within ${ms}ms`)), ms)
    ),
  ]);
}

/** id -> { term, fit, view, info } */
const terminals = new Map();
let activeId = null;

/** The terminal whose name is currently being edited, if any. */
let renamingId = null;

// ---------------------------------------------------------------- terminals

// Monokai Dimmed's sixteen, lifted from the theme Cursor is using rather than
// approximated. A shell here and a shell in the editor now render the same
// output identically, which is the point: two terminals side by side that
// disagree about what "green" is read as two different machines.
//
// This replaces the Windows console's Campbell palette. Campbell's argument
// was that it matches every other terminal on the machine; the editor is the
// other terminal on this machine.
//
// The 256-colour cube and 24-bit truecolor pass through untouched, so
// `\x1b[38;2;r;g;b m` is exact.
const THEME = {
  // Must stay equal to --term-bg in app.css, or the padding around the
  // terminal reads as a frame. Monokai Dimmed's editor.background.
  background: "#1E1E1E",
  foreground: "#C5C8C6",
  cursor: "#C5C8C6",
  cursorAccent: "#1E1E1E",
  selectionBackground: "#676B7180",
  black: "#1E1E1E",
  red: "#C4265E",
  green: "#86B42B",
  yellow: "#B3B42B",
  blue: "#6A7EC8",
  magenta: "#8C6BC8",
  cyan: "#56ADBC",
  white: "#E3E3DD",
  brightBlack: "#666666",
  brightRed: "#F92672",
  brightGreen: "#A6E22E",
  brightYellow: "#E2E22E",
  brightBlue: "#819AFF",
  brightMagenta: "#AE81FF",
  brightCyan: "#66D9EF",
  brightWhite: "#F8F8F2",
};

function makeTerminal(id) {
  const view = document.createElement("div");
  view.className = "term-view";
  els.host.appendChild(view);

  const term = new Terminal({
    fontFamily: '"Geist Mono", "Cascadia Code", Consolas, monospace',
    fontSize: fontSize,
    lineHeight: 1.25,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: THEME,
    // Leave colours exactly as the program asked for them. Anything above 1
    // lets xterm.js quietly lighten or darken text to hit a contrast target,
    // which means the colour on screen is not the colour that was sent.
    minimumContrastRatio: 1,
    // Bold picking the bright variant is long-standing terminal behaviour and
    // is what the Windows console does.
    drawBoldTextInBrightColors: true,
    // Programs that emit real hyperlinks (OSC 8) rather than bare URLs get
    // the same treatment as the ones that do not; see the web links addon
    // below for those.
    linkHandler: {
      activate: (_event, uri) => {
        openInBrowserPanel(id, uri).catch((e) => showError("open link", e));
      },
    },
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  // Anything in the output that looks like a URL becomes clickable, and goes
  // to this terminal's own browser.
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((_event, uri) => {
      openInBrowserPanel(id, uri).catch((e) => showError("open link", e));
    })
  );

  // The web links addon only knows http and https. Local paths get printed as
  // links just as often — a screenshot, a log, a file a tool just wrote — and
  // a webview displays those perfectly well.
  registerFileLinks(term, id);

  term.open(view);

  // Every keystroke goes straight to the pty. No local echo — the shell echoes.
  term.onData((data) => {
    invoke("write_terminal", { id, data }).catch(console.error);
  });

  // Ctrl+Shift+L belongs to the app. Returning false keeps xterm from also
  // sending it down the pty; the window handler still sees it and opens the
  // address bar. Ctrl+L is deliberately left alone — clearing the screen is
  // the shell's, and taking it would be a worse trade than a longer chord.
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) return false;
    return true;
  });

  // Attach state. Output can arrive before the replay lands, so live chunks
  // are queued until we know which sequence the replay reached — otherwise
  // anything in both places gets written twice.
  const entry = {
    term,
    fit,
    view,
    info: null,
    ready: false,
    lastSeq: 0,
    pending: [],
    // The size the pty was last told about. Re-sending one it already has is
    // not free; see syncSize.
    lastCols: 0,
    lastRows: 0,
    // Each terminal owns a browser; remembering the address here means the bar
    // shows the right thing the instant you switch, without waiting on a poll.
    url: HOME_PAGE,
    // Closed by default. Opening one is a per-terminal decision, so coming
    // back to a terminal restores whatever you had beside it.
    browserOpen: false,
    // Lines that arrived while this terminal was not the one on screen.
    unread: 0,
    // Set by renaming. Overrides whatever the shell calls itself.
    customName: null,
  };

  // Programs announce what they are doing through the window title; showing it
  // is free and often says more than the process name can.
  term.onTitleChange((title) => {
    entry.shellTitle = title;
    scheduleButtons();
  });
  terminals.set(id, entry);

  invoke("terminal_backlog", { id })
    .then(({ text, lastSeq }) => {
      if (text) term.write(text);
      entry.lastSeq = lastSeq;
      entry.ready = true;
      for (const chunk of entry.pending) {
        if (chunk.seq > entry.lastSeq) {
          term.write(chunk.data);
          entry.lastSeq = chunk.seq;
        }
      }
      entry.pending = [];
    })
    .catch((e) => showError("terminal_backlog", e));

  return entry;
}

/** Turn `C:\dir\a file.png` into a URL a webview will accept. */
function toFileUrl(path) {
  const parts = path.replace(/\\/g, "/").split("/");
  // The drive keeps its colon; everything after it is encoded, which is what
  // turns the spaces in a screenshot's name into %20.
  const drive = parts.shift();
  return `file:///${drive}/${parts.map(encodeURIComponent).join("/")}`;
}

/**
 * What counts as a link in terminal output.
 *
 * The bare-path pattern is lazy and has to end on a file extension followed by
 * whitespace or punctuation. Windows paths contain spaces often enough that a
 * greedy match would swallow the rest of the sentence after the filename, and
 * requiring an extension is what lets it know where the path stopped.
 */
const LINK_PATTERNS = [
  { find: /file:\/\/\/[^\s"'<>`|]+/g, target: (m) => m },
  {
    find: /[A-Za-z]:\\[^\r\n<>"|*?]*?\.[A-Za-z0-9]{2,6}(?=[\s,;:)\]}'"]|$)/g,
    target: toFileUrl,
  },
];

/**
 * Make `file:///` paths in the output clickable.
 *
 * Written by hand rather than reusing the web links addon because that one
 * matches http and https only. The work here is almost entirely in wrapping:
 * a local path is usually longer than the terminal is wide, so the text is
 * spread over several rows of the buffer and a match has to be found in the
 * joined line and then mapped back to per-row coordinates.
 */
function registerFileLinks(term, id) {
  term.registerLinkProvider({
    provideLinks(row, callback) {
      const buffer = term.buffer.active;
      const cols = term.cols;

      // Walk back to where this logical line actually starts.
      let start = row - 1;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start--;

      // And forward through every row it continues onto. `false` keeps the
      // padding, so every row contributes exactly `cols` characters and an
      // offset into the joined text maps back by simple arithmetic.
      let text = "";
      for (let i = start; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) break;
        if (i > start && !line.isWrapped) break;
        text += line.translateToString(false);
      }

      const links = [];
      for (const { find, target } of LINK_PATTERNS) {
        let match;
        find.lastIndex = 0;
        while ((match = find.exec(text)) !== null) {
          const from = match.index;
          const to = from + match[0].length - 1;
          // The URL is worked out here rather than in `activate`, because the
          // text xterm hands back is the path, not the address it maps to.
          const url = target(match[0]);
          links.push({
            text: match[0],
            range: {
              start: { x: (from % cols) + 1, y: start + Math.floor(from / cols) + 1 },
              end: { x: (to % cols) + 1, y: start + Math.floor(to / cols) + 1 },
            },
            activate: () => {
              openInBrowserPanel(id, url).catch((e) => showError("open link", e));
            },
          });
        }
      }

      callback(links.length ? links : undefined);
    },
  });
}

/** Apply one live chunk, honouring the replay boundary. */
function applyChunk({ id, data, seq }) {
  const entry = terminals.get(id);
  if (!entry) return;
  if (!entry.ready) {
    entry.pending.push({ data, seq });
    return;
  }
  if (seq <= entry.lastSeq) return; // already covered by the replay
  entry.lastSeq = seq;
  entry.term.write(data);

  // Count new lines only for terminals you are not looking at, so the rail can
  // say "something happened over here" without you having to go and check.
  if (id !== activeId) {
    const lines = (data.match(/\n/g) || []).length;
    if (lines > 0) {
      entry.unread += lines;
      scheduleButtons();
    }
  }
}

// Output can arrive hundreds of times a second; rebuilding the rail on each
// chunk would be the most expensive thing the app does.
let buttonsQueued = false;
function scheduleButtons() {
  if (buttonsQueued) return;
  buttonsQueued = true;
  requestAnimationFrame(() => {
    buttonsQueued = false;
    renderButtons();
  });
}

/**
 * How long the layout has to hold still before the pty is told about it.
 *
 * ConPTY repaints its entire screen for every resize it is handed, and an
 * interactive TUI answers that repaint by drawing its banner again — below the
 * previous copy, not over it. Dragging a window edge or a splitter fires a
 * resize event per frame, each one a genuinely different column count, so one
 * drag across a couple of hundred pixels produced dozens of duplicate banners.
 * Only the size the drag ends on is worth sending.
 *
 * Long enough to swallow a drag, short enough that letting go feels immediate.
 */
const RESIZE_QUIET_MS = 150;

/** Pending pty resize, per terminal. */
const resizeTimers = new Map();

/**
 * Resize the pty to match what xterm.js just laid out.
 *
 * xterm is refitted immediately so the text on screen keeps up with the drag.
 * Only the message to the pty waits: the two disagreeing for a moment costs
 * nothing, and it is the pty side that is expensive to get wrong.
 */
function syncSize(id) {
  const entry = terminals.get(id);
  if (!entry || entry.view.offsetParent === null) return;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  if (entry.term.cols === entry.lastCols && entry.term.rows === entry.lastRows) {
    return;
  }

  clearTimeout(resizeTimers.get(id));
  resizeTimers.set(
    id,
    setTimeout(() => {
      resizeTimers.delete(id);
      // Read the size again rather than closing over the one that started the
      // timer: the drag has moved on since then, and only where it stopped
      // matters.
      const cols = entry.term.cols;
      const rows = entry.term.rows;
      if (cols === entry.lastCols && rows === entry.lastRows) return;
      entry.lastCols = cols;
      entry.lastRows = rows;
      invoke("resize_terminal", { id, cols, rows }).catch(() => {});
    }, RESIZE_QUIET_MS)
  );
}

async function selectTerminal(id) {
  if (!terminals.has(id)) return;
  activeId = id;

  for (const [tid, entry] of terminals) {
    entry.view.classList.toggle("visible", tid === id);
  }

  // No replay here: the xterm instance has been receiving this session's
  // output since it was created, whether or not it was on screen. Showing it
  // is purely a visibility change.
  const entry = terminals.get(id);
  entry.unread = 0;

  // Restore whatever this terminal had beside it, then bring its own browser
  // forward and park the others.
  els.url.value = entry.url;
  applyBrowserVisibility();

  syncSize(id);
  entry.term.focus();
  renderButtons();
}

/** Show or hide the browser column according to the active terminal. */
function applyBrowserVisibility() {
  const entry = activeId === null ? null : terminals.get(activeId);
  const open = !!entry && entry.browserOpen;

  els.app.classList.toggle("browser-closed", !open);
  els.browserBtn.classList.toggle("on", open);

  // Layout has to settle before the slot's rectangle is worth measuring.
  requestAnimationFrame(() => {
    pushBrowserBounds();
    if (activeId !== null) syncSize(activeId);
  });
}

/**
 * Open a URL in the browser that belongs to `id`.
 *
 * Where a link clicked in a terminal goes. Not the system browser: the whole
 * point of a browser per terminal is that what you follow from a shell stays
 * beside that shell, so the panel comes out if it was closed rather than the
 * page being handed to another application.
 */
async function openInBrowserPanel(id, url) {
  const entry = terminals.get(id);
  if (!entry || !url) return;

  if (id !== activeId) await selectTerminal(id);

  if (!entry.browserOpen) {
    entry.browserOpen = true;
    applyBrowserVisibility();
    renderButtons();
    saveLayoutSoon();
  }

  els.url.value = url;
  await go();
}

function toggleBrowser() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  entry.browserOpen = !entry.browserOpen;
  // Closing puts the bar away too, so the next browser opens as bare as the
  // first one did.
  if (!entry.browserOpen) setChrome(false);
  applyBrowserVisibility();
  renderButtons();
  saveLayoutSoon();
}

// ------------------------------------------------------------- window frame
//
// The window has no OS decorations, so this file owns moving it and the three
// buttons at the top right. Dragging goes through Rust rather than the
// `data-tauri-drag-region` attribute: this is a child webview, and a command
// is one less thing that has to be injected into it to work.

let maximized = false;

function refreshMaxIcon() {
  els.winMaxIcon.setAttribute("href", maximized ? "#i-restore" : "#i-max");
}

async function toggleMaximize() {
  try {
    maximized = await invoke("window_toggle_maximize");
    refreshMaxIcon();
  } catch (e) {
    showError("window_toggle_maximize", e);
  }
}

function wireWindowFrame() {
  document.getElementById("win-min").onclick = () =>
    invoke("window_minimize").catch((e) => showError("window_minimize", e));
  document.getElementById("win-max").onclick = toggleMaximize;
  // The last save has to land before the window goes, or quitting is the one
  // way to lose the session that persistence exists to keep.
  document.getElementById("win-close").onclick = async () => {
    try {
      await saveLayout();
    } catch {}
    invoke("window_close").catch((e) => showError("window_close", e));
  };

  // Anything marked as drag surface moves the window, as long as the press did
  // not land on a control sitting on top of it.
  els.titlebar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, .menu, .tb-name")) return;
    if (!e.target.closest("[data-drag]")) return;
    invoke("window_start_drag").catch(() => {});
  });

  els.titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest("button, input, .menu, .tb-name")) return;
    if (!e.target.closest("[data-drag]")) return;
    toggleMaximize();
  });
}

// ----------------------------------------------------------- address bar
//
// The bar is collapsed to a strip at the top of the page by default: a browser
// beside a terminal is there to be read, and the chrome to drive it is worth
// less than the height it costs. Showing it moves where the page starts, so
// the native webview has to be told its new rectangle.

let chromeShown = false;

function setChrome(shown) {
  if (shown === chromeShown) return;
  chromeShown = shown;
  els.browserPanel.classList.toggle("chrome-hidden", !shown);
  // Measured after the bar has actually changed height. The bar's height is
  // deliberately not transitioned so that one frame is enough; the second
  // pass is insurance against anything else in the column reflowing late.
  requestAnimationFrame(pushBrowserBounds);
  setTimeout(pushBrowserBounds, 60);
}

/** Bring the bar down with the caret in it, opening the browser if closed. */
function openAddressBar() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  if (!entry.browserOpen) {
    entry.browserOpen = true;
    applyBrowserVisibility();
    renderButtons();
  }
  setChrome(true);
  els.url.focus();
  els.url.select();
}

/** Put it away and hand the keyboard back to the terminal. */
function closeAddressBar() {
  setChrome(false);
  if (activeId !== null) terminals.get(activeId)?.term.focus();
}

/** `shell` of null means whichever one Rust judges best on this machine. */
async function newTerminal(shell = null) {
  // 80x24 is a placeholder; the real size is sent by syncSize once laid out.
  const id = await withTimeout(
    invoke("create_terminal", { shell, cols: 80, rows: 24 }),
    10000,
    "create_terminal"
  );
  makeTerminal(id);
  await refresh();
  await selectTerminal(id);
  syncSize(id);
  saveLayoutSoon();
  return id;
}

async function closeTerminal(id) {
  await invoke("close_terminal", { id }).catch(console.error);
  const entry = terminals.get(id);
  if (entry) {
    entry.term.dispose();
    entry.view.remove();
    terminals.delete(id);
  }
  if (activeId === id) {
    activeId = null;
    const next = terminals.keys().next();
    if (!next.done) await selectTerminal(next.value);
  }
  // Re-park browsers: with the last terminal gone there is nothing to show,
  // and its webview must not be left hanging over the chrome.
  pushBrowserBounds();
  await refresh();
  saveLayoutSoon();
}

// ------------------------------------------------------------------ sidebar

/** A terminal's name: whatever you renamed it to, else the shell and number. */
function displayName(info) {
  const entry = terminals.get(info.id);
  if (entry && entry.customName) return entry.customName;
  return `${info.title} ${info.id}`;
}

/**
 * Turn a label into an editable field in place.
 *
 * Deliberately not a dialog: renaming a terminal should cost one click and one
 * Enter, or nothing at all if you change your mind. Works from the rail and
 * from the name in the title bar, which is the one always in front of you.
 */
function beginRename(id, labelEl) {
  const entry = terminals.get(id);
  if (!entry || !labelEl || !labelEl.parentNode) return;
  if (labelEl.parentNode.querySelector(".rename-input")) return;

  // The rail rebuilds itself whenever a status changes, which is often, and
  // that would throw away the field being typed into. Renaming holds the rail
  // still until it is done.
  renamingId = id;

  const original = labelEl.textContent;

  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = original;
  input.spellcheck = false;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    // Only when the text actually changed. Clicking a name and then clicking
    // away commits, and without this that pins the shell's own name as a
    // custom one — the terminal looks identical but has quietly stopped
    // following what the shell calls itself.
    if (commit && input.value.trim() !== original) {
      const value = input.value.trim();
      // Clearing the name hands it back to the shell rather than leaving it
      // blank.
      entry.customName = value.length ? value : null;
    }
    if (input.parentNode) input.replaceWith(labelEl);
    renamingId = null;
    renderButtons();
    saveLayoutSoon();
  };

  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  // The row's own click handler would otherwise re-select or re-open.
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
}

/**
 * The class the status arc wears.
 *
 * Only two states earn one. A terminal sitting at a prompt and a terminal sat
 * inside a program waiting for you are what a terminal is doing nearly all the
 * time, and marking those marks everything.
 */
function stateClass(info) {
  if (!info.alive) return "state dead";
  if (info.busy) return "state busy";
  return "state";
}

/**
 * The line under the name, and nothing at all unless it is worth reading.
 *
 * "idle" and "waiting" are the states a terminal is in almost all the time, so
 * printing them next to every name is a word you read once and then stop
 * seeing, while still paying for the line it sits on.
 */
function statusText(info, entry) {
  if (!info.alive) return info.status;
  // A program's own title is usually more specific than its process name.
  if (info.busy) return entry && entry.shellTitle ? entry.shellTitle : info.status;
  return "";
}

/**
 * What sits at the right-hand end of a row, if anything.
 *
 * One slot, so these can never collide: work in progress outranks unread
 * output, which outranks the note that a browser is open beside it.
 */
function rightSlot(info, entry) {
  if (info.busy || !info.alive) {
    return svgIcon("#i-spin", stateClass(info));
  }
  if (entry && entry.unread > 0 && info.id !== activeId) {
    const badge = document.createElement("span");
    badge.className = "unread";
    badge.textContent = entry.unread > 99 ? "99+" : String(entry.unread);
    badge.title = `${entry.unread} new lines`;
    return badge;
  }
  return null;
}

/** An <svg><use> pair. SVG elements need createElementNS, not createElement. */
function svgIcon(id, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", id);
  svg.appendChild(use);
  return svg;
}

// ------------------------------------------------------- rail context menu

function closeRowMenu() {
  els.rowMenu.hidden = true;
}

/**
 * Right-click on a terminal in the rail.
 *
 * Lives at the top level of the document rather than inside the row, because
 * the rail is rebuilt from scratch on every repaint and a menu parented to a
 * row would vanish underneath the pointer the next time a status changed.
 */
function openRowMenu(id, x, y) {
  const entry = terminals.get(id);
  if (!entry) return;

  const menu = els.rowMenu;
  menu.innerHTML = "";

  const item = (label, action, danger) => {
    const button = document.createElement("button");
    button.textContent = label;
    if (danger) button.className = "danger";
    button.onclick = (e) => {
      e.stopPropagation();
      closeRowMenu();
      action();
    };
    menu.appendChild(button);
  };

  item("Rename", async () => {
    // After selecting, so the row is certainly there and certainly the one
    // being looked at. Its label is found in the freshly built rail rather
    // than captured before, which would be a reference to a discarded node.
    await selectTerminal(id);
    const row = [...els.list.children].find((r) => r.dataset.id === String(id));
    const label = row && row.querySelector(".name");
    if (label) beginRename(id, label);
  });

  item(entry.browserOpen ? "Hide browser" : "Show browser", async () => {
    await selectTerminal(id);
    toggleBrowser();
  });

  const separator = document.createElement("div");
  separator.className = "sep";
  menu.appendChild(separator);

  item("Close terminal", () => {
    closeTerminal(id).catch((e) => showError("close terminal", e));
  }, true);

  // Shown before measuring, since a hidden element has no size, then nudged
  // back inside the window if it would hang off an edge.
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 6))}px`;
}

function renderButtons() {
  // Rebuilding the rail mid-rename would discard the field being typed into.
  if (renamingId !== null) return;

  // The UI knows a terminal exists the moment it creates one. Deriving the
  // button list from the status poller instead meant that if a single status
  // call failed, every terminal became invisible even though its shell was
  // running fine.
  const infos = [...terminals.entries()].map(
    ([id, e]) =>
      e.info ?? {
        id,
        title: "shell",
        status: "starting…",
        busy: false,
        running: false,
        alive: true,
      }
  );

  const needle = filterText.trim().toLowerCase();
  const shown = needle
    ? infos.filter((i) => displayName(i).toLowerCase().includes(needle))
    : infos;

  els.list.innerHTML = "";

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = infos.length ? "No terminal matches." : "No terminals.";
    els.list.appendChild(empty);
  }

  for (const info of shown) {
    const entry = terminals.get(info.id);
    const row = document.createElement("div");
    row.className = "term-btn" + (info.id === activeId ? " active" : "");
    row.tabIndex = 0;
    row.dataset.id = String(info.id);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = displayName(info);

    // Click the name of the terminal you are already in to rename it; double
    // click works from anywhere.
    // A click on the terminal you are already in is a rename: there is nothing
    // else for it to mean, and requiring the pointer to land exactly on the
    // text made a rename something you had to aim for.
    row.onclick = () => {
      if (info.id === activeId) {
        beginRename(info.id, name);
      } else {
        selectTerminal(info.id);
      }
    };
    row.ondblclick = (e) => {
      e.preventDefault();
      beginRename(info.id, name);
    };
    row.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTerminal(info.id);
      }
      if (e.key === "F2") {
        e.preventDefault();
        beginRename(info.id, name);
      }
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRowMenu(info.id, e.clientX, e.clientY);
    };

    row.append(name);

    // Left out entirely rather than left empty, so a quiet row is one line
    // instead of one line and a gap.
    const label = statusText(info, entry);
    if (label) {
      const status = document.createElement("span");
      status.className = "status";
      status.textContent = label;
      row.appendChild(status);
    }

    const right = rightSlot(info, entry);
    if (right) row.appendChild(right);

    els.list.appendChild(row);
  }

  // The title bar says nothing about which terminal is active: the rail
  // already does, and twice was once too many. The window title still does,
  // because that is what the taskbar reads.
  const active = infos.find((i) => i.id === activeId);
  document.title = active ? `${displayName(active)} — mux` : "mux";
}

async function refresh() {
  try {
    applyInfos(await invoke("list_terminals"));
  } catch (e) {
    showError("list_terminals", e);
  }
}

function applyInfos(infos) {
  for (const info of infos) {
    const entry = terminals.get(info.id);
    if (entry) entry.info = info;
  }
  renderButtons();
}

// ------------------------------------------------------------------ browser
//
// The browser is a native child webview, so it cannot be laid out by CSS. We
// measure the slot the DOM reserved for it and push those coordinates to Rust
// on every change.

let boundsTimer = null;

let boundsFailed = false;

function pushBrowserBounds() {
  const r = els.slot.getBoundingClientRect();
  invoke("browser_layout", {
    active: activeId,
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height,
  })
    .then((hasBrowser) => {
      // Browsers come from a fixed pool, so a terminal can legitimately have
      // none. Say so rather than leaving a black rectangle.
      els.slot.classList.toggle("empty", activeId !== null && !hasBrowser);
    })
    .catch((e) => {
      // Reported once: this fires on every resize tick and would otherwise
      // rewrite the banner continuously.
      if (!boundsFailed) {
        boundsFailed = true;
        showError("browser_layout", e);
      }
    });
}

function scheduleBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(pushBrowserBounds, 16);
}

async function go() {
  if (activeId === null) return;
  const id = activeId;
  try {
    const full = await invoke("browser_navigate", { id, url: els.url.value });
    els.url.value = full;
    const entry = terminals.get(id);
    if (entry) entry.url = full;
    els.url.blur();
    terminals.get(id)?.term.focus();
  } catch (e) {
    showError("browser", e);
  }
}

function history(action) {
  if (activeId !== null) {
    invoke("browser_history", { id: activeId, action }).catch(console.error);
  }
}

// ------------------------------------------------------------- session state
//
// What the app remembers between runs. The shells themselves do not survive
// quitting — that needs a daemon owning the ptys — but the set of terminals,
// what you called them, where they were working and what they had printed all
// come back, so reopening lands you where you left off rather than at a bare
// prompt.

let saveTimer = null;

/** Persist shortly after a change, rather than on every keystroke. */
function saveLayoutSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLayout, 400);
}

function saveLayout() {
  const order = [...terminals.keys()];
  return invoke("save_layout", {
    layout: {
      active: activeId,
      terminals: order.map((id) => {
        const e = terminals.get(id);
        return {
          id,
          name: e.customName,
          browserOpen: e.browserOpen,
          url: e.url || "",
        };
      }),
    },
  }).catch(() => {});
}

/**
 * Bring back the terminals from last time, or start one if there were none.
 *
 * Each restored terminal is a fresh shell in the directory the old one was
 * last working in, with the previous session's output replayed above it and a
 * rule to say where the old ends and the new begins. Restoring the text but
 * silently starting somewhere else would be the worst of both.
 */
async function restoreOrStart() {
  let saved = null;
  try {
    saved = await invoke("load_layout");
  } catch (e) {
    logInfo(`load_layout failed, starting fresh: ${e}`);
  }

  const wanted = saved && Array.isArray(saved.terminals) ? saved.terminals : [];
  if (!wanted.length) {
    await newTerminal();
    return;
  }

  let firstId = null;
  for (const t of wanted) {
    try {
      const id = await withTimeout(
        invoke("restore_terminal", {
          shell: t.shell || null,
          cwd: t.cwd || null,
          scrollback: t.scrollback || "",
          cols: 80,
          rows: 24,
        }),
        10000,
        "restore_terminal"
      );
      const entry = makeTerminal(id);
      entry.customName = t.name || null;
      entry.browserOpen = !!t.browserOpen;
      entry.url = t.url || HOME_PAGE;
      if (firstId === null) firstId = id;
    } catch (e) {
      showError("restore terminal", e);
    }
  }

  await refresh();
  if (firstId !== null) await selectTerminal(firstId);
  else await newTerminal();
}

// ---------------------------------------------------------------- updates
//
// The app knows which version it is; GitHub knows which is newest. Comparing
// them is one request, and the whole of the update UI is a chip that shows up
// when there is something newer and opens the release in this terminal's own
// browser. The check runs in the webview rather than in Rust because the
// webview already has an HTTP stack and Rust would need a new dependency for
// one GET.

const RELEASES_API =
  "https://api.github.com/repos/hunterjreid/mux/releases/latest";
const RELEASES_PAGE = "https://github.com/hunterjreid/mux/releases/latest";
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

/** Is `candidate` a later version than `current`? Dotted numbers, `v` optional. */
function isNewer(candidate, current) {
  const parts = (v) =>
    String(v)
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

async function checkForUpdate() {
  let current;
  try {
    current = await invoke("app_version");
  } catch {
    return;
  }

  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    // A repository with no releases yet answers 404, which is not a problem.
    if (!response.ok) return;

    const { tag_name: tag } = await response.json();
    if (!tag || !isNewer(tag, current)) return;

    els.updateChip.textContent = `update to ${tag}`;
    els.updateChip.title = `This is v${current}. Click to open the release.`;
    els.updateChip.hidden = false;
  } catch {
    // Offline, rate limited, DNS down. Quietly not offering an update is the
    // right failure here: this is never why someone opened a terminal.
  }
}

// -------------------------------------------------------------- splitters

function makeSplitter(el, varName, opts) {
  let dragging = false;

  el.addEventListener("mousedown", (e) => {
    dragging = true;
    el.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = opts.fromRight ? window.innerWidth - e.clientX : e.clientX;
    const clamped = Math.max(opts.min, Math.min(opts.max, w));
    document.documentElement.style.setProperty(varName, `${clamped}px`);
    scheduleBounds();
    if (activeId !== null) syncSize(activeId);
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    scheduleBounds();
    if (activeId !== null) syncSize(activeId);
  });
}

// ----------------------------------------------------------------- startup

async function main() {
  wireWindowFrame();

  els.newBtn.onclick = () => newTerminal().catch((e) => showError("new terminal", e));
  els.browserBtn.onclick = toggleBrowser;
  document.getElementById("err-close").onclick = () => (els.err.hidden = true);

  // mux has a browser in it, so the release notes can open beside the terminal
  // rather than throwing you out to another application.
  els.updateChip.onclick = async () => {
    if (activeId === null) return;
    const entry = terminals.get(activeId);
    if (!entry.browserOpen) {
      entry.browserOpen = true;
      applyBrowserVisibility();
      renderButtons();
    }
    els.url.value = RELEASES_PAGE;
    await go();
  };

  els.filter.addEventListener("input", () => {
    filterText = els.filter.value;
    renderButtons();
  });
  els.filter.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      els.filter.value = "";
      filterText = "";
      renderButtons();
      els.filter.blur();
    }
  });

  // Any click anywhere puts the context menu away, including the one that
  // chose an item from it.
  document.addEventListener("click", closeRowMenu);
  window.addEventListener("blur", closeRowMenu);

  els.url.value = HOME_PAGE;
  els.url.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") go();
    if (e.key === "Escape") closeAddressBar();
  });

  // Reach the top edge of the page and the bar comes down; leave it and it
  // goes away again, unless the caret is in it.
  els.browserBar.addEventListener("mouseenter", () => setChrome(true));
  els.browserBar.addEventListener("mouseleave", () => {
    if (document.activeElement !== els.url) setChrome(false);
  });
  els.url.addEventListener("blur", () => {
    if (!els.browserBar.matches(":hover")) setChrome(false);
  });

  // The keyboard route, for when the pointer is in the terminal. Ctrl+L stays
  // the shell's.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      e.preventDefault();
      openAddressBar();
    }
    if (e.key === "Escape") closeRowMenu();
  });
  document.getElementById("back-btn").onclick = () => history("back");
  document.getElementById("fwd-btn").onclick = () => history("forward");
  document.getElementById("reload-btn").onclick = () => history("reload");

  makeSplitter(document.getElementById("split-term"), "--rail-w", {
    min: 170,
    max: 380,
    fromRight: false,
  });
  makeSplitter(document.getElementById("split-browser"), "--browser-w", {
    min: 0,
    max: 900,
    fromRight: true,
  });

  // Output for ANY terminal is applied, not just the visible one — that is
  // what keeps background terminals current instead of frozen.
  await listen("terminal-output", (event) => applyChunk(event.payload));

  await listen("terminal-exit", (event) => {
    const id = event.payload;
    terminals.get(id)?.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    refresh();
  });

  await listen("terminals", (event) => applyInfos(event.payload));

  window.addEventListener("resize", () => {
    scheduleBounds();
    if (activeId !== null) syncSize(activeId);
  });

  // Ctrl+scroll to resize the text. The whole font UI, and it adds no chrome.
  els.host.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      fontSize = Math.min(28, Math.max(8, fontSize + (e.deltaY < 0 ? 1 : -1)));
      for (const [id, entry] of terminals) {
        entry.term.options.fontSize = fontSize;
        if (id === activeId) syncSize(id);
      }
    },
    { passive: false }
  );

  await restoreOrStart();
  // Starts closed unless the restored session had one open.
  applyBrowserVisibility();

  try {
    maximized = await invoke("window_is_maximized");
    refreshMaxIcon();
  } catch {}

  logInfo(`started; terminals=${terminals.size} active=${activeId}`);

  // Keep the URL bar showing wherever the active terminal's browser actually
  // ended up, including after in-page navigation we did not initiate.
  setInterval(async () => {
    if (activeId === null || document.activeElement === els.url) return;
    const id = activeId;
    try {
      const u = await invoke("browser_url", { id });
      const entry = terminals.get(id);
      if (entry) entry.url = u;
      // Guard against the terminal having been switched mid-await.
      if (id === activeId && u !== els.url.value) els.url.value = u;
    } catch {}
  }, 1000);

  // The working directory and scrollback are read by Rust at save time, so the
  // UI only has to say which terminals exist and what they are called. Saving
  // on a timer as well as on change means a crash loses seconds, not the lot.
  setInterval(saveLayout, 5000);
  window.addEventListener("beforeunload", saveLayout);

  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_CHECK_MS);
}

main().catch((e) => {
  document.body.innerHTML =
    `<pre class="term-empty">mux failed to start:\n${e}</pre>`;
  console.error(e);
  invoke("ui_log", { message: `failed to start: ${e}` }).catch(() => {});
});
