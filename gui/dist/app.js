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
  railBtn: document.getElementById("rail-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsMenu: document.getElementById("settings-menu"),
  browserProgress: document.getElementById("browser-progress"),
  tabs: document.getElementById("tabs"),
  tabNew: document.getElementById("tab-new"),
  rowMenu: document.getElementById("row-menu"),
  filter: document.getElementById("filter"),
  filterBtn: document.getElementById("filter-btn"),
  railHead: document.getElementById("rail-head"),
  titlebar: document.getElementById("titlebar"),
  updateChip: document.getElementById("update-chip"),
  winMaxIcon: document.getElementById("win-max-icon"),
};

/** Ctrl+scroll adjusts this, which is the whole of the font UI. */
/**
 * Terminal text size, per terminal.
 *
 * Not one number for the window. A terminal running a full-screen program you
 * are reading wants to be bigger than one you keep a build log in, and they sit
 * side by side — a single size means every change to one is a change to all of
 * them. Kept out of the session file because it is about this window rather
 * than about what was running: a size chosen here should survive a machine
 * restart that the shells themselves do not.
 */
const FONT_SIZES_KEY = "mux.fontSizes";
const DEFAULT_FONT_SIZE = 13;

function loadFontSizes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FONT_SIZES_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let fontSizes = loadFontSizes();

function fontSizeFor(id) {
  const saved = Number(fontSizes[id]);
  return saved >= 8 && saved <= 28 ? saved : DEFAULT_FONT_SIZE;
}

function rememberFontSize(id, size) {
  fontSizes[id] = size;
  // Terminals that no longer exist would accumulate for as long as the browser
  // profile does, so the map is pruned to what is actually open each time.
  const live = {};
  for (const key of terminals.keys()) {
    if (fontSizes[key] !== undefined) live[key] = fontSizes[key];
  }
  fontSizes = live;
  try {
    localStorage.setItem(FONT_SIZES_KEY, JSON.stringify(fontSizes));
  } catch {}
}

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

// ------------------------------------------------------------------- tabs
//
// Each terminal keeps its own set of open pages. A tab is a number and a URL
// here; the browser behind it is one of a fixed pool of webviews claimed by
// that number, because a webview cannot be made once the app is running.
//
// Tabs belong to the terminal rather than to the window, so switching
// terminals switches the whole set — the pages you had open beside one shell
// are not the pages you had open beside another.

/** Tab ids are unique for the life of the window; the pool is keyed by them. */
let nextTabId = 1;

function tabsOf(entry) {
  if (!entry.tabs) entry.tabs = [];
  return entry.tabs;
}

function activeTab(entry) {
  const tabs = tabsOf(entry);
  return tabs.find((t) => t.id === entry.activeTab) || tabs[0] || null;
}

/**
 * Add a page and claim a browser for it.
 *
 * Returns null when every browser in the pool is already spoken for, which is
 * a real limit rather than a failure: they are all built before the window
 * opens and there is no making another.
 */
async function addTab(entry, url = HOME_PAGE) {
  const tab = { id: nextTabId++, url, title: "" };
  let claimed = false;
  try {
    claimed = await invoke("browser_claim", { tab: tab.id });
  } catch (e) {
    showError("new tab", e);
    return null;
  }
  if (!claimed) {
    showError("new tab", `no browser left: all ${POOL_LIMIT_HINT} pages are open`);
    return null;
  }
  tabsOf(entry).push(tab);
  entry.activeTab = tab.id;
  return tab;
}

/** Only used to word the message above; the real limit lives in Rust. */
const POOL_LIMIT_HINT = 12;

async function closeTab(entry, tabId) {
  const tabs = tabsOf(entry);
  const at = tabs.findIndex((t) => t.id === tabId);
  if (at < 0) return;

  tabs.splice(at, 1);
  try {
    await invoke("browser_release", { tab: tabId });
  } catch {}

  if (entry.activeTab === tabId) {
    // The one to its left, or the first that is left. Closing a tab should
    // land you somewhere adjacent, not at the far end of the strip.
    const next = tabs[Math.max(0, at - 1)];
    entry.activeTab = next ? next.id : null;
  }

  // Nothing left to show, so the panel has no reason to be open. Animated,
  // because it is the panel leaving rather than a switch between terminals —
  // and the slide ends by refitting the terminal, which is what gives the
  // width back rather than leaving it laid out around a panel that has gone.
  const emptied = !tabs.length;
  if (emptied) {
    entry.browserOpen = false;
    setChrome(false);
  }
  applyBrowserVisibility(emptied);
  renderTabs();
  saveLayoutSoon();
}

/** Make `tabId` the page the panel is showing. */
function selectTab(entry, tabId) {
  if (!tabsOf(entry).some((t) => t.id === tabId)) return;
  entry.activeTab = tabId;
  const tab = activeTab(entry);
  els.url.value = tab && tab.url !== HOME_PAGE ? tab.url : "";
  renderTabs();
  applyLoading();
  // Which webview is over the slot is decided by the tab handed to Rust, so
  // the panel has to be told again even though nothing about it moved — and
  // told that this one counts, since the rectangle is identical.
  requestAnimationFrame(() => pushBrowserBounds(true));
}

/**
 * Draw the strip for whichever terminal is on screen.
 *
 * Rebuilt wholesale rather than updated in place: a handful of tabs is nothing
 * to diff, and unlike the rail this does not carry an animation that restarting
 * would ruin.
 */
function renderTabs() {
  const entry = activeId === null ? null : terminals.get(activeId);
  els.tabs.innerHTML = "";
  if (!entry) return;

  for (const tab of tabsOf(entry)) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === entry.activeTab ? " active" : "");
    el.title = tab.url === HOME_PAGE ? "New tab" : tab.url;
    el.onclick = () => selectTab(entry, tab.id);

    // The site's mark, taken from the site itself rather than through a
    // favicon service: mux would otherwise tell a third party every address
    // you open, which is not a reasonable price for a 13px picture.
    const icon = document.createElement("img");
    icon.className = "tab-icon";
    icon.alt = "";
    const favicon = faviconFor(tab.url);
    if (favicon) {
      icon.src = favicon;
      // Plenty of sites have none. Hidden rather than removed, so the row does
      // not close up around the gap and shift every name along.
      icon.onerror = () => {
        icon.style.visibility = "hidden";
      };
    } else {
      icon.style.visibility = "hidden";
    }
    el.appendChild(icon);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabTitle(tab);
    el.appendChild(label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close tab";
    close.onclick = (e) => {
      // Or clicking the cross would also select the tab on the way past.
      e.stopPropagation();
      closeTab(entry, tab.id).catch((err) => showError("close tab", err));
    };
    const ico = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ico.setAttribute("class", "ico");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-close");
    ico.appendChild(use);
    close.appendChild(ico);
    el.appendChild(close);

    els.tabs.appendChild(el);
  }
}

/**
 * What to call a tab.
 *
 * The host, not the whole address: a strip of tabs all reading "https://" tells
 * you nothing, and the host is what people actually navigate by.
 */
/** Where a site keeps its mark, by the convention every site follows. */
function faviconFor(url) {
  if (!url || url === HOME_PAGE) return "";
  try {
    const { origin, protocol } = new URL(url);
    // A local file has no origin worth asking.
    if (protocol !== "http:" && protocol !== "https:") return "";
    return `${origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function tabTitle(tab) {
  if (!tab.url || tab.url === HOME_PAGE) return "New tab";
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).host.replace(/^www\./, "") || tab.url;
  } catch {
    return tab.url;
  }
}

/**
 * Whether the layout is reflected: terminals on the right, the page on the
 * left. Kept here rather than in the session file because it is about the
 * window, not about what was running in it — a preference that should hold
 * even for a session started from nothing.
 */
const MIRROR_KEY = "mux.mirrored";
// Reflected by default: terminals on the right, the page on the left. The
// stored value still wins, so a window that has been swapped stays swapped —
// this only decides what a window with no opinion yet does.
let mirrored = (localStorage.getItem(MIRROR_KEY) ?? "1") === "1";

function applyMirror() {
  els.app.classList.toggle("mirrored", mirrored);
  // Every column has moved, so the hole the native browser sits in has too.
  requestAnimationFrame(() => {
    pushBrowserBounds();
    if (activeId !== null) syncSize(activeId);
  });
}

/** Show the loading bar if the terminal on screen has a page coming in. */
function applyLoading() {
  const entry = activeId === null ? null : terminals.get(activeId);
  els.browserProgress.hidden = !(entry && entry.loading && entry.browserOpen);
}

/**
 * Settings, under the gear.
 *
 * A menu rather than a row of buttons in the bar. There is one thing in it
 * today and there will be more, and a bar that grows a button per preference
 * ends up being mostly preferences — the point of the top strip is the two or
 * three things you reach for constantly, and which side the terminals sit on
 * is not one of them once you have chosen.
 */
function openSettings() {
  const menu = els.settingsMenu;
  menu.innerHTML = "";

  const heading = (text) => {
    const el = document.createElement("div");
    el.className = "menu-heading";
    el.textContent = text;
    menu.appendChild(el);
  };

  const option = (label, selected, onPick) => {
    const button = document.createElement("button");
    button.className = "option" + (selected ? " on" : "");
    button.type = "button";

    const tick = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    tick.setAttribute("class", "ico");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-check");
    tick.appendChild(use);
    button.appendChild(tick);

    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);

    button.onclick = () => {
      onPick();
      closeSettings();
    };
    menu.appendChild(button);
  };

  heading("Layout");
  option("Terminals on the left", !mirrored, () => {
    if (mirrored) toggleMirror();
  });
  option("Terminals on the right", mirrored, () => {
    if (!mirrored) toggleMirror();
  });

  // Shown before measuring, since a hidden element has no size, then pulled
  // back under the button it belongs to.
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const button = els.settingsBtn.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(button.right - box.width, window.innerWidth - box.width - 6))}px`;
  menu.style.top = `${button.bottom + 4}px`;
}

function closeSettings() {
  els.settingsMenu.hidden = true;
}

/**
 * Whether the terminal list is put away.
 *
 * Its own preference, kept beside the others, because it is about this window
 * rather than about what is running in it.
 */
const RAIL_KEY = "mux.railClosed";
let railClosed = localStorage.getItem(RAIL_KEY) === "1";

function applyRail() {
  els.app.classList.toggle("rail-closed", railClosed);
  els.railBtn.classList.toggle("on", !railClosed);
  // The middle column just changed width, so the terminals need refitting and
  // the browser needs telling where its hole went.
  requestAnimationFrame(() => {
    pushBrowserBounds(true);
    if (activeId !== null) syncSize(activeId);
  });
}

function toggleRail() {
  railClosed = !railClosed;
  localStorage.setItem(RAIL_KEY, railClosed ? "1" : "0");
  applyRail();
}

function toggleMirror() {
  mirrored = !mirrored;
  localStorage.setItem(MIRROR_KEY, mirrored ? "1" : "0");
  applyMirror();
}

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
  // The engine's default thumb is the foreground at 20% opacity, which against
  // this background is close enough to invisible that the terminal reads as
  // having no scrollbar at all. A scrollbar is also a position indicator, and
  // one you cannot see does not indicate anything.
  scrollbarSliderBackground: "#4A4F58",
  scrollbarSliderHoverBackground: "#5E646F",
  scrollbarSliderActiveBackground: "#767D8A",
};

/**
 * An answer this terminal generated on its own behalf, rather than a keystroke.
 *
 * Cursor position reports, device attributes, and the mode reports that go with
 * them. Anchored at both ends so it can only match a whole message: a person
 * cannot type an escape character, so nothing a person does reaches this, and
 * paste is not routed through here.
 */
const IS_TERMINAL_REPLY =
  /^\x1b(?:\[[\d;?]*[Rcn]|\[\?[\d;]*[$ychl]|P[\d+$]?[^\x1b]*\x1b\\)$/;

/**
 * @param id      the session this view is attached to
 * @param initial the size the terminal was when its saved text was written.
 *                Serialized output is a grid, so it goes back into a grid of
 *                the same width; the fit on the first layout reflows it to
 *                whatever the window is now.
 */
function makeTerminal(id, initial = null) {
  const view = document.createElement("div");
  view.className = "term-view";
  els.host.appendChild(view);

  const term = new Terminal({
    fontFamily: '"Geist Mono", "Cascadia Code", Consolas, monospace',
    fontSize: fontSizeFor(id),
    // Exactly one. Anything above it is a gap between rows, and a gap between
    // rows is a gap in every box a program draws: the DOM renderer takes box
    // characters from the font rather than drawing them to fill the cell, so
    // the verticals of a framed banner stop being a line and become a column
    // of dashes. Spacing that looks generous in prose is a broken border here.
    lineHeight: 1,
    cursorBlink: true,
    allowProposedApi: true,
    // How far back you can scroll, in lines.
    //
    // This is also how long your place survives. Scrolling up and switching
    // away holds exactly; output arriving while you are parked holds exactly.
    // The one thing that loses it is the buffer filling: the front is dropped,
    // and the lines you were reading stop existing. Nothing can hold a position
    // in text that has been discarded, so the only lever is how long it takes
    // to get there — and a session that talks for an hour goes through ten
    // thousand lines without trying.
    scrollback: 50000,
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

  // What gets written to disk on every save. Serializing the buffer gives the
  // text as it was *drawn*; the pty byte stream that produced it is a different
  // thing entirely and cannot be replayed — see saveLayout.
  const serializer = new SerializeAddon.SerializeAddon();
  term.loadAddon(serializer);

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

  /**
   * Right click: copy what is selected, or paste when nothing is.
   *
   * The two halves are one gesture because that is what a terminal on Windows
   * does, and because the alternative is a menu for two items you always know
   * which of you want. Selecting then right-clicking takes the text; clicking
   * with nothing selected puts the clipboard in.
   *
   * The paste goes through xterm rather than straight down the pty, which
   * matters more than it looks: a shell with bracketed paste on — every one of
   * them here, they all set `?2004h` — expects pasted text wrapped in markers
   * that tell it this was pasted rather than typed. Without them a paste of
   * five lines runs five commands, and the fifth runs before you have read the
   * first. `term.paste` wraps it or does not, according to the mode the shell
   * actually set.
   */
  view.addEventListener("contextmenu", async (e) => {
    e.preventDefault();

    const selection = term.getSelection();
    if (selection) {
      try {
        await invoke("clipboard_write", { text: selection });
      } catch (err) {
        showError("copy", err);
      }
      // Cleared so the next right click pastes. Leaving it selected makes the
      // button do the same thing twice and never the other one.
      term.clearSelection();
      term.focus();
      return;
    }

    try {
      const text = await invoke("clipboard_read");
      if (text) term.paste(text);
    } catch (err) {
      showError("paste", err);
    }
    term.focus();
  });

  // Before a single byte of the replay lands. Opening sizes the terminal to a
  // container the view is not laid out in yet, and text written at the wrong
  // width wraps at the wrong column even after the fit reflows it back.
  if (initial && initial.cols > 0 && initial.rows > 0) {
    term.resize(initial.cols, initial.rows);
  }

  // Every keystroke goes straight to the pty. No local echo — the shell echoes.
  //
  // Except this terminal's answers to the shell's own questions. A program can
  // ask where the cursor is or what the terminal is, and xterm.js answers on
  // this same channel, indistinguishable from typing. It must not: the daemon
  // owns the pty and answers for it, because it is the only side still there
  // when this window is closed. Two answers to one question means the second
  // arrives as input, and a shell that asked once gets `[24;1R` typed at it.
  term.onData((data) => {
    if (IS_TERMINAL_REPLY.test(data)) return;
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
    serializer,
    info: null,
    ready: false,
    lastSeq: 0,
    pending: [],
    // The size the pty was last told about. Re-sending one it already has is
    // not free; see syncSize.
    // Seeded with the size the pty is already at, not zero.
    //
    // These exist so a fit that lands on the size the shell already has sends
    // nothing. Starting them at zero meant the first fit after opening a window
    // always disagreed and always resized — and ConPTY answers a resize by
    // redrawing the whole screen, which an inline TUI answers by drawing its
    // banner again *below* the last one rather than over it. Reopening a window
    // at the size you left it should be silent, and this is what makes it so.
    lastCols: initial && initial.cols > 0 ? initial.cols : 0,
    lastRows: initial && initial.rows > 0 ? initial.rows : 0,
    // Each terminal owns a browser; remembering the address here means the bar
    // shows the right thing the instant you switch, without waiting on a poll.
    url: HOME_PAGE,
    // Closed by default. Opening one is a per-terminal decision, so coming
    // back to a terminal restores whatever you had beside it.
    browserOpen: false,
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
      // A restored terminal opens at the prompt, not part way up last week's
      // output. Queued behind the writes above, which is when the buffer has
      // its final length.
      term.write("", () => term.scrollToBottom());
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
/**
 * Domains that get to be links without a scheme in front of them.
 *
 * An allowlist rather than "two or more letters after a dot", because that
 * matches `seo.js`, `app.py` and every filename anyone ever prints. These are
 * the endings that are almost never a file extension.
 */
const BARE_TLDS =
  "com|net|org|io|dev|app|gg|ai|co|nz|au|uk|me|xyz|sh|to|so|tv|cc|info|store|shop";

const LINK_PATTERNS = [
  { find: /file:\/\/\/[^\s"'<>`|]+/g, target: (m) => m },
  { find: /https?:\/\/[^\s"'<>`|]+/g, target: (m) => m },
  {
    find: /[A-Za-z]:\\[^\r\n<>"|*?]*?\.[A-Za-z0-9]{2,6}(?=[\s,;:)\]}'"]|$)/g,
    target: toFileUrl,
  },
  {
    // A domain written the way people write them: `trenchies.co`, no scheme.
    //
    // The lookbehind is what keeps this out of paths and addresses that
    // another pattern already owns — `...\cdn.prod.website-files.com\...` is
    // part of a file path, and `https://silka.co.nz` is already a link. Both
    // end in something this would otherwise match in the middle of.
    find: new RegExp(
      String.raw`(?<![\\/\w.@:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${BARE_TLDS})\b(?:/[^\s"'<>\`|]*)?`,
      "gi"
    ),
    target: (m) => `https://${m}`,
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
 *
 * The cost of being too short is not a wasted message: every size that gets
 * through is another copy of a full-screen program's banner in the scrollback,
 * because that is what ConPTY's repaint does to a TUI that draws inline. A
 * drag that pauses is still one drag, so this is set to outlast a pause rather
 * than only the gap between frames.
 */
const RESIZE_QUIET_MS = 400;

/**
 * How long a window takes to stop changing size after it opens.
 *
 * Opening one is not a single size. The window is built, the webview is sized
 * into it, and then the size it was last left at is restored — three different
 * layouts, far enough apart that the ordinary quiet period lets all three
 * through. Each one is a repaint, and a repaint is another copy of a TUI's
 * banner, so a window reopening on a session running one came back with the
 * banner three times. Nothing before the last of them is worth sending.
 */
const STARTUP_SETTLE_MS = 1200;
const startedAt = performance.now();

/** How long to wait before telling the pty, given how long we have been up. */
function resizeQuiet() {
  return performance.now() - startedAt < STARTUP_SETTLE_MS
    ? STARTUP_SETTLE_MS
    : RESIZE_QUIET_MS;
}

/** Pending pty resize, per terminal. */
const resizeTimers = new Map();

/**
 * Do something that changes a terminal's width, and keep the reader's place.
 *
 * Narrowing a terminal re-wraps every long line, so the same text occupies more
 * rows than it did and every row number below the change moves. xterm keeps the
 * viewport on the same NUMBER, which after a reflow is the one thing that is no
 * longer the same place — the view ends up hundreds of lines from where it was.
 *
 * A marker is the buffer's own answer. It is attached to a line and carried
 * along by the reflow, so asking it afterwards where that line ended up gives
 * the row the text actually moved to.
 *
 * Wrapped around every path that resizes, not just the visible one. A terminal
 * you are not looking at is resized to match the one you are, and that reflow
 * is invisible until you switch back to find your place gone.
 *
 * Only when scrolled back: at the bottom there is nothing to preserve, and
 * following the end is already what should happen.
 */
function preservingView(entry, change) {
  const buffer = entry.term.buffer.active;
  let anchor = null;
  if (buffer.viewportY < buffer.baseY) {
    try {
      // Markers are placed relative to the cursor, so an absolute row has to
      // be expressed as a distance from it.
      anchor = entry.term.registerMarker(
        buffer.viewportY - (buffer.baseY + buffer.cursorY)
      );
    } catch {
      anchor = null;
    }
  }

  try {
    change();
  } finally {
    if (anchor) {
      // A disposed marker reports -1: the line it was watching fell out of the
      // scrollback, and there is nowhere left to go back to.
      if (anchor.line >= 0) entry.term.scrollToLine(anchor.line);
      anchor.dispose();
    }
  }
}

/**
 * Resize the pty to match what xterm.js just laid out.
 *
 * xterm is refitted immediately so the text on screen keeps up with the drag.
 * Only the message to the pty waits: the two disagreeing for a moment costs
 * nothing, and it is the pty side that is expensive to get wrong.
 */
function syncSize(id) {
  // Every terminal, not only the one on screen.
  //
  // They all occupy the same box, so a change to that box is a change to all
  // of them — but not the same change, because each has its own font size and
  // therefore its own number of columns in the same number of pixels. Fitting
  // each one to what it would actually be is what makes switching free: the
  // terminal you arrive at is already the right size, so nothing reflows in
  // front of you.
  for (const [each, entry] of terminals) {
    fitTerminal(each, entry);
  }
  // `id` is only the one that prompted this; it has been fitted along with the
  // rest.
  void id;
}

/** Fit one terminal to the box, and tell its pty once the size holds still. */
function fitTerminal(id, entry) {
  if (!entry || entry.view.offsetParent === null) return;

  let fitted = true;
  preservingView(entry, () => {
    try {
      entry.fit.fit();
    } catch {
      fitted = false;
    }
  });
  if (!fitted) return;
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
    }, resizeQuiet())
  );
}

/**
 * Give the terminals that are not on screen the size the visible one settled
 * on.
 *
 * Every terminal fills the same area, so this is the size they are going to be
 * anyway — the only question is whether they find out now or the moment you
 * switch to them. Later is worse: a pty resized on the way in makes ConPTY
 * repaint its whole screen, so the terminal you just opened redraws itself in
 * front of you, and a full-screen program draws its banner a second time.
 */
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
  const showing = activeTab(entry);
  els.url.value = showing && showing.url !== HOME_PAGE ? showing.url : "";
  renderTabs();
  applyBrowserVisibility();

  syncSize(id);
  entry.term.focus();
  renderButtons();
}

/**
 * How long the browser column takes to open or close. Must match `--slide` in
 * app.css: this side is what keeps the native browser over its slot, and the
 * two drifting apart shows as the page stopping short of the panel.
 */
const SLIDE_MS = 260;

/** The rAF driving the current slide, if one is running. */
let slideFrame = 0;

/** Whether the browser column was open the last time it was applied. */
let browserWasOpen = false;

/**
 * Hold the native browser over its slot for the length of the slide.
 *
 * The panel is CSS and the browser is not: it is a native child surface placed
 * from Rust, so a transition moves the hole and leaves the page behind. The
 * only way they arrive together is to measure the slot every frame and say
 * where it went.
 *
 * The slot keeps its width throughout, so this is a move rather than a resize
 * — the page slides in whole and the window edge clips what has not landed.
 *
 * The terminal is refitted once, at the end. Its width is in pixels and the
 * fit reflows the entire scrollback, so doing it per frame is the one thing
 * here expensive enough to drop the frames this exists to smooth.
 */
function slideBrowser() {
  cancelAnimationFrame(slideFrame);
  const until = performance.now() + SLIDE_MS;

  const step = () => {
    pushBrowserBounds();
    if (performance.now() < until) {
      slideFrame = requestAnimationFrame(step);
      return;
    }
    slideFrame = 0;
    // The last frame lands before the transition has formally ended, so the
    // final rectangle is taken once more rather than trusted from mid-flight.
    requestAnimationFrame(() => {
      pushBrowserBounds(true);
      if (activeId !== null) syncSize(activeId);
    });
  };
  slideFrame = requestAnimationFrame(step);
}

/**
 * Show or hide the browser column according to the active terminal.
 *
 * `animate` is only true when you asked for the panel — the toggle, a link, the
 * keyboard. Switching between terminals goes straight to the answer, because
 * the panel arriving is news the first time and a delay every time after: a
 * terminal that has had a page open beside it all along should look like it
 * still does the instant you land on it, not slide it in as though it were new.
 */
function applyBrowserVisibility(animate = false) {
  const entry = activeId === null ? null : terminals.get(activeId);
  const open = !!entry && entry.browserOpen;
  const slid = animate && open !== browserWasOpen;
  browserWasOpen = open;

  els.app.classList.toggle("browser-closed", !open);
  els.browserBtn.classList.toggle("on", open);
  applyLoading();

  // The bar stays up for as long as the panel does. It used to collapse to a
  // hover strip so a browser opened as the page and nothing else, which was
  // right when the bar held only an address — but it now holds the way out of
  // the panel, and a close button you have to find by hovering is not one.
  setChrome(open);

  // Only a change of state moves anything. Switching between two terminals
  // that both have a browser swaps which page is over the slot without the
  // column going anywhere, and chasing a panel that is not moving for a
  // quarter of a second is work for nothing.
  if (slid) {
    slideBrowser();
    return;
  }

  // Nothing is animating, so stop anything that still is.
  //
  // A slide left running belongs to a state that no longer exists, and while
  // one is running the bounds are sent unclamped — that is what lets a page
  // hang off the window edge and slide in. Switching terminals part way
  // through an open then applied those unclamped bounds to a terminal whose
  // browser is shut, which is a page appearing where there should be none.
  cancelAnimationFrame(slideFrame);
  slideFrame = 0;

  // Layout has to settle before the slot's rectangle is worth measuring.
  // Forced: this runs when the panel opens or the terminal changes, and both
  // can land on a rectangle identical to the last one with a different page
  // behind it.
  requestAnimationFrame(() => {
    pushBrowserBounds(true);
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

  // A link opens a new tab rather than replacing the page you are on. The
  // whole reason for having tabs is that following something from a terminal
  // should not cost you what you were already reading.
  if (!(await addTab(entry, url))) return;

  if (!entry.browserOpen) {
    entry.browserOpen = true;
    applyBrowserVisibility(true);
    renderButtons();
  }
  renderTabs();
  saveLayoutSoon();

  els.url.value = url;
  await go();
}

async function toggleBrowser() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  entry.browserOpen = !entry.browserOpen;

  // Opening a panel with no pages in it needs one to show.
  if (entry.browserOpen && !tabsOf(entry).length) {
    if (!(await addTab(entry))) {
      entry.browserOpen = false;
      return;
    }
  }

  // Closing puts the bar away too, so the next browser opens as bare as the
  // first one did.
  if (!entry.browserOpen) setChrome(false);
  applyBrowserVisibility(true);
  renderButtons();
  renderTabs();
  saveLayoutSoon();

  // Opening one with nothing in it means you are about to go somewhere, so
  // the address bar comes out with the caret already in it rather than
  // leaving you to find it.
  const tab = activeTab(entry);
  if (entry.browserOpen && tab && tab.url === HOME_PAGE) openAddressBar();
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
  // Wrapped, not passed by reference: requestAnimationFrame hands its callback
  // a timestamp, which would arrive as the `force` argument.
  requestAnimationFrame(() => pushBrowserBounds(true));
  setTimeout(() => pushBrowserBounds(true), 60);
}

/** Bring the bar down with the caret in it, opening the browser if closed. */
function openAddressBar() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  if (!entry.browserOpen) {
    entry.browserOpen = true;
    applyBrowserVisibility(true);
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
/**
 * How long the dots keep going after the work does.
 *
 * A command is not a steady stream of output — it is bursts with gaps, and the
 * gaps are longer than the thing that measures them. Without a hold the dots
 * flicker on and off through a single build, which reads as something being
 * wrong rather than as something being underway. The hold costs nothing: a
 * terminal that finished five seconds ago is not one you were about to act on.
 */
const BUSY_HOLD_MS = 5000;

/** What a row should be showing at its right-hand end, if anything. */
function wantedState(info) {
  if (!info.alive) return "dead";

  // Shown on the terminal you are looking at as well as the ones you are not.
  // The argument for hiding it was that the output is already on screen, but a
  // row that only lights up for other terminals means the one you are in is the
  // one you cannot tell the state of at a glance — and it makes the rail read
  // differently depending on where you happen to be standing.
  const entry = terminals.get(info.id);
  const heldOver =
    entry && entry.busyAt && performance.now() - entry.busyAt < BUSY_HOLD_MS;
  if (info.busy || heldOver) return "working";
  return "";
}


/**
 * What sits at the right-hand end of a row, if anything.
 *
 * Only whether work is happening. A count of lines printed since you last
 * looked is not something anyone acts on: a build that prints nothing and a
 * build that prints ten thousand lines are the same event, and the number was
 * loudest exactly when it meant least. What is worth a mark is a terminal
 * doing something, which the spinner already says.
 */
function updateRightSlot(row, info) {
  const wanted = wantedState(info);
  const current = row.querySelector(".state");

  // The important line in this function. If the row is already showing what it
  // should be showing, it is left completely alone — because replacing it, or
  // even removing and re-adding the same thing, restarts the animation. This
  // runs several times a second, so anything else means the dots never get
  // past their first frame.
  if ((current ? current.dataset.state : "") === wanted) return;

  if (current) current.remove();
  if (!wanted) return;

  const el = document.createElement("span");
  el.className = `state ${wanted}`;
  el.dataset.state = wanted;
  // Three for work in progress, which is what makes it read as a rhythm rather
  // than as a thing that is simply on. One for a shell that has exited, which
  // is a state and not a process.
  const dots = wanted === "working" ? 3 : 1;
  for (let i = 0; i < dots; i++) {
    el.appendChild(document.createElement("i"));
  }
  row.appendChild(el);
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

  // Rows are updated in place, never rebuilt.
  //
  // This runs several times a second, and clearing the list first is what made
  // the working indicator restart before it had finished a single cycle:
  // taking an element out of the document cancels its animation, and putting a
  // new one back starts a new one from zero. Three dots that never got past
  // the first is what "it keeps refreshing" was.
  //
  // Keeping the rows also means the rail stops being rebuilt hundreds of times
  // a second while a terminal is producing output.
  const existing = new Map(
    [...els.list.children]
      .filter((el) => el.dataset && el.dataset.id)
      .map((el) => [el.dataset.id, el])
  );

  els.list.querySelectorAll(".rail-empty").forEach((el) => el.remove());

  if (!shown.length) {
    for (const el of existing.values()) el.remove();
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = infos.length ? "No terminal matches." : "No terminals.";
    els.list.appendChild(empty);
  }

  const wanted = new Set(shown.map((i) => String(i.id)));
  for (const [key, el] of existing) {
    if (!wanted.has(key)) el.remove();
  }

  let previous = null;
  for (const info of shown) {
    const key = String(info.id);
    let row = existing.get(key);
    let name;

    if (row) {
      name = row.querySelector(".name");
    } else {
      row = document.createElement("div");
      row.tabIndex = 0;
      row.dataset.id = key;
      name = document.createElement("span");
      name.className = "name";
      row.append(name);
      existing.set(key, row);
    }

    row.className = "term-btn" + (info.id === activeId ? " active" : "");

    const label = displayName(info);
    if (name.textContent !== label) name.textContent = label;

    // Rebound every pass because they close over `info`, which is a new object
    // each time even when the row it describes is the same one.
    //
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

    updateRightSlot(row, info);

    // Put it where it belongs without touching it if it is already there.
    const shouldFollow = previous ? previous.nextSibling : els.list.firstChild;
    if (row !== shouldFollow) els.list.insertBefore(row, shouldFollow);
    previous = row;
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
  const now = performance.now();
  for (const info of infos) {
    const entry = terminals.get(info.id);
    if (!entry) continue;
    entry.info = info;
    // When it was last genuinely working, so the dots can outlast the gaps
    // between one command's bursts of output. See BUSY_HOLD_MS.
    if (info.busy) entry.busyAt = now;
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

/**
 * @param force true when what is being shown has actually changed — a tab, a
 *              terminal, the panel opening. Rust skips identical layouts, and
 *              this is what tells it not to.
 */
function pushBrowserBounds(force = false) {
  const r = els.slot.getBoundingClientRect();

  // The slot is deliberately a fixed width and deliberately allowed to hang
  // out of a panel narrower than itself: that overhang is what lets the page
  // slide in whole instead of being resized on every frame.
  //
  // It is only ever correct while the panel is moving. When the layout simply
  // cannot give the panel its full width — a wide rail and a narrow window
  // leave less room than the browser was set to — the same overhang is a page
  // shoved off the side of the window, with the rest of the app laid out as
  // though nothing were wrong, because a rectangle does not know it was
  // clipped. So outside the slide, what gets sent is the part actually inside
  // the window.
  let { left, top, width, height } = { left: r.left, top: r.top, width: r.width, height: r.height };
  if (!slideFrame) {
    const right = Math.min(left + width, window.innerWidth);
    const bottom = Math.min(top + height, window.innerHeight);
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    width = Math.max(0, right - left);
    height = Math.max(0, bottom - top);
  }

  // Which page is over the slot is a tab, not a terminal: a terminal may have
  // several, and only one of them is the one you are looking at.
  const entry = activeId === null ? null : terminals.get(activeId);
  const showing = entry && entry.browserOpen ? activeTab(entry) : null;

  invoke("browser_layout", {
    active: showing ? showing.id : null,
    x: left,
    y: top,
    width,
    height,
    force,
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
  // Wrapped for the same reason as the others: a bare reference would take
  // whatever the scheduler chose to pass it as `force`.
  boundsTimer = setTimeout(() => pushBrowserBounds(), 16);
}

async function go() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  if (!entry) return;
  const tab = activeTab(entry) || (await addTab(entry));
  if (!tab) return;
  try {
    const full = await invoke("browser_navigate", { tab: tab.id, url: els.url.value });
    els.url.value = full;
    tab.url = full;
    tab.title = "";
    renderTabs();
    els.url.blur();
    entry.term.focus();
  } catch (e) {
    showError("browser", e);
  }
}

function history(action) {
  const entry = activeId === null ? null : terminals.get(activeId);
  const tab = entry && activeTab(entry);
  if (tab) invoke("browser_history", { tab: tab.id, action }).catch(console.error);
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

/**
 * How much of each terminal is written to disk, in lines.
 *
 * Lines rather than bytes because that is the unit the buffer is in, and what
 * you mean by "how far back does it go" is a number of lines.
 */
const SAVED_LINES = 3000;

/**
 * What a terminal looked like, as text that can be written back into one.
 *
 * The buffer is serialized rather than the pty output being kept, because the
 * two are not the same thing and only one of them replays. What arrives from
 * ConPTY is a stream of instructions — move to row 4, erase to end of line,
 * hide the cursor — and it is written against the screen that existed when it
 * was sent. Feeding it to an empty terminal later does not reproduce that
 * screen; it repeats the drawing, out of order and against the wrong contents.
 * ConPTY also redraws everything on every resize, so most of that stream is
 * copies of a screen you already had rather than anything you did.
 *
 * The buffer is the result of all that, already worked out, and writing it
 * back is the one thing that gives you the terminal you were looking at.
 */
/**
 * A serialized row with nothing on it: escape sequences and spaces only.
 *
 * Blank is about what the row shows, not what it contains. A row the shell
 * painted a background across still carries the codes for it, and a row the
 * cursor merely passed through carries the reset.
 */
const BLANK_ROW =
  /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[ \r])*$/;

/**
 * Drop the rows below the cursor from a snapshot.
 *
 * The serializer writes the whole screen and then walks the cursor back up to
 * where it belongs, so ten lines of output in a sixty-row window comes out as
 * ten lines, fifty empty ones, and a climb of fifty. Replayed into a fresh
 * terminal those fifty are no longer padding: they are rows, and the next save
 * writes them back with another screen's worth underneath. Restart often
 * enough and the buffer is mostly nothing, which the scrollbar then has to
 * represent — a page of output with a thumb sized for a thousand rows.
 *
 * Nothing is below them by definition, so dropping them loses nothing, and the
 * climb they were padding for shrinks by exactly the number dropped.
 */
function trimBelowCursor(text) {
  const lines = text.split("\n");
  if (lines.length < 2) return text;

  // The last line is the cursor restore, and the climb is the first thing in
  // it. No climb means the cursor was already on the last row, which is the
  // case where there is nothing under it to drop.
  const last = lines[lines.length - 1];
  const climbed = /^\x1b\[(\d+)A/.exec(last);
  if (!climbed) return text;

  let blank = 0;
  while (
    blank < lines.length - 1 &&
    BLANK_ROW.test(lines[lines.length - 2 - blank])
  ) {
    blank++;
  }
  if (!blank) return text;

  // Never climb past the row the cursor was actually on: if it was sitting
  // inside the empty run, only the part below it goes.
  const climb = Number(climbed[1]);
  const drop = Math.min(blank, climb);
  const left = climb - drop;
  const rest = last.slice(climbed[0].length);

  return [
    ...lines.slice(0, lines.length - 1 - drop),
    left > 0 ? `\x1b[${left}A${rest}` : rest,
  ].join("\n");
}

function snapshotOf(entry) {
  try {
    return trimBelowCursor(entry.serializer.serialize({ scrollback: SAVED_LINES }));
  } catch (e) {
    logInfo(`serialize failed: ${e}`);
    return "";
  }
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
          // Every page open beside this terminal, so reopening the window puts
          // the same set back rather than one of them.
          tabs: tabsOf(e).map((t) => t.url || ""),
          // The one that was on top. Written as an index because tab ids are
          // only meaningful while the window that invented them is running.
          activeTab: Math.max(
            0,
            tabsOf(e).findIndex((t) => t.id === e.activeTab)
          ),
          scrollback: snapshotOf(e),
          // Serialized text is a grid. It has to go back into one the same
          // width or every wrapped line breaks in a different place.
          cols: e.term.cols,
          rows: e.term.rows,
        };
      }),
    },
  }).catch(() => {});
}

/**
 * Sit back down in front of terminals that never stopped running.
 *
 * The warm path, and the ordinary one. The shells belong to the daemon, not to
 * this window, so most of the time closing and reopening mux does not restore
 * anything: the terminals are still there, mid-command, and all that is needed
 * is a view onto each. `makeTerminal` attaches and writes back everything that
 * happened while nobody was looking.
 *
 * What is still taken from the session file is what the daemon has no opinion
 * about — what you renamed a terminal to, and which page was open beside it.
 */
async function attachToLive(live, saved) {
  const byId = new Map((saved?.terminals ?? []).map((t) => [t.id, t]));
  let first = null;

  for (const info of live) {
    const remembered = byId.get(info.id) || {};
    const entry = makeTerminal(info.id, {
      cols: info.cols > 0 ? info.cols : 80,
      rows: info.rows > 0 ? info.rows : 24,
    });
    entry.customName = remembered.name || null;
    await restoreTabs(entry, remembered);
    if (first === null) first = info.id;
  }

  await refresh();
  // The one that was in front, not merely the first in the list.
  const wanted = saved && saved.active;
  await selectTerminal(terminals.has(wanted) ? wanted : first);
}

/**
 * Put a terminal's pages back.
 *
 * Claiming happens here rather than at save time because a browser is a live
 * webview from a fixed pool: which ones are free is only known now. A session
 * saved with more tabs than the pool can serve comes back with as many as fit,
 * in order, rather than failing to open at all.
 */
async function restoreTabs(entry, remembered) {
  const urls = Array.isArray(remembered.tabs) && remembered.tabs.length
    ? remembered.tabs
    : remembered.url
      ? [remembered.url]
      : [];

  for (const url of urls) {
    const tab = await addTab(entry, url || HOME_PAGE);
    if (!tab) break;
    // Actually load it, rather than only remembering the address.
    //
    // A tab that knows where it should be but whose browser is still on the
    // new tab page is worse than not restoring it: the poll that keeps the
    // address bar honest asks the browser where it is, is told the new tab
    // page, and writes that back over the address the session file just
    // supplied. The tab then loses its identity a second after being restored.
    if (url && url !== HOME_PAGE) {
      try {
        await invoke("browser_navigate", { tab: tab.id, url });
      } catch (e) {
        logInfo(`could not reopen ${url}: ${e}`);
      }
    }
  }

  const tabs = tabsOf(entry);
  const at = Math.min(remembered.activeTab || 0, Math.max(0, tabs.length - 1));
  entry.activeTab = tabs.length ? tabs[at].id : null;

  // Only if there is a page in it. A browser left on the new tab page comes
  // back as half a window of search box next to a terminal it has nothing to
  // do with.
  const showing = activeTab(entry);
  entry.browserOpen =
    !!remembered.browserOpen && !!showing && showing.url !== HOME_PAGE;
}

/**
 * Bring back the terminals from last time, or start one if there were none.
 *
 * The cold path, reached only when the daemon is holding nothing: the first
 * ever run, or after the machine restarted, which is the one thing no daemon
 * survives. Each terminal is then a fresh shell in the directory the old one
 * was working in, with the previous session's output replayed above it and a
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

  // Ask what is already running before deciding to rebuild anything.
  let live = [];
  try {
    live = await invoke("list_terminals");
  } catch (e) {
    logInfo(`could not ask the daemon what exists: ${e}`);
  }
  if (live.length) {
    await attachToLive(live, saved);
    return;
  }

  const wanted = saved && Array.isArray(saved.terminals) ? saved.terminals : [];
  if (!wanted.length) {
    await newTerminal();
    return;
  }

  let firstId = null;
  for (const t of wanted) {
    try {
      // The size it was, so the shell's first prompt is drawn at the width the
      // text above it was drawn at, and ConPTY is not handed a resize before
      // anyone has typed anything.
      const cols = t.cols > 0 ? t.cols : 80;
      const rows = t.rows > 0 ? t.rows : 24;
      const id = await withTimeout(
        invoke("restore_terminal", {
          shell: t.shell || null,
          cwd: t.cwd || null,
          scrollback: t.scrollback || "",
          cols,
          rows,
        }),
        10000,
        "restore_terminal"
      );
      const entry = makeTerminal(id, { cols, rows });
      entry.customName = t.name || null;
      await restoreTabs(entry, t);
      if (firstId === null) firstId = id;
    } catch (e) {
      showError("restore terminal", e);
    }
  }

  await refresh();
  // Which terminal you were looking at is part of where you left off.
  const wasActive = saved && saved.active;
  if (terminals.has(wasActive)) await selectTerminal(wasActive);
  else if (firstId !== null) await selectTerminal(firstId);
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

/**
 * Put back the widths the splitters were last left at.
 *
 * Dragging a panel to the size you want it and finding it back at the default
 * next time is the kind of thing you stop bothering to do. Stored per variable
 * name, so adding a third splitter needs nothing here.
 */
function restorePanelWidths() {
  for (const name of ["--rail-w", "--browser-w"]) {
    const saved = Number(localStorage.getItem(`mux${name}`));
    if (saved > 0) {
      document.documentElement.style.setProperty(name, `${saved}px`);
    }
  }
}

/**
 * Stop the side panels from taking a window they no longer fit in.
 *
 * The widths are remembered, and a width that was reasonable on one screen is
 * not reasonable on another: a rail dragged to seven hundred pixels on a large
 * monitor, restored on a laptop, leaves the terminal with nothing. The grid
 * already refuses to let the terminal go below its floor, but that only stops
 * it disappearing — it does not stop both panels being absurd.
 *
 * Neither side may exceed this share of the window, so the terminal always has
 * at least the rest. Applied on startup and on every resize, because a window
 * can be dragged onto a smaller screen as easily as opened on one.
 */
const MAX_PANEL_SHARE = 0.4;

function fitPanelsToWindow() {
  const ceiling = Math.max(160, Math.floor(window.innerWidth * MAX_PANEL_SHARE));
  const root = document.documentElement;
  for (const name of ["--rail-w", "--browser-w"]) {
    const current = parseFloat(getComputedStyle(root).getPropertyValue(name));
    if (current > ceiling) {
      root.style.setProperty(name, `${ceiling}px`);
      // Written back, or the next launch restores the size that did not fit.
      try {
        localStorage.setItem(`mux${name}`, String(ceiling));
      } catch {}
    }
  }
}

function makeSplitter(el, varName, opts) {
  let dragging = false;

  el.addEventListener("mousedown", (e) => {
    dragging = true;
    el.classList.add("dragging");
    // The column widths are transitioned, and a hand already moving them does
    // not want to be eased: the panel would trail the pointer by the length of
    // the slide. See `.app.dragging`.
    els.app.classList.add("dragging");
    // Out of the way for the duration. A native browser cannot be clipped by
    // the chrome, so leaving it in place while the columns move would have it
    // sitting over whatever the drag has just uncovered.
    invoke("browser_layout", { active: null, x: 0, y: 0, width: 0, height: 0 }).catch(
      () => {}
    );
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // Asked each time rather than captured once: the side a panel is on can
    // change while the app is running.
    const fromRight =
      typeof opts.fromRight === "function" ? opts.fromRight() : opts.fromRight;
    const w = fromRight ? window.innerWidth - e.clientX : e.clientX;
    const clamped = Math.max(opts.min, Math.min(opts.max, w));
    document.documentElement.style.setProperty(varName, `${clamped}px`);
    try {
      localStorage.setItem(`mux${varName}`, String(clamped));
    } catch {}
    // Deliberately not refitting the terminal here, and deliberately not
    // moving the browser either.
    //
    // Both were happening on every mousemove, and both are expensive in the
    // same way: a refit reflows the whole scrollback, which is fifty thousand
    // lines, and moving the browser resizes a native webview through an IPC
    // call. Sixty of each a second is why dragging felt like dragging
    // something heavy.
    //
    // The columns themselves are CSS and follow the pointer instantly. The
    // terminal is clipped to its panel for the length of the drag, the browser
    // is parked, and both are put right once on release — which is the only
    // size either of them was ever worth doing the work for.
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    els.app.classList.remove("dragging");
    scheduleBounds();
    if (activeId !== null) syncSize(activeId);
  });
}

// ----------------------------------------------------------------- startup

async function main() {
  wireWindowFrame();

  els.newBtn.onclick = () => newTerminal().catch((e) => showError("new terminal", e));
  els.browserBtn.onclick = toggleBrowser;

  els.tabNew.onclick = async () => {
    if (activeId === null) return;
    const entry = terminals.get(activeId);
    if (!(await addTab(entry))) return;
    if (!entry.browserOpen) {
      entry.browserOpen = true;
      applyBrowserVisibility(true);
      renderButtons();
    }
    renderTabs();
    applyBrowserVisibility();
    saveLayoutSoon();
    // A new tab is a page you are about to choose, so the caret goes where
    // you would have had to click anyway.
    openAddressBar();
  };
  els.railBtn.onclick = toggleRail;
  els.settingsBtn.onclick = (e) => {
    // Or the document listener below would shut it again on the way past.
    e.stopPropagation();
    if (els.settingsMenu.hidden) openSettings();
    else closeSettings();
  };
  els.settingsMenu.onclick = (e) => e.stopPropagation();
  document.getElementById("browser-close").onclick = toggleBrowser;

  // Before anything is measured: the columns decide where the browser goes and
  // how wide the terminal is, and both are worked out from the laid-out DOM.
  restorePanelWidths();
  fitPanelsToWindow();
  applyMirror();
  applyRail();
  document.getElementById("err-close").onclick = () => (els.err.hidden = true);

  // mux has a browser in it, so the release notes can open beside the terminal
  // rather than throwing you out to another application.
  els.updateChip.onclick = async () => {
    if (activeId === null) return;
    const entry = terminals.get(activeId);
    if (!entry.browserOpen) {
      entry.browserOpen = true;
      applyBrowserVisibility(true);
      renderButtons();
    }
    els.url.value = RELEASES_PAGE;
    await go();
  };

  /**
   * Open or shut the search.
   *
   * Shutting always clears it. A collapsed box still filtering the list is a
   * list that is missing terminals for a reason you cannot see.
   */
  const setSearchOpen = (open) => {
    els.railHead.classList.toggle("open", open);
    if (open) {
      els.filter.focus();
      return;
    }
    els.filter.value = "";
    filterText = "";
    renderButtons();
  };

  els.filterBtn.onclick = () => setSearchOpen(true);

  els.filter.addEventListener("input", () => {
    filterText = els.filter.value;
    renderButtons();
  });
  els.filter.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      setSearchOpen(false);
      els.filter.blur();
    }
  });
  // Clicking away puts it back, but only when nothing was typed: leaving a
  // search you are still reading the results of would be its own annoyance.
  els.filter.addEventListener("blur", () => {
    if (!els.filter.value) setSearchOpen(false);
  });

  // Any click anywhere puts the context menu away, including the one that
  // chose an item from it.
  document.addEventListener("click", closeRowMenu);
  window.addEventListener("blur", closeRowMenu);
  document.addEventListener("click", closeSettings);
  window.addEventListener("blur", closeSettings);

  els.url.value = HOME_PAGE;
  els.url.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") go();
    if (e.key === "Escape") closeAddressBar();
  });

  // The bar no longer hides itself.
  //
  // It used to collapse to a strip the moment the pointer left it, on the
  // argument that a browser should be the page and nothing else. That was true
  // when the bar held only an address. It now holds the address you are on,
  // the way back out of the panel, and the tabs sit above it — none of which
  // are worth hunting for by hovering, and an address you can only see by
  // pointing at it is an address you cannot read while you work.

  // The keyboard route, for when the pointer is in the terminal. Ctrl+L stays
  // the shell's.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      e.preventDefault();
      openAddressBar();
    }
    if (e.key === "Escape") {
      closeRowMenu();
      closeSettings();
    }
  });
  document.getElementById("back-btn").onclick = () => history("back");
  document.getElementById("fwd-btn").onclick = () => history("forward");
  document.getElementById("reload-btn").onclick = () => history("reload");

  // The rail's ceiling is high because a terminal named after what it is doing
  // is a sentence, not a word, and a rail too narrow to read one is a rail you
  // have to hover to use.
  makeSplitter(document.getElementById("split-term"), "--rail-w", {
    min: 170,
    max: 720,
    // Which edge a drag is measured from is the side the panel is on, and that
    // is exactly what swapping sides changes.
    fromRight: () => mirrored,
  });
  makeSplitter(document.getElementById("split-browser"), "--browser-w", {
    min: 0,
    max: 1200,
    fromRight: () => !mirrored,
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

  // The terminals live in another process. If that process goes, every one of
  // them is gone with it, and a window full of panes that quietly stopped being
  // connected to anything is the worst way to find out.
  await listen("daemon-error", (event) => showError("daemon", event.payload));

  // Every terminal's browser reports its own loading, whether or not you are
  // looking at it, so the state is kept per terminal and only the active one
  // is drawn. Switching to a terminal whose page is still coming in shows the
  // bar straight away rather than waiting for the next thing to happen.
  await listen("browser-loading", async (event) => {
    const { tab: tabId, loading } = event.payload;

    // Find whose tab this is. The event names a page, and only this side knows
    // which terminal that page belongs to.
    let owner = null;
    let tab = null;
    for (const [id, entry] of terminals) {
      const found = tabsOf(entry).find((t) => t.id === tabId);
      if (found) {
        owner = id;
        tab = found;
        break;
      }
    }
    if (!tab) return;

    tab.loading = loading;
    if (owner !== null) {
      const entry = terminals.get(owner);
      entry.loading = tabsOf(entry).some((t) => t.loading);
      if (owner === activeId) applyLoading();
    }

    // A finished page is the moment its address is finally true, so the tab is
    // named then rather than waiting for the next poll — which may not come
    // for a second, or at all while the address bar has focus.
    if (!loading) {
      try {
        const u = await invoke("browser_url", { tab: tabId });
        if (u && u !== tab.url) {
          tab.url = u;
          renderTabs();
        }
      } catch {}
    }
  });

  window.addEventListener("resize", () => {
    fitPanelsToWindow();
    scheduleBounds();
    if (activeId !== null) syncSize(activeId);
  });

  // Ctrl+scroll to resize the text. The whole font UI, and it adds no chrome.
  //
  // Captured on the way down rather than caught on the way up. The terminal's
  // own viewport handles the wheel and stops it whenever it has somewhere to
  // scroll, so bubbling only ever reached here at the very top or the very
  // bottom of the scrollback — zoom appeared to work in two places and be
  // broken everywhere else.
  els.host.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.stopPropagation();
      e.preventDefault();
      if (activeId === null) return;
      const entry = terminals.get(activeId);
      if (!entry) return;
      // Only the one in front of you. The others keep whatever they were set
      // to, which is the point of each having its own.
      const size = Math.min(
        28,
        Math.max(8, fontSizeFor(activeId) + (e.deltaY < 0 ? 1 : -1))
      );
      rememberFontSize(activeId, size);
      entry.term.options.fontSize = size;
      syncSize(activeId);
    },
    { passive: false, capture: true }
  );

  // The same gesture over the rail, sizing the rail instead. Captured for the
  // same reason: the list scrolls, so it would otherwise swallow the event
  // everywhere except at the ends.
  const RAIL_FONT_KEY = "mux.railFont";
  let railFont = Number(localStorage.getItem(RAIL_FONT_KEY)) || 13;
  const applyRailFont = () =>
    document.documentElement.style.setProperty("--rail-font", `${railFont}px`);
  applyRailFont();

  document.querySelector(".rail").addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.stopPropagation();
      e.preventDefault();
      // A wide range on purpose. The rail is the one part of this window whose
      // right size depends entirely on how you are using it: a glance-at-it
      // list of six terminals wants to be small, and a rail you are actually
      // reading names out of on a big screen wants to be much bigger than any
      // sensible default.
      railFont = Math.min(40, Math.max(8, railFont + (e.deltaY < 0 ? 1 : -1)));
      localStorage.setItem(RAIL_FONT_KEY, String(railFont));
      applyRailFont();
    },
    { passive: false, capture: true }
  );

  await restoreOrStart();
  // Starts closed unless the restored session had one open.
  applyBrowserVisibility();

  // Every terminal opens at the end of its output, not part way up it.
  //
  // Each one scrolls itself down as its history lands, but that happens before
  // the window has finished deciding how big it is: the fits that follow
  // reflow the text, and a reflow moves the bottom. Doing it once more after
  // the layout has settled is what makes "where I left off" mean the last
  // line rather than wherever the last reflow happened to leave the view.
  const settle = () => {
    for (const entry of terminals.values()) {
      entry.term.scrollToBottom();
    }
  };
  requestAnimationFrame(settle);
  setTimeout(settle, STARTUP_SETTLE_MS + 200);

  try {
    maximized = await invoke("window_is_maximized");
    refreshMaxIcon();
  } catch {}

  logInfo(`started; terminals=${terminals.size} active=${activeId}`);

  // Keep the URL bar showing wherever the active terminal's browser actually
  // ended up, including after in-page navigation we did not initiate.
  setInterval(async () => {
    if (activeId === null || document.activeElement === els.url) return;
    const entry = terminals.get(activeId);
    const tab = entry && activeTab(entry);
    if (!tab) return;
    try {
      const u = await invoke("browser_url", { tab: tab.id });
      // An empty answer means the browser is on the new tab page, which it
      // also is for the second or two a restored tab spends loading. Letting
      // that clear an address the tab already has is how a tab showing a shop
      // ends up labelled "New tab" — and if the address bar happens to have
      // focus the poll stops running, so it never corrects itself. A tab that
      // has been given an address only loses it by being sent home on purpose.
      const changed = u ? tab.url !== u : false;
      if (u) tab.url = u;
      // Guard against the tab having been switched mid-await.
      if (activeTab(terminals.get(activeId) || {}) === tab) {
        // The bar shows where the tab is meant to be, not only where the
        // browser got to. A page that failed to load — a dev server that is
        // not running, most often — leaves the browser sitting on the new tab
        // page, and blanking the bar to match hides the one thing that would
        // let you retry it. The address stays, and reload does what it says.
        const show = u || (tab.url && tab.url !== HOME_PAGE ? tab.url : "");
        if (show !== els.url.value) els.url.value = show;
        // The strip is named after the address, so it follows it — including
        // when the page navigated itself and nobody here asked it to.
        if (changed) renderTabs();
      }
    } catch {}
  }, 1000);

  // The working directory is filled in by Rust at save time; the text comes
  // from here, because the buffer only exists on this side. Saving on a timer
  // as well as on change means a crash loses seconds, not the lot.
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
