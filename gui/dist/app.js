// hmux — UI logic.
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
  toast: document.getElementById("toast"),
  winMaxIcon: document.getElementById("win-max-icon"),
  editBtn: document.getElementById("edit-btn"),
  editor: document.getElementById("editor"),
  editorText: document.getElementById("editor-text"),
  editorPath: document.getElementById("editor-path"),
  editorSave: document.getElementById("editor-save"),
  editorCancel: document.getElementById("editor-cancel"),
};

/**
 * Bring across everything the old name stored.
 *
 * Every preference this window keeps is under a `mux.` key, and the rename
 * moved them all to `hmux.` — which does not migrate anything, it abandons it.
 * The values are still in local storage, under names nothing reads any more,
 * so the rename presented as the app quietly forgetting which side the rail
 * was on, how big the text was, how wide the panels were, which terminals were
 * pinned and which background was chosen.
 *
 * Runs before the first key is read, which is why it is up here rather than
 * somewhere tidier. Copies rather than moves, and never overwrites a key that
 * already exists, so it is idempotent and an older build still finds its own.
 */
(function carryOverOldKeys() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("mux")) continue;
      const moved = `h${key}`;
      if (localStorage.getItem(moved) === null) {
        localStorage.setItem(moved, localStorage.getItem(key));
      }
    }
  } catch {
    // Storage disabled or full. The defaults are all reasonable.
  }
})();

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
const FONT_SIZES_KEY = "hmux.fontSizes";
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

// -------------------------------------------------------------------- toast
//
// One card, dropped in at the top of the terminal and taken away again. It
// carries anything the window has to say for itself that is worth a sentence
// and not worth a dialogue: an update coming down, an update waiting, and the
// answer to having asked for one when there is nothing to report.

/** Removes the card once its exit has finished, rather than mid-flight. */
let toastExit = null;

/** Auto-dismissal for the messages that do not need answering. */
let toastLife = null;

/** Whether the pages were moved aside to let the card be seen. */
let toastParked = false;

/**
 * Get the open page out from over the card, if it is over the card.
 *
 * A native webview is a child surface painted above the chrome, so no z-index
 * reaches over one: a card that overlaps an open page has that page sitting on
 * whatever part of it they share, and no amount of shadow fixes that. Moving
 * the pages off-screen is the only answer, and it is the one the old full-window
 * dialogue used unconditionally.
 *
 * Conditionally here, because it is not free. The card is 420px in the middle
 * of the window and the panel is a column at one edge, so most of the time
 * these do not touch — and taking someone's page away for a sentence that was
 * never on top of it is a worse interruption than the sentence.
 */
function parkPagesForToast() {
  const el = els.toast;
  const entry = activeId === null ? null : terminals.get(activeId);
  if (!el || el.hidden || !entry || !entry.browserOpen) return;

  const card = el.getBoundingClientRect();
  const slot = els.slot.getBoundingClientRect();
  const overlaps =
    card.right > slot.left &&
    card.left < slot.right &&
    card.bottom > slot.top &&
    card.top < slot.bottom;
  if (!overlaps) return;

  toastParked = true;
  invoke("browser_layout", {
    active: null,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    force: true,
  }).catch(() => {});
}

/**
 * Take the card away.
 *
 * `display: none` cannot simply be set here: the exit is a transition, and an
 * element that stops being displayed on the first frame of one never plays it.
 * So the class comes off, and the element goes at the far end.
 */
function hideToast() {
  clearTimeout(toastLife);
  clearTimeout(toastExit);
  toastLife = null;
  const el = els.toast;
  if (!el || el.hidden) return;
  el.classList.remove("in");
  toastExit = setTimeout(() => {
    el.hidden = true;
    el.innerHTML = "";
    el.dataset.key = "";
    // Put the page back only if it was this that took it away. Applying an
    // update never reaches here — that ends the process instead.
    if (toastParked) {
      toastParked = false;
      pushBrowserBounds(true);
    }
  }, 230);
}

/**
 * Put the card up, or update the one already there.
 *
 * `key` is what tells those two apart. A download reports itself many times a
 * second, and rebuilding the card on each would restart the bar's own
 * transition from nothing every time — the number would climb and the bar
 * would sit still, which is a worse lie than no bar at all. Same key, so the
 * same elements are kept and only the width and the text change.
 *
 * @param percent  a bar, when there is one. Zero draws an empty bar; leaving
 *                 it out draws no bar, which are different states.
 * @param action   `{ label, run }` for the card that has something to answer.
 * @param life     milliseconds before it takes itself away. Anything with an
 *                 action is left alone: a card that leaves while you are
 *                 reading the button is a card that wasted the interruption.
 */
function showToast({ key, title, body, percent, action, bad = false, life = 0 }) {
  const el = els.toast;
  if (!el) return;
  clearTimeout(toastExit);
  clearTimeout(toastLife);

  if (el.dataset.key !== key || el.hidden) {
    el.innerHTML = `
      <div class="toast-head">
        <span class="toast-title"></span>
        <button class="toast-x" title="Dismiss">✕</button>
      </div>
      <div class="toast-body"></div>
      ${percent === undefined ? "" : `<div class="toast-bar"><span></span></div>`}
      ${action ? `<button class="toast-go"></button>` : ""}`;
    el.dataset.key = key;
    el.querySelector(".toast-x").onclick = hideToast;
  }

  el.classList.toggle("bad", bad);
  el.querySelector(".toast-title").textContent = title;
  el.querySelector(".toast-body").textContent = body || "";

  const bar = el.querySelector(".toast-bar span");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;

  const go = el.querySelector(".toast-go");
  if (go && action) {
    go.textContent = action.label;
    go.onclick = () => action.run(go);
  }

  // Displayed and then, a frame later, told to arrive. Both in one go would
  // give the browser nothing to transition from: the element would be created
  // already in its final state and simply appear there.
  if (el.hidden) {
    el.hidden = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.classList.add("in");
        // Measured once it is laid out, because until then it has no rectangle
        // to compare against the page's.
        parkPagesForToast();
      })
    );
  } else {
    el.classList.add("in");
  }

  if (life) toastLife = setTimeout(hideToast, life);
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

/** The tab in the air, or null. Read by every other tab's drag handlers. */
let draggingTabId = null;

/**
 * Put `id` where `beforeId` currently is, or at the end when dropped past the
 * last tab.
 *
 * Tabs arrive in whatever order links happened to be clicked, so the one being
 * worked in ends up buried among a dozen it opened. Nothing downstream depends
 * on this array's order — a tab's browser is claimed by its id, and the pool is
 * keyed by that — so rearranging it is a pure display change and cannot put a
 * page and its webview out of step.
 */
function moveTab(entry, id, beforeId) {
  const tabs = tabsOf(entry);
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return;
  const [moved] = tabs.splice(from, 1);
  // Looked up after the removal, or every index past the one taken out is off
  // by one and a tab dragged rightwards lands one place short.
  const at = beforeId === null ? tabs.length : tabs.findIndex((t) => t.id === beforeId);
  tabs.splice(at < 0 ? tabs.length : at, 0, moved);
  renderTabs();
}

/**
 * Take the drag marks off the strip.
 *
 * `marksOnly` keeps the carried tab faded mid-drag; without it this is also the
 * cleanup that runs at the end. Both classes are always cleared rather than the
 * one just set, because the indicator that is never removed is the one that
 * leaves two insertion points drawn at once.
 */
function clearTabDropMarks(marksOnly) {
  for (const el of els.tabs.children) {
    el.classList.remove("tab-drop-before", "tab-drop-after");
    if (!marksOnly) el.classList.remove("tab-dragging");
  }
  if (!marksOnly) els.tabs.classList.remove("reordering");
}

/**
 * Add a page and claim a browser for it.
 *
 * Returns null when every browser in the pool is already spoken for, which is
 * a real limit rather than a failure: they are all built before the window
 * opens and there is no making another.
 */
/**
 * Give up the page nobody is looking at, so a new one can be opened.
 *
 * The pool is fixed and small, because a browser cannot be created after the
 * event loop starts. Running out used to be the end of it: every link click
 * after the twenty-fourth failed, and the only way back was closing tabs by
 * hand across however many terminals had one.
 *
 * Reclaiming has a real cost, which is why it was avoided at first. A page
 * taken back loses its scroll position, its forms and anything behind a login,
 * and that state is the whole argument for a browser per terminal. So the
 * victim is chosen to make it hurt as little as possible: never a tab you are
 * looking at, never the active tab of any terminal, and of what is left, the
 * one gone longest without being touched.
 *
 * Returns whether anything was freed.
 */
async function reclaimTab() {
  // Never while a session is being rebuilt.
  //
  // Restoring adds tabs one at a time, and each one becomes its terminal's
  // active tab as it arrives, which makes the one before it eligible to be
  // taken. So a restore that reached the ceiling started eating the tabs it
  // had just put back: they were claimed, then reclaimed, then failed to
  // navigate because the browser they had been given was already somewhere
  // else. The budget is what keeps a restore inside its means; reclaiming is
  // for afterwards, when there is a person choosing to open something.
  if (restoring) return false;

  let victim = null;
  for (const [, other] of terminals) {
    for (const tab of tabsOf(other)) {
      if (tab.id === other.activeTab) continue;
      if (!victim || (tab.usedAt || 0) < (victim.tab.usedAt || 0)) {
        victim = { entry: other, tab };
      }
    }
  }
  if (!victim) return false;
  logInfo(`reclaimed a browser from tab ${victim.tab.id} (${victim.tab.url})`);
  await closeTab(victim.entry, victim.tab.id);
  return true;
}

async function addTab(entry, url = HOME_PAGE) {
  const tab = { id: nextTabId++, url, title: "", usedAt: performance.now() };

  const claim = async () => {
    try {
      return await invoke("browser_claim", { tab: tab.id });
    } catch (e) {
      showError("new tab", e);
      return null;
    }
  };

  let claimed = await claim();
  if (claimed === null) return null;

  // One retry, after giving up the least recently used page.
  if (!claimed && (await reclaimTab())) {
    claimed = await claim();
    if (claimed === null) return null;
  }

  if (!claimed) {
    showError(
      "new tab",
      `all ${poolSize || "the"} browsers are open and every one of them is in front of a terminal. Close a tab.`
    );
    return null;
  }

  tabsOf(entry).push(tab);
  entry.activeTab = tab.id;
  return tab;
}

/** The real limit, asked for at startup. Zero until the answer arrives. */
let poolSize = 0;

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
  // Recency, for `reclaimTab`. Looking at a page is the only evidence there is
  // that you still want it.
  if (tab) tab.usedAt = performance.now();
  els.url.value = tab && tab.url !== HOME_PAGE ? tab.url : "";
  renderTabs();
  // The editor belongs to one tab. Leaving it puts it away without throwing it
  // away, and coming back brings it up with whatever was typed still in it.
  applyEditor();
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

    // Reordering, the same way the rail does it. Chromium does not send a click
    // after a drop, so selecting and dragging can share the element without the
    // drag ending on the tab it was dropped onto being selected.
    el.draggable = true;
    el.ondragstart = (e) => {
      draggingTabId = tab.id;
      el.classList.add("tab-dragging");
      els.tabs.classList.add("reordering");
      // Firefox refuses to start a drag without data on the transfer.
      try {
        e.dataTransfer.setData("text/plain", String(tab.id));
        e.dataTransfer.effectAllowed = "move";
      } catch {}
    };
    el.ondragend = () => {
      draggingTabId = null;
      clearTabDropMarks();
    };
    el.ondragover = (e) => {
      if (draggingTabId === null || draggingTabId === tab.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Left or right of the midpoint decides which side of this tab the drop
      // lands on, which is the only thing that lets a drop onto the last tab
      // mean "after it" rather than "before it".
      const box = el.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      clearTabDropMarks(true);
      const target = after ? el.nextElementSibling : el;
      if (target) target.classList.add("tab-drop-before");
      else el.classList.add("tab-drop-after");
    };
    el.ondrop = (e) => {
      if (draggingTabId === null || draggingTabId === tab.id) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      const ids = tabsOf(entry).map((t) => t.id);
      const at = ids.indexOf(tab.id);
      const beforeId = after ? (ids[at + 1] ?? null) : tab.id;
      const moving = draggingTabId;
      // Cleared before the move, because `moveTab` re-renders and the elements
      // carrying these classes are gone by the time it returns.
      draggingTabId = null;
      clearTabDropMarks();
      moveTab(entry, moving, beforeId);
    };

    // The site's mark, taken from the site itself rather than through a
    // favicon service: hmux would otherwise tell a third party every address
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

  // Whether Edit belongs on the bar is a fact about the address the panel is
  // showing, and this runs whenever that can have changed.
  refreshEditButton();
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
const MIRROR_KEY = "hmux.mirrored";
// Reflected by default: the terminals on the right, the page on the left.
//
// The rail is a list you glance at and the terminal is the thing you look at,
// and the window buttons are in the top right — so the side the pointer is
// already near is the side the terminal should be on. The stored value still
// wins, so a window that has been swapped stays swapped; this only decides
// what a window with no opinion yet does.
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
 * The menu under the gear: what this app is, and what you can change about it.
 *
 * Two panes in one popover rather than two menus. Settings is the only entry
 * with anything under it, and a submenu that flies out sideways from a popover
 * already pinned to the right edge of the window has nowhere to fly to.
 * Replacing the contents in place keeps it in the corner it opened in.
 *
 * There is no account row of the usual kind because there is no account. hmux
 * keeps nothing on a server and has nothing to sign in to, so the foot of the
 * menu names the Windows user — the only identity involved — and there is no
 * "log out", which would be an offer to leave somewhere you have never been.
 */
/** The project's own page. Help goes here rather than to a README on GitHub:
 *  this is the thing written for someone who wants to know what hmux is. */
const HOME_SITE = "https://hmux.hunterjreid.com/";
const HELP_PAGE = HOME_SITE;
const FEEDBACK_PAGE = "https://github.com/hunterjreid/Hmux/issues/new";

/** Hand a link to the machine's browser rather than to the panel. */
function openExternal(url) {
  invoke("open_external", { url }).catch((e) => showError("open", e));
}

/** Which pane the popover is showing: the root, or Settings. */
let settingsPane = "root";

/**
 * Where a new terminal opens.
 *
 * Empty means home, which is what a fresh console gives you. It used to mean
 * whatever directory the daemon was launched from, which is not a default so
 * much as an accident of how it was started.
 *
 * Worth being a setting because the alternative is `cd`-ing to the same place
 * as the first command in every terminal you open, and because the answer is
 * almost always one directory that does not change for weeks at a time.
 */
const START_DIR_KEY = "hmux.startdir";
let startDir = localStorage.getItem(START_DIR_KEY) || "";

function setStartDir(path) {
  const next = (path || "").trim();
  if (next === startDir) return;
  startDir = next;
  try {
    if (startDir) localStorage.setItem(START_DIR_KEY, startDir);
    // Removed rather than stored empty, so "unset" and "set to nothing" cannot
    // drift apart.
    else localStorage.removeItem(START_DIR_KEY);
  } catch {}
}

function openSettings(pane = "root") {
  settingsPane = pane;
  const menu = els.settingsMenu;
  menu.innerHTML = "";

  const icon = (href) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ico");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", href);
    svg.appendChild(use);
    return svg;
  };

  const heading = (text) => {
    const el = document.createElement("div");
    el.className = "menu-heading";
    el.textContent = text;
    menu.appendChild(el);
  };

  const separator = () => {
    const el = document.createElement("div");
    el.className = "sep";
    menu.appendChild(el);
  };

  /** A plain row: an icon, a label, and something it does. */
  const item = (href, label, onPick, { keepOpen = false, note = "" } = {}) => {
    const button = document.createElement("button");
    button.className = "row";
    button.type = "button";
    button.appendChild(icon(href));
    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);
    // A quiet value on the right of the row. Used for the version, which
    // belongs beside the thing that would change it rather than behind an
    // About dialogue you have to go looking for.
    if (note) {
      const tag = document.createElement("span");
      tag.className = "row-note";
      tag.textContent = note;
      button.appendChild(tag);
    }
    button.onclick = () => {
      if (!keepOpen) closeSettings();
      onPick();
    };
    menu.appendChild(button);
    return button;
  };

  /** One choice out of a set, with a tick on the current one. */
  const option = (label, selected, onPick) => {
    const button = document.createElement("button");
    button.className = "option" + (selected ? " on" : "");
    button.type = "button";
    button.appendChild(icon("#i-check"));
    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);
    button.onclick = () => {
      onPick();
      closeSettings();
    };
    menu.appendChild(button);
  };

  if (settingsPane === "settings") {
    item("#i-back", "Back", () => openSettings("root"), { keepOpen: true });
    separator();
    heading("Layout");
    option("Terminals on the left", !mirrored, () => {
      if (mirrored) toggleMirror();
    });
    option("Terminals on the right", mirrored, () => {
      if (!mirrored) toggleMirror();
    });

    heading("Terminal background");
    option("None", !background, () => setBackground(""));
    for (const { label, file, lit, at } of SHIPPED_BACKGROUNDS) {
      option(label, backgroundSource === file, () =>
        useShippedBackground(file, lit, at)
      );
    }

    heading("Starting directory");
    startDirField();
  } else {
    item("#i-gear", "Settings", () => openSettings("settings"), {
      keepOpen: true,
    });
    item("#i-info", "About hmux", showAbout);
    // These leave the app, unlike a link clicked in a terminal.
    //
    // The panel exists so that what you follow from a shell stays beside that
    // shell. None of these came from a shell: they are the project's own
    // pages, and putting them in the panel takes it away from whatever you had
    // open next to the terminal you were working in to read something that has
    // nothing to do with it.
    item("#i-help", "Help", () => openExternal(HELP_PAGE));
    item("#i-feedback", "Send feedback", () => openExternal(FEEDBACK_PAGE));
    item(
      "#i-download",
      "Check for updates",
      () => {
        // The six-hourly check is silent when there is nothing new. Asked for
        // explicitly, saying nothing back reads as broken.
        checkForUpdate(true).then(() => {
          if (updateReady || updateInProgress) return;
          // A failure has already said what it was. Claiming to be up to date
          // on top of it would be a second, contradictory answer.
          if (updateFailed) return;
          // Good news, so it goes in the card and not in the error bar. It
          // used to come back as a red strip along the bottom of the window
          // reading "update: you are on the newest version", which is the
          // right answer wearing the clothes of a failure.
          showToast({
            key: "update-current",
            title: "You are on the newest version",
            body: appVersion ? `Hmux v${appVersion}` : "",
            life: 3400,
          });
        });
      },
      { note: appVersion ? `v${appVersion}` : "" }
    );

    separator();

    // Not a button. There is nothing to do to it — it is here to say whose
    // machine this is, which is the whole of what hmux knows about you.
    const who = document.createElement("div");
    who.className = "menu-account";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    const name = accountName || "…";
    avatar.textContent = name.slice(0, 1).toUpperCase();
    who.appendChild(avatar);
    const label = document.createElement("span");
    label.textContent = name;
    who.appendChild(label);
    menu.appendChild(who);
  }

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

// ------------------------------------------------------- background image

/**
 * The picture behind the terminal, as a data URL, or "" for none.
 *
 * One of the shipped ones or a file of your own; both end up here in the same
 * form, because a background that stopped working when the file it came from
 * was moved would be worse than none.
 */
let background = "";

/**
 * Which of the shipped images is in use, by file, or "" for none of them.
 *
 * Kept separately because the image itself is stored as a data URL and a data
 * URL cannot say where it came from. Without this the menu could not put the
 * tick on the right row: every choice looks identical once it has been read.
 * In local storage rather than beside the image, since it is a fact about this
 * window's menu and not about the picture.
 */
const BG_SOURCE_KEY = "hmux.bgSource";
let backgroundSource = localStorage.getItem(BG_SOURCE_KEY) || "";

/**
 * One picture, and off.
 *
 * There were six, plus a file picker, plus four strength levels — which is a
 * gallery, and this is a terminal. Every one of them ends up at the same job:
 * something to rest the eye on in the dark behind the text. Six ways to do
 * that is five decisions nobody wanted to make, and the shipped images were
 * most of the download.
 *
 * `lit` and `at` are the two knobs the picture carries: how far its level is
 * pulled down before it is faded, and how far it is then faded. They live here
 * rather than in the stylesheet because the right pair depends on how bright
 * the image already is, and the image is the thing that knows.
 */
const SHIPPED_BACKGROUNDS = [
  { label: "Daybreak", file: "backgrounds/daybreak.jpg", lit: 0.45, at: 0.07 },
];

/** What a window with no opinion yet comes up with. */
const DEFAULT_BACKGROUND = SHIPPED_BACKGROUNDS[0];

/**
 * How the current background is rendered: how far its level is pulled down,
 * and how far it is then faded.
 *
 * Taken from the image rather than offered as a setting. There was a menu of
 * four strengths, which existed because one number could not serve a pale
 * daylight photograph and a near-black dither at once — but that is a fact
 * about the pictures, and the pictures are the thing that knows it. Each one
 * carries its own pair, so choosing a background is the whole of the choice.
 */
let backgroundLit = DEFAULT_BACKGROUND.lit;
let backgroundAt = DEFAULT_BACKGROUND.at;

/**
 * Put the background on, or take it off.
 *
 * xterm has to be told separately. It paints an opaque rectangle of the theme
 * background under every cell unless `allowTransparency` is on, so without
 * this the image is behind a terminal that is not see-through and nothing
 * shows. The flag costs something to have on — the renderer can no longer
 * assume what is under a glyph — which is why it is only set when there is
 * actually an image, rather than left on for everyone.
 */
function applyBackground() {
  const on = !!background;
  els.app.classList.toggle("has-bg", on);
  document.documentElement.style.setProperty(
    "--term-image",
    on ? `url("${background}")` : "none"
  );
  document.documentElement.style.setProperty(
    "--term-image-brightness",
    String(backgroundLit)
  );
  document.documentElement.style.setProperty(
    "--term-image-opacity",
    String(backgroundAt)
  );

  for (const entry of terminals.values()) {
    try {
      entry.term.options.allowTransparency = on;
      entry.term.options.theme = {
        ...THEME,
        background: on ? "rgba(0, 0, 0, 0)" : THEME.background,
      };
    } catch {
      // An older xterm that will not take these at runtime. The image still
      // shows around the text, which is most of the effect.
    }
  }
}

/**
 * A window that has never been told otherwise comes up with a background.
 *
 * `hmux.bgChosen` is what separates "never picked one" from "picked None". Both
 * leave nothing on disk, and without the flag turning the background off would
 * last until the next launch and then quietly undo itself.
 */
const BG_CHOSEN_KEY = "hmux.bgChosen";

async function loadBackground() {
  try {
    background = (await invoke("get_background")) || "";
  } catch {
    background = "";
  }

  if (!background && !localStorage.getItem(BG_CHOSEN_KEY)) {
    await useShippedBackground(
      DEFAULT_BACKGROUND.file,
      DEFAULT_BACKGROUND.lit,
      DEFAULT_BACKGROUND.at
    );
    return;
  }

  // One of the shipped images is re-read from the app rather than trusted
  // from disk.
  //
  // Choosing a background copies it into `%APPDATA%` as a data URL, which is
  // right for a file of your own: it has to keep working when the original is
  // moved. For an image that ships inside the app it is exactly wrong. The
  // copy is a snapshot of whatever the picture looked like on the day it was
  // picked, so shipping a new version of it changed nothing for anybody who
  // already had it, and the only way back was to turn the background off and
  // on again. Re-reading costs one request against a file already inside the
  // binary, and means the picture belongs to the build.
  const shipped = SHIPPED_BACKGROUNDS.find((b) => b.file === backgroundSource);
  if (shipped) {
    await useShippedBackground(shipped.file, shipped.lit, shipped.at);
    return;
  }

  applyBackground();
}

async function setBackground(data, source = "") {
  background = data || "";
  backgroundSource = background ? source : "";
  try {
    localStorage.setItem(BG_SOURCE_KEY, backgroundSource);
    // Any choice at all, including turning it off, is a choice — see
    // `BG_CHOSEN_KEY`.
    localStorage.setItem(BG_CHOSEN_KEY, "1");
  } catch {}
  applyBackground();
  try {
    await invoke("set_background", { data: background || null });
  } catch (e) {
    showError("background", e);
  }
}

/** Turn one of the shipped images into a data URL, so both kinds are alike. */
async function useShippedBackground(file, lit, at) {
  try {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const blob = await response.blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    if (lit !== undefined) backgroundLit = lit;
    if (at !== undefined) backgroundAt = at;
    await setBackground(data, file);
  } catch (e) {
    showError("background", e);
  }
}

/** The Windows user, read once. Only the profile menu wants it. */
let accountName = "";

async function loadAccountName() {
  try {
    accountName = await invoke("account_name");
  } catch {
    // The menu falls back to a placeholder rather than failing to open.
  }
}

/**
 * This build's version, read once so the menu can be built synchronously.
 *
 * The menu is drawn on click and cannot wait on a command, so asking at open
 * time would mean a row that says nothing the first time you look at it, which
 * is the one time you are most likely to be looking.
 */
let appVersion = "";

async function loadVersion() {
  try {
    appVersion = await invoke("app_version");
  } catch {}
}

/**
 * What this is and which build of it you have.
 *
 * In the card rather than a dialogue of its own: it is two lines, it is
 * dismissed the same way everything else here is, and a second modal for a
 * version number would be a whole component for one fact.
 *
 * It used to go through `showError`, which meant asking what version you were
 * running answered in a red strip across the bottom of the window, in the
 * colour the app uses for something having gone wrong. Nothing had.
 */
async function showAbout() {
  let version = "?";
  try {
    version = await invoke("app_version");
  } catch {}

  // A working copy says 0.1.0 whatever has been done to it — the release
  // workflow is what writes a real number, and only into its own build. So on
  // a local build the version is not a version, and saying so is the
  // difference between "you have an old one" and "you have your own".
  let local = false;
  try {
    local = !(await invoke("is_release_build"));
  } catch {}

  showToast({
    key: "about",
    title: local ? `Hmux v${version} (local build)` : `Hmux v${version}`,
    body: `Hunter's Terminal Multiplexer\n${HOME_SITE}`,
    life: 6000,
  });
}

/**
 * The starting-directory row: a path, and the two answers worth a button.
 *
 * A field rather than a list of options, because the answer is a path and there
 * is no set of them small enough to offer. The buttons are what make it usable
 * without a folder picker: the directory people want is nearly always either
 * the one they are already working in — which the daemon reports per terminal —
 * or their home folder, which is the empty string and not something anyone
 * should have to work out how to type.
 *
 * The path gets a line of its own and the buttons get the next one. Sharing one
 * row is what made this look broken: a menu is sized to fit its contents, and a
 * `flex: 1` field in a box that is measuring itself has nothing to be one whole
 * share OF, so it collapsed to a dark square the width of its own padding and
 * sat there next to a button, looking like a swatch that had failed to load.
 */
function startDirField() {
  const field = document.createElement("div");
  field.className = "menu-field";
  // Every click in the document closes the menu. These belong to it.
  field.onclick = (e) => e.stopPropagation();

  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.value = startDir;
  // The placeholder is the value, not a label for it: empty genuinely means
  // home, so saying so where the path would be is the whole explanation.
  input.placeholder = "Your home folder";
  input.title = "Where a new terminal opens. Leave it empty for your home folder.";
  input.onkeydown = (e) => {
    // Or the window's own shortcuts fire while typing a path.
    e.stopPropagation();
    if (e.key === "Enter") {
      setStartDir(input.value);
      closeSettings();
    }
    if (e.key === "Escape") closeSettings();
  };
  // Committed on the way out too, so clicking away is not silently a discard.
  input.onblur = () => setStartDir(input.value);
  field.appendChild(input);

  const buttons = document.createElement("div");
  buttons.className = "menu-field-row";

  const button = (label, title, run) => {
    const el = document.createElement("button");
    el.className = "menu-field-btn";
    el.type = "button";
    el.textContent = label;
    el.title = title;
    el.onclick = (e) => {
      e.stopPropagation();
      run();
    };
    buttons.appendChild(el);
  };

  button("Here", "Use the folder the current terminal is in", () => {
    const entry = activeId === null ? null : terminals.get(activeId);
    const cwd = entry && entry.info && entry.info.cwd;
    if (!cwd) {
      // The daemon works this out from the shell's own prompt, so a terminal
      // that has not printed one yet genuinely does not know where it is.
      showToast({
        key: "start-dir",
        title: "This terminal has not said where it is yet",
        body: "Hmux reads the folder from the shell's prompt. Press Enter in it and try again.",
        bad: true,
        life: 6000,
      });
      return;
    }
    input.value = cwd;
    setStartDir(cwd);
  });

  button("Home", "Open new terminals in your home folder", () => {
    input.value = "";
    setStartDir("");
  });

  field.appendChild(buttons);
  els.settingsMenu.appendChild(field);
}

function closeSettings() {
  els.settingsMenu.hidden = true;
  settingsPane = "root";
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
  // terminal reads as a frame. A step below Monokai Dimmed's own
  // editor.background: everything that is chrome keeps the theme's greys, and
  // the terminal sitting under all of them is what makes it read as a hole in
  // the window rather than one more panel.
  background: "#060606",
  foreground: "#C5C8C6",
  cursor: "#C5C8C6",
  cursorAccent: "#060606",
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
  // Toned down with the rest of the palette. The bar only appears on hover
  // now, so it no longer has to be bright enough to be ignorable — it has to
  // be dim enough not to be the brightest thing on a near-black terminal.
  scrollbarSliderBackground: "#3A3F47",
  scrollbarSliderHoverBackground: "#4E545E",
  scrollbarSliderActiveBackground: "#646A76",
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
    // Rows per notch of the wheel. xterm multiplies this by the wheel's own
    // delta over the cell height, so it is a scale on top of whatever Windows
    // reports rather than a row count. Named here so it is a number to turn
    // rather than a default to discover.
    scrollSensitivity: 1,
    // A terminal made while a background is set has to be see-through from the
    // start. `applyBackground` only reaches the terminals that already exist,
    // and a new one opened afterwards would otherwise be the single opaque
    // rectangle in a window where every other terminal shows the picture.
    allowTransparency: !!background,
    theme: background ? { ...THEME, background: "rgba(0, 0, 0, 0)" } : THEME,
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
   * Right click pastes. That is the whole gesture.
   *
   * It has been two other things. A silent copy-when-something-is-selected,
   * paste-when-nothing-is, which is what a terminal on Windows traditionally
   * does and which does whichever of the two you did not just decide you
   * wanted. Then a menu naming both, which is honest and is also two clicks and
   * a read for something done fifty times an hour.
   *
   * Both were trying to fit two jobs onto one button. Paste is the one worth
   * having there, so it is the only one there, and it does the same thing every
   * time whether or not anything is selected. Copy is Ctrl+Shift+C, below.
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

    // Copy, since right-click no longer offers it.
    //
    // Ctrl+C cannot be the one: it is the interrupt, and a terminal that
    // cannot stop a running command the way every other terminal does is
    // broken in a much more expensive way than one with an awkward copy. So
    // Ctrl+Shift+C, which is where every terminal on Windows keeps it for
    // exactly this reason.
    //
    // Handled here rather than in the window's key handler because it needs
    // this terminal's selection, and returning false is what stops the chord
    // reaching the shell as well. Guarded on keydown because xterm runs this
    // for keypress too, and one clipboard write is enough.
    if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
      if (e.type === "keydown") {
        const selection = term.getSelection();
        if (selection) {
          invoke("clipboard_write", { text: selection }).catch((err) =>
            showError("copy", err)
          );
        }
      }
      return false;
    }

    // F11 belongs to the window, not the shell. Returning false keeps xterm
    // from forwarding it down the pty, and the window handler still sees it.
    // Almost nothing in a terminal binds F11, and a fullscreen key that only
    // works when the terminal does not have focus is a fullscreen key that
    // never works.
    if (e.key === "F11") return false;
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
    // Whether this terminal is following its own output.
    //
    // The reader's intention, held as a fact, rather than a guess made from
    // where the viewport happens to be sitting at the moment somebody asks.
    // Those two used to be the same thing and are not: xterm decides whether
    // to follow the end from an `isUserScrolling` flag it sets whenever the
    // scroll element reports a smaller offset than it had, and a reflow that
    // shortens the scroll area makes the browser report exactly that. So a
    // refit — a window resize, a splitter drag, the browser panel opening,
    // arriving at a terminal that had been sized for a different layout —
    // could latch "the user has scrolled up" on a terminal nobody had touched.
    // From then on its output piled up below a viewport that never moved, and
    // switching to it landed part way up an hour of history: the random
    // position. Nothing in the buffer says which of the two happened, so the
    // gestures that mean "I am reading back" are recorded as they arrive and
    // this is what they set. See `claimedAt`.
    follow: true,
    // When the reader last did something that decides where this view sits.
    claimedAt: 0,
    // Whether a mouse button went down on this terminal and has not come up.
    // A scrollbar drag is one gesture however long it takes, and the whole of
    // it has to count as the reader's, or the second half gets fought.
    dragging: false,
    // Bookkeeping for `pinSoon`.
    pinQueued: false,
    pinTries: 0,
    pinAt: -1,
  };

  // Output lands above the viewport, and the viewport is dragged around by
  // things that are not the reader. One hook answers both.
  term.onRender(() => {
    const b = term.buffer.active;
    if (b.viewportY >= b.baseY) {
      // At the end, however it got there — output arriving, a scroll back
      // down, typing at the prompt, a buffer short enough to have no history
      // at all. Following is what this terminal is doing now.
      entry.follow = true;
      entry.pinTries = 0;
    } else if (readerDriving(entry)) {
      // Off the end, with a gesture behind it. This is somebody reading.
      entry.follow = false;
    } else if (entry.follow) {
      // Off the end with nothing to explain it: a reflow moved the view out
      // from under a terminal that was following. Put it back.
      pinSoon(entry);
    }
    if (id === activeId) refreshScrollbackState();
  });

  // What counts as the reader deciding where the view sits.
  //
  // Every one of these is captured rather than caught, so a handler that stops
  // the event on its way down — Ctrl+wheel is the zoom, not a scroll — never
  // reaches here and is never mistaken for scrolling. `mousedown` covers both
  // scrollbars, xterm's own and the browser's, and the drag-past-the-edge that
  // selecting text does; Chromium reports a press on a native scrollbar as a
  // press on the element it belongs to.
  const claim = () => {
    entry.claimedAt = performance.now();
  };
  view.addEventListener("wheel", claim, { capture: true, passive: true });
  // The only two keys that move this view. Everything else on the keyboard is
  // typing, and typing is the opposite claim: `scrollOnUserInput` has already
  // put the view back at the end by the time the key is handled. Counting
  // Enter as "I am reading back" would let a command whose output floods and
  // reflows in the same instant look like a decision to leave the end.
  view.addEventListener(
    "keydown",
    (e) => {
      if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) claim();
    },
    true
  );
  view.addEventListener(
    "mousedown",
    () => {
      entry.dragging = true;
      claim();
    },
    true
  );

  // Programs announce what they are doing through the window title; showing it
  // is free and often says more than the process name can.
  term.onTitleChange((title) => {
    entry.shellTitle = title;
    scheduleButtons();
  });
  terminals.set(id, entry);

  attachBacklog(entry, id);

  return entry;
}

/** How many times to ask for a history before going live without it. */
const BACKLOG_TRIES = 3;

/**
 * Write everything queued while attaching, and stop queueing.
 *
 * Live chunks are held until the replay's sequence number is known, because
 * anything in both places would otherwise be written twice. Once this has run
 * that question is settled and output goes straight to the screen.
 */
function goLive(entry) {
  entry.ready = true;
  for (const chunk of entry.pending) {
    if (chunk.seq > entry.lastSeq) {
      entry.term.write(chunk.data);
      entry.lastSeq = chunk.seq;
    }
  }
  entry.pending = [];
  // A restored terminal opens at the prompt, not part way up last week's
  // output. Queued behind the writes above, which is when the buffer has its
  // final length.
  entry.follow = true;
  entry.term.write("", () => entry.term.scrollToBottom());
}

/**
 * Ask for a terminal's history, and keep the terminal usable if it never comes.
 *
 * Attaching is also what subscribes this window to live output, so a failed
 * backlog used to be permanent and total: `ready` stayed false, every live
 * chunk went into `pending` and was never written, and that terminal was a
 * black rectangle for the rest of the window's life. One late reply and the
 * terminal was gone, with no way back short of reopening the window.
 *
 * The reply can be late for an entirely ordinary reason. It queues behind that
 * terminal's own output on the same pipe, so a shell printing hard pushes its
 * own history behind however much scrollback is in front of it, and opening a
 * window attaches to every terminal at once, which is exactly when that is
 * most likely. Fifteen seconds is a long timeout precisely because the wait is
 * legitimate.
 *
 * So: ask again, and if the history genuinely will not come, go live without
 * it. Missing what was said before you opened the window is a far smaller loss
 * than a terminal showing nothing at all. `lastSeq` is left at zero in that
 * case, so everything queued is written: with no replay there is nothing for it
 * to duplicate.
 */
async function attachBacklog(entry, id, attempt = 0) {
  try {
    const { text, lastSeq } = await invoke("terminal_backlog", { id });
    // Closed, or the window moved on, while we were waiting.
    if (terminals.get(id) !== entry) return;
    if (text) entry.term.write(text);
    entry.lastSeq = lastSeq;
    goLive(entry);
  } catch (e) {
    if (terminals.get(id) !== entry) return;
    if (attempt + 1 < BACKLOG_TRIES) {
      logInfo(`terminal ${id}: no history yet, asking again`);
      return attachBacklog(entry, id, attempt + 1);
    }
    showError("terminal_backlog", e);
    goLive(entry);
  }
}

/**
 * Turn a `file:///` address back into the path it was made from.
 *
 * The inverse of `toFileUrl`, and the reason the editor can exist at all: the
 * panel is handed addresses, and writing to one needs a path.
 *
 * Answers null for anything that is not a local file with a drive letter on it.
 * A `file://` URL naming a network share, or a directory listing, is a page the
 * panel can show and not a file this window has any business writing over.
 */
function fileUrlToPath(url) {
  if (!/^file:\/\//i.test(url || "")) return null;
  // Query and fragment belong to the address, not to the file.
  const rest = url.replace(/^file:\/+/i, "").split(/[?#]/)[0];
  let path;
  try {
    path = decodeURIComponent(rest);
  } catch {
    // A stray percent that is not an escape. Not ours to guess at.
    return null;
  }
  path = path.replace(/\//g, "\\");
  return /^[A-Za-z]:\\/.test(path) ? path : null;
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
 * The hard one is a bare Windows path, because the two things that end it are
 * both ambiguous. Windows filenames contain spaces, so a space cannot end a
 * path; and a path does not have to name a file, so an extension cannot be
 * required to end one either.
 *
 * The old pattern required an extension and let anything at all come before
 * it, lazily. That is wrong in both directions at once. A directory — `C:\dir\`
 * — has no extension, so the match kept going through whatever followed it
 * until it found any dot with two to six characters after it, which in
 * `C:\...\qwen3-hf-files\ (Explorer's open), 2.05 GB total:` is the `.05` of a
 * file size. Sixty characters of prose became one link. And in the other
 * direction `.safetensors` is eleven characters, so a real path to a real file
 * was not a link at all.
 *
 * What ends a path is a structural fact rather than a guess: **no segment of a
 * path begins with a space.** `My Document.txt` starts with an M and is part of
 * the path; ` and it is 2.05 GB` starts with a space and is not. That single
 * rule reads both of those correctly without knowing anything about English,
 * and it is asserted rather than consumed so that `.gitignore` — a name that is
 * nothing but its extension — still gets to start with its own dot.
 *
 * A trailing `\` is then enough on its own to make a directory a link, and the
 * whole match has to end at whitespace or punctuation. That last part is what
 * keeps every shell prompt in the window from becoming a link: `PS C:\Users\OEM>`
 * would otherwise match `C:\Users\` and underline the start of every line.
 */
const PATH_START = String.raw`(?=[^\\\r\n<>"|*?:\s])`;
const PATH_CHAR = String.raw`[^\\\r\n<>"|*?:]`;
/** A segment is only known to be one because a `\` follows it. */
const PATH_SEG = `${PATH_START}${PATH_CHAR}*\\\\`;
/** The last piece, when the path names a file rather than a directory. */
const PATH_FILE = `${PATH_START}${PATH_CHAR}*?\\.[A-Za-z0-9]{1,12}`;
/**
 * Where a path is allowed to stop. The `\.(?:\s|$)` arm is a full stop ending a
 * sentence — `Saved to C:\out\report.txt.` — rather than a suffix.
 */
const PATH_END = String.raw`(?=[\s,;:)\]}'"]|\.(?:\s|$)|$)`;
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
    find: new RegExp(
      String.raw`[A-Za-z]:\\(?:${PATH_SEG})*(?:${PATH_FILE}${PATH_END})?${PATH_END}`,
      "g"
    ),
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

/**
 * Whether the window has finished arriving at its size.
 *
 * Until it has, no native browser is placed at all — see `pushBrowserBounds`.
 * The columns are still moving, and a webview put over a rectangle taken while
 * they are is a page left hanging outside the window.
 */
let layoutReady = false;

/** How long to wait before telling the pty, given how long we have been up. */
function resizeQuiet() {
  return performance.now() - startedAt < STARTUP_SETTLE_MS
    ? STARTUP_SETTLE_MS
    : RESIZE_QUIET_MS;
}

/** Pending pty resize, per terminal. */
const resizeTimers = new Map();

/**
 * How long after a gesture the view still belongs to the reader.
 *
 * Long enough to outlast the smooth scroll a single notch of the wheel starts,
 * which is what puts several frames between the gesture and the position it
 * settles on. Short enough that a click to focus a terminal is not still
 * speaking for it by the time the next reflow lands.
 */
const CLAIM_MS = 400;

/** Whether the reader, rather than the layout, is deciding where this view sits. */
function readerDriving(entry) {
  return entry.dragging || performance.now() - entry.claimedAt < CLAIM_MS;
}

/**
 * How many frames to spend putting a following terminal back before giving up.
 *
 * A pin that cannot land must not become a pin attempted every frame for the
 * rest of the session. Fresh output resets the count, so this only ends the
 * case where nothing is changing and nothing is working.
 */
const PIN_GIVE_UP = 30;

/**
 * Put a following terminal back on its last line, at most once a frame.
 *
 * Deferred rather than done on the spot because the thing that moved the view
 * usually has not finished: `scrollToBottom` is measured against the scroll
 * element's height, and after a reflow that height is a frame behind the buffer
 * it describes. Asking on the next frame asks a layout that exists.
 */
function pinSoon(entry) {
  if (!entry.follow || entry.pinQueued) return;
  entry.pinQueued = true;
  requestAnimationFrame(() => {
    entry.pinQueued = false;
    if (!entry.follow) return;
    const b = entry.term.buffer.active;
    if (b.viewportY >= b.baseY) {
      entry.pinTries = 0;
      return;
    }
    if (b.baseY !== entry.pinAt) {
      entry.pinAt = b.baseY;
      entry.pinTries = 0;
    }
    if (entry.pinTries >= PIN_GIVE_UP) return;
    entry.pinTries++;
    entry.term.scrollToBottom();
  });
}

/**
 * The same, for the moments that take more than one frame to settle.
 *
 * Arriving at a terminal is not one reflow: the fit that runs the instant it
 * appears is followed by the panel state and the column widths for that
 * terminal, and `applyBrowserVisibility` refits again on its own schedule.
 * Every one of those rewraps a scrollback that can be fifty thousand lines and
 * moves where the bottom is. So the end is asked for at each of the moments it
 * can have moved, rather than once and hopefully.
 */
function pinBottom(entry) {
  if (!entry.follow) return;
  const pin = () => {
    if (entry.follow) entry.term.scrollToBottom();
  };
  pin();
  requestAnimationFrame(pin);
  requestAnimationFrame(() => requestAnimationFrame(pin));
  setTimeout(pin, 60);
}

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

  // Asked once, up front, and never inferred later.
  //
  // This used to decide "were you at the bottom" by whether a marker had been
  // obtained, which is a different question with the same answer most of the
  // time. `registerMarker` returns nothing when the offset it is handed is out
  // of range, which happens exactly when you have scrolled a long way back,
  // and the no-marker branch scrolled to the bottom. So scrolling up and then
  // touching anything that refits threw you to the end of the buffer: the
  // further back you were, the more likely it was to happen.
  //
  // `follow` is asked first, and it is the answer even when the viewport says
  // otherwise. A terminal that is following can already have been dragged off
  // the end by an earlier reflow — that is the bug it exists to fix — and
  // reading the viewport here would take that displacement as a place worth
  // preserving and anchor it in, one reflow deepening the last.
  const atBottom = entry.follow || buffer.viewportY >= buffer.baseY;
  const wasAt = buffer.viewportY;

  let anchor = null;
  if (!atBottom) {
    try {
      // Markers are placed relative to the cursor, so an absolute row has to
      // be expressed as a distance from it.
      anchor = entry.term.registerMarker(wasAt - (buffer.baseY + buffer.cursorY));
    } catch {
      anchor = null;
    }
  }

  try {
    change();
  } finally {
    if (atBottom) {
      // The bottom is not a line, it is wherever the last one ended up, and a
      // reflow moves that. xterm does not quite keep the viewport pinned
      // through a resize, so this is what stops the prompt you are typing at
      // sitting just above the fold.
      //
      // Twice, because the reflow is not finished here. The scroll element is
      // measured from a layout that has not been through the browser yet, so
      // this attempt is against yesterday's height; the queued one runs when
      // the number is real. The scroll event the shortened area fires arrives
      // later still, and is exactly what used to latch xterm into thinking the
      // reader had scrolled up — the second pin is what unlatches it.
      entry.term.scrollToBottom();
      pinSoon(entry);
    } else if (anchor && anchor.line >= 0) {
      entry.term.scrollToLine(anchor.line);
    } else {
      // Scrolled back, but no marker survived: the line it watched fell out of
      // the scrollback, or one could not be made. Hold the row number we had
      // rather than jumping to the end, which is wrong by however far you had
      // scrolled and is the one outcome you would notice.
      const now = entry.term.buffer.active;
      entry.term.scrollToLine(Math.max(0, Math.min(wasAt, now.baseY)));
    }
    if (anchor) anchor.dispose();
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
/**
 * Below this the box is not a terminal, it is a box mid-layout.
 *
 * The grid gives the terminal a floor of 220px and the window has a minimum
 * size, so a host narrower than this is never a real state anybody is looking
 * at — it is the width during a collapse, a slide, or the moment before the
 * columns are first resolved.
 */
const FIT_FLOOR_PX = 140;

function fitTerminal(id, entry) {
  if (!entry || entry.view.offsetParent === null) return;

  // Never fit to a box that is not really there yet.
  //
  // A fit is destructive in a way that reading a size is not: it writes a
  // column count into the terminal and reflows the whole scrollback to match,
  // and nothing afterwards knows the number was nonsense. Measuring the host
  // at a few pixels — which happens while a panel is collapsing, and happened
  // on startup before the columns had resolved — put the terminal at three
  // columns and left it there, wrapping every line into a ribbon down the side
  // of an empty pane. Skipping is safe because anything that changes the box
  // fires the observer again once it has a real width.
  const box = els.host;
  if (box.clientWidth < FIT_FLOOR_PX || box.clientHeight < 40) return;

  // Ask what it would do before letting it do it.
  //
  // `fit` measures and applies in one step, and applying is the destructive
  // half: it writes the column count and reflows the entire scrollback to
  // match, and nothing downstream can tell that the number was nonsense. The
  // addon divides the box by a cell size it measures from the DOM, and that
  // measurement comes back wrong if it is taken before the font has loaded —
  // a cell far wider than the real one, and a column count in single digits.
  // Reading the proposal first means a bad measurement costs nothing.
  let proposed = null;
  try {
    proposed = entry.fit.proposeDimensions();
  } catch {
    return;
  }
  if (!proposed || !proposed.cols || !proposed.rows) return;
  if (proposed.cols < 10 && box.clientWidth > 400) return;

  // A fit that would change nothing does nothing.
  //
  // This is the important one for scrolling. The observer fires on any change
  // to the box, and almost all of those settle on the size the terminal is
  // already at, but the fit still ran: it reflowed, and then put the viewport
  // back where it thought you were. Every one of those is a chance to be
  // wrong, and being wrong looks like the page jumping while you scroll. Doing
  // nothing when there is nothing to do removes the whole class of it.
  if (proposed.cols === entry.term.cols && proposed.rows === entry.term.rows) {
    return;
  }

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
/**
 * Whether the terminal on screen has anything above the viewport.
 *
 * `baseY` is how many lines have scrolled off the top, so zero means the whole
 * buffer fits and there is nowhere to go back to. xterm reserves its scrollbar
 * either way, which on a freshly opened terminal drew a slider filling its own
 * track: a control that is telling you there is nothing to scroll, by being
 * the same size as the thing it scrolls.
 *
 * Cheap enough to call from the render hook. It reads one number and only
 * touches the DOM when the answer changes.
 */
let hasScrollback = false;

function refreshScrollbackState() {
  const entry = activeId === null ? null : terminals.get(activeId);
  const has = !!entry && entry.term.buffer.active.baseY > 0;
  if (has === hasScrollback) return;
  hasScrollback = has;
  els.host.classList.toggle("has-scrollback", has);
}

async function selectTerminal(id) {
  if (!terminals.has(id)) return;
  activeId = id;

  for (const [tid, entry] of terminals) {
    entry.view.classList.toggle("visible", tid === id);
  }

  // The new terminal has its own buffer and its own answer.
  refreshScrollbackState();

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
  // Same as switching tabs: the editor is one tab's, so arriving at a different
  // terminal puts it away rather than dragging it along.
  applyEditor();

  syncSize(id);
  entry.term.focus();
  renderButtons();

  // Whether this terminal was at the end is not read off the viewport here.
  //
  // It cannot be. The terminal you are arriving at has spent its time hidden,
  // and hidden is where a view drifts: it was refitted to follow the visible
  // one, the panel beside it opened and shut, the window changed size, and any
  // of those can leave xterm convinced somebody scrolled it up. Asking the
  // viewport gets the answer for what those did rather than for what you did,
  // which is a terminal you left at its prompt coming back part way up an hour
  // of history. `follow` is the answer to the question actually being asked.
  pinBottom(entry);
}

/**
 * The file the editor is open on, or null.
 *
 * Bound to the terminal and the tab it was opened from, rather than to the
 * window. Every terminal has its own browser and its own tabs, so an editor
 * that belonged to the window would follow you to a terminal it has nothing to
 * do with. Switching away hides it and leaves the text where it is; switching
 * back brings it up unchanged.
 *
 * `loaded` is the text as it came off disk, and the only thing "has this been
 * edited" is ever asked of. Comparing against it rather than tracking a flag
 * means typing something and undoing it leaves the file alone.
 */
let editing = null;

/** Whether the editor is on screen, rather than merely open. */
function editorShowing() {
  if (!editing || editing.termId !== activeId) return false;
  const entry = terminals.get(activeId);
  if (!entry || !entry.browserOpen) return false;
  const tab = activeTab(entry);
  return !!tab && tab.id === editing.tabId;
}

/** Whether what is in the box differs from what is on disk. */
function editorDirty() {
  return !!editing && els.editorText.value !== editing.loaded;
}

/** The last part of a path, for saying which file without saying where. */
function baseName(path) {
  const at = path.lastIndexOf("\\");
  return at < 0 ? path : path.slice(at + 1);
}

/** Show or hide the editor, and move the page out from under it or back. */
function applyEditor() {
  const showing = editorShowing();
  els.editor.hidden = !showing;
  els.editorSave.disabled = !editorDirty();
  refreshEditButton();
  pushBrowserBounds(true);
  if (showing) els.editorText.focus();
}

/**
 * Offer the Edit button for a local file, and only for a local file.
 *
 * A `file://` address is the only kind this window can write back, so it is the
 * only kind the button appears for. Hidden while the editor is up, because at
 * that point it would open the thing already open.
 */
function refreshEditButton() {
  const entry = activeId === null ? null : terminals.get(activeId);
  const tab = entry && entry.browserOpen ? activeTab(entry) : null;
  const path = tab ? fileUrlToPath(tab.url) : null;
  els.editBtn.hidden = !path || editorShowing();
}

/** Read the file the panel is showing into the editor. */
async function openEditor() {
  const entry = activeId === null ? null : terminals.get(activeId);
  const tab = entry && activeTab(entry);
  const path = tab ? fileUrlToPath(tab.url) : null;
  if (!path) return;

  // One editor at a time, and opening a second over unsaved work would be the
  // quickest way to lose it. Refused rather than asked about: a confirm in this
  // window blocks the whole webview, terminals included, until it is answered.
  if (editing && editorDirty() && editing.path !== path) {
    showError("edit", `save or cancel ${baseName(editing.path)} first`);
    return;
  }

  let file;
  try {
    file = await invoke("read_text_file", { path });
  } catch (e) {
    showError("edit", e);
    return;
  }

  editing = {
    termId: activeId,
    tabId: tab.id,
    path,
    crlf: file.crlf,
    loaded: file.text,
  };
  els.editorText.value = file.text;
  els.editorPath.textContent = path;
  applyEditor();
}

/** Write it back, then show the panel the file it now is. */
async function saveEditor() {
  if (!editing || !editorDirty()) return;
  const { path, crlf } = editing;
  const text = els.editorText.value;
  try {
    await invoke("write_text_file", { path, text, crlf });
  } catch (e) {
    showError("save", e);
    return;
  }
  editing.loaded = text;
  closeEditor();
  // The page under the editor is the file as it was before the save, so it has
  // to be asked for again or closing the editor reveals a stale copy of what
  // was just changed.
  history("reload");
}

/** Put the editor away. Whatever is in the box is discarded. */
function closeEditor() {
  editing = null;
  els.editorText.value = "";
  els.editorPath.textContent = "";
  applyEditor();
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

  // Switching terminals is not an animation.
  //
  // `animate` already decided not to run the slide, but the slide was only
  // ever the native page being carried along — the columns themselves are
  // transitioned in the stylesheet and moved anyway. So going from a terminal
  // with a page open to one without played the panel closing, and going back
  // played it opening, for a change you did not make to a panel you were not
  // touching. Clicking down a rail of terminals became the window opening and
  // shutting under you.
  //
  // The transition is suppressed for exactly the frame the columns change in,
  // the same way a splitter drag does it, and restored immediately after so
  // that opening the panel on purpose still slides.
  if (!slid) els.app.classList.add("no-slide");

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

  // Off again once the columns have taken their new width, so an intentional
  // open still slides. Two frames: one for the change to be applied, one for
  // it to have been painted without a transition attached.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => els.app.classList.remove("no-slide"))
  );

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
/**
 * Whether two addresses point at the same page.
 *
 * Loose on purpose: a scheme that was not typed, a trailing slash, and a
 * default port are all differences that no one means. Anything more than that
 * is a different page and gets its own tab.
 */
function sameAddress(a, b) {
  const key = (raw) => {
    if (!raw) return "";
    let v = String(raw).trim().toLowerCase();
    if (!/^[a-z]+:/.test(v)) v = `http://${v}`;
    try {
      const u = new URL(v);
      const port = (u.protocol === "http:" && u.port === "80") ||
        (u.protocol === "https:" && u.port === "443")
        ? ""
        : u.port;
      const path = u.pathname.replace(/\/+$/, "");
      return `${u.protocol}//${u.hostname}${port ? ":" + port : ""}${path}${u.search}`;
    } catch {
      return v.replace(/\/+$/, "");
    }
  };
  return key(a) === key(b);
}

async function openInBrowserPanel(id, url) {
  const entry = terminals.get(id);
  if (!entry || !url) return;

  if (id !== activeId) await selectTerminal(id);

  // Already open beside this terminal? Go to it rather than opening it twice.
  //
  // Every click used to take a browser out of the pool and never give it back,
  // so clicking the same dev-server link six times cost six of the twenty-four
  // and left six identical tabs. Reaching the ceiling that way is not a limit
  // anyone hit deliberately: it is the same page, and the second copy of it
  // was never wanted.
  //
  // Compared after normalising, because the address that comes back from a
  // navigate has been through `normalise_url` and the one in a terminal's
  // output has not: `127.0.0.1:5180` and `http://127.0.0.1:5180/` are the same
  // page and would otherwise be two tabs.
  const same = (a, b) => sameAddress(a, b);
  const existing = tabsOf(entry).find((t) => same(t.url, url));
  if (existing) {
    entry.activeTab = existing.id;
    existing.usedAt = performance.now();
    if (!entry.browserOpen) {
      entry.browserOpen = true;
      applyBrowserVisibility(true);
      renderButtons();
    }
    renderTabs();
    els.url.value = existing.url;
    pushBrowserBounds(true);
    saveLayoutSoon();
    return;
  }

  const tab = await addTab(entry, url);

  // The panel opens whether or not a page could be had.
  //
  // This used to return here when no browser was free, which is every time the
  // pool is spoken for, and it returned without opening anything and without
  // saying anything. Clicking a link in a terminal did nothing at all: no
  // panel, no page, no error, no way to tell the difference between a link
  // that failed and one that was never a link. The panel carries the note
  // explaining the limit, so opening it is what makes the limit visible.
  if (!entry.browserOpen) {
    entry.browserOpen = true;
    applyBrowserVisibility(true);
    renderButtons();
  }
  renderTabs();
  saveLayoutSoon();

  if (!tab) {
    showError("open", "every browser is in use. Close a tab to free one.");
    return;
  }

  // Bring the page you just opened to the front.
  //
  // `addTab` makes the new tab this terminal's active one, but that is this
  // window's own bookkeeping: which webview is actually over the slot is
  // Rust's, and it changes only when it is told. Told here, because nothing
  // else on this path does — the slide only runs when the panel was shut, so
  // a link clicked with the panel already open opened its tab, moved the
  // highlight in the strip, and left the previous page on screen. The strip
  // said one thing and the panel showed another, and the page you asked for
  // was the one you could not see.
  //
  // Before navigating rather than after, so the new page is the one you watch
  // load.
  pushBrowserBounds(true);

  els.url.value = url;
  await go();
}

async function toggleBrowser() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  entry.browserOpen = !entry.browserOpen;

  // Opening a panel with no pages in it needs one to show.
  //
  // It opens either way. This used to give up and leave `browserOpen` false
  // when no page could be had, which happens as soon as the browser pool is
  // spoken for — and the pool is twelve for the whole window, so a few
  // terminals with a few tabs each reach it easily. The button then did
  // nothing at all, with no panel and no reason given, which reads as a broken
  // button rather than as a limit. The panel is the user's to open; the note
  // inside it is where "there is no browser free" belongs.
  if (entry.browserOpen && !tabsOf(entry).length) {
    await addTab(entry);
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

/**
 * Whether F11 is currently on.
 *
 * Kept so the title bar can stop being a drag surface. Rust refuses the drag
 * anyway, since the window can enter fullscreen without the page asking, but
 * knowing here means the double click does not maximise a window that is
 * already covering the screen, and the pointer does not claim it can move
 * something it cannot.
 */
let fullscreen = false;

/**
 * Match the window buttons to what the window can actually do.
 *
 * Maximise is not one of them in fullscreen. The window is already the whole
 * screen, so the button either does nothing or does something confusing, and
 * the glyph on it is a lie either way: the square says "make this bigger" when
 * there is no bigger, and swapping it for the restore glyph says "put it back"
 * when what puts it back is F11. A control with no meaningful state is better
 * gone than mislabelled, and minimise and close both still mean what they say.
 */
function refreshMaxIcon() {
  els.winMaxIcon.setAttribute("href", maximized ? "#i-restore" : "#i-max");
  els.app.classList.toggle("fullscreen", fullscreen);
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
    // Fullscreen is not a window you move.
    if (fullscreen) return;
    if (e.target.closest("button, input, .menu, .tb-name")) return;
    if (!e.target.closest("[data-drag]")) return;
    invoke("window_start_drag").catch(() => {});
  });

  els.titlebar.addEventListener("dblclick", (e) => {
    // Nor one you maximise: it is already bigger than maximised, and toggling
    // it here would leave the window fullscreen and unmaximised at once, which
    // only F11 could then undo.
    if (fullscreen) return;
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
  // Longer than the daemon client's own wait, deliberately.
  //
  // This was ten seconds against a fifteen second timeout on the Rust side, so
  // the window gave up first and reported a failure for a shell that was in
  // fact being started: the daemon logged `spawned powershell.exe` and the
  // reply arrived to nobody. Two authorities disagreeing about how long to
  // wait is worse than either number, because the shorter one turns a slow
  // success into an error and an orphan.
  //
  // It is slow in the first place because a reply queues behind terminal
  // output on the same stream, so a create issued while something is printing
  // hard waits for it. `refresh` adopts anything that turns up regardless, so
  // the worst case is now a pause rather than a lost terminal.
  // 80x24 is a placeholder; the real size is sent by syncSize once laid out.
  const id = await withTimeout(
    invoke("create_terminal", {
      shell,
      // Null rather than "", so the daemon can tell "no preference" from a
      // path that happens to be empty.
      cwd: startDir || null,
      cols: 80,
      rows: 24,
    }),
    20000,
    "create_terminal"
  );
  makeTerminal(id);
  await refresh();
  await selectTerminal(id);
  syncSize(id);
  saveLayoutSoon();
  return id;
}

/** The rail's current order, set by `refresh`. */
let railIds = [];

/**
 * Terminals this window has closed, until the daemon stops listing them.
 *
 * `close_terminal` sends and does not wait, and `list_terminals` answers from a
 * cached list the daemon refreshes by event, so the `refresh` at the end of a
 * close almost always still contains the terminal that was just closed. What
 * happened then is that adoption did its job perfectly: an id the daemon
 * reports and this window does not have is exactly the case it exists for, so
 * it attached to the terminal it had closed a moment earlier. That is a fifteen
 * second wait for a reply that can never come, then "the daemon did not send
 * terminal N's history", and a row that reappears in the rail after you closed
 * it and then dies. Closing several in a row stacks those waits up, which is
 * the part that looks like the window is about to go.
 *
 * A tombstone rather than a synchronous close: making the close wait for the
 * daemon would put the fifteen seconds on the click instead of after it.
 *
 * Lifted once several listings in a row agree the terminal is gone, rather than
 * on the first one that leaves it out — which is what let all of the above
 * happen anyway. `list_terminals` answers from a cached list the daemon
 * refreshes by event, and the `terminals` event is pushed rather than asked
 * for, so a snapshot taken before the close can arrive after one taken after
 * it. The first listing without the id lifted the tombstone; the stale one
 * behind it still had the id, found no tombstone in its way, and adopted a
 * terminal that no longer existed. One listing is not evidence of anything
 * here, and a listing that still names the terminal puts the count back to
 * nothing, so a straggler can only ever delay the lifting rather than defeat
 * it.
 *
 * Lifted at all only because the daemon's ids start again when it does. Within
 * one daemon they are a counter that is incremented and never reused, so a
 * closed id can never legitimately come back and being slow about this costs
 * nothing.
 */
const closed = new Map();

/**
 * How many listings in a row have to leave a closed terminal out before its
 * tombstone goes. Three, because the thing being outlasted is a queue rather
 * than a clock, and a count needs no guess about how far behind it can be.
 */
const CLOSED_AGREED = 3;

/**
 * Update the tombstones against one listing, and lift the ones it has outlived.
 *
 * Split out because it is the whole of the rule, and a rule about a race is
 * worth being able to drive directly rather than only through the thing that
 * calls it.
 */
function forgetClosed(infos) {
  for (const [id, agreed] of closed) {
    if (infos.some((i) => i.id === id)) {
      // Still listed. Either the close has not been processed yet or this
      // snapshot predates it, and there is no way to tell which from here, so
      // the count starts again either way.
      closed.set(id, 0);
    } else if (agreed + 1 >= CLOSED_AGREED) {
      closed.delete(id);
    } else {
      closed.set(id, agreed + 1);
    }
  }
}

async function closeTerminal(id) {
  closed.set(id, 0);
  await invoke("close_terminal", { id }).catch(console.error);
  const entry = terminals.get(id);
  if (entry) {
    entry.term.dispose();
    entry.view.remove();
    terminals.delete(id);
  }
  if (activeId === id) {
    activeId = null;
    // Hand over to the neighbour in the rail: the one below, or the one above
    // when the last row was closed.
    //
    // It used to take the first entry in the terminals map, which is creation
    // order, so closing anything threw you to the oldest terminal you had open
    // regardless of where you were. Closing three in a row meant three jumps
    // to somewhere you were not.
    const at = railIds.indexOf(id);
    const below = at < 0 ? undefined : railIds.slice(at + 1).find((x) => terminals.has(x));
    const above =
      at <= 0
        ? undefined
        : [...railIds.slice(0, at)].reverse().find((x) => terminals.has(x));
    const next = below ?? above ?? terminals.keys().next().value;
    if (next !== undefined) await selectTerminal(next);
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
/**
 * The spinner.
 *
 * Twenty of these were built and looked at side by side. Fade is the quietest
 * of them and the one that survives being on screen all day: brightness
 * travelling along three dots that never move, so nothing in the rail shifts
 * position while you are reading a name next to it.
 *
 * The other nineteen are still in `app.css` and still work. Putting any of
 * them back is one word here.
 */
const SPINNER = "v-fade";

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
  if (wanted === "working") el.classList.add(SPINNER);
  el.dataset.state = wanted;
  // Three for work in progress, which is what makes it read as a rhythm rather
  // than as a thing that is simply on. One for a shell that has exited, which
  // is a state and not a process.
  const dots = wanted === "working" ? 3 : 1;
  for (let i = 0; i < dots; i++) {
    el.appendChild(document.createElement("i"));
  }
  row.appendChild(el);
  startTogether(el);
}

/**
 * Start this indicator's animation where every other one already is.
 *
 * A CSS animation begins when its element does, and these elements are made
 * whenever a terminal happens to start working. Four rows working at once were
 * therefore four copies of the same fade at four unrelated points in it. Each
 * one correct, and the column of them reading as noise: the eye is offered a
 * rhythm and finds four.
 *
 * Setting `startTime` to zero says the animation began at the document's own
 * time origin — a moment every indicator agrees on however long after it each
 * was created, so their phases come out identical rather than merely close.
 *
 * The alternative was a negative `animation-delay`, and it is worse twice over:
 * it would have to know the duration in JavaScript alongside a stylesheet that
 * already states it, and it would still land a frame out, because an animation
 * starts on the frame after its element is appended rather than at the moment
 * the delay was worked out.
 *
 * The stagger between the three dots is part of each animation's own delay, so
 * it survives untouched — they still travel, now together with every other row.
 */
function startTogether(el) {
  try {
    // The animations exist only once style has been resolved for the element
    // just appended, and asking is what forces that. Nothing to synchronise is
    // an ordinary answer: the dead marker is a dot that does not move.
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.startTime = 0;
    }
  } catch {
    // Out of step is the look this exists to fix, not a broken rail. Whatever
    // this row ends up doing, it must not be the thing that stops the list
    // being drawn.
  }
}

// ------------------------------------------------------- rail context menu

function closeRowMenu() {
  els.rowMenu.hidden = true;
}

/**
 * Build the context menu at the pointer and show it.
 *
 * One menu element for every right-click in the window, so two can never be
 * open at once and the close-on-click, Escape and blur handlers already wired
 * to it cover any new caller without being told about it.
 *
 * An entry is `{label, action, danger, disabled}`; a null entry is a
 * separator. A disabled entry is still drawn, because a row that is greyed out
 * says why nothing will happen, and a row that is absent says nothing at all.
 */
function openContextMenu(x, y, items) {
  const menu = els.rowMenu;
  menu.innerHTML = "";

  for (const spec of items) {
    if (!spec) {
      const separator = document.createElement("div");
      separator.className = "sep";
      menu.appendChild(separator);
      continue;
    }

    const button = document.createElement("button");
    button.textContent = spec.label;
    if (spec.danger) button.className = "danger";
    if (spec.disabled) {
      button.disabled = true;
    } else {
      button.onclick = (e) => {
        e.stopPropagation();
        closeRowMenu();
        spec.action();
      };
    }
    menu.appendChild(button);
  }

  // Shown before measuring, since a hidden element has no size, then nudged
  // back inside the window if it would hang off an edge.
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 6))}px`;
}

/**
 * Right-click on a terminal in the rail.
 *
 * Lives at the top level of the document rather than inside the row, because
 * the rail is rebuilt from scratch on every repaint and a menu parented to a
 * row would vanish underneath the pointer the next time a status changed.
 */
/**
 * Terminals held at the top of the rail, by id.
 *
 * In local storage rather than the session file, and by id rather than by
 * name, because pinning is about this window's list and not about the shell:
 * it says where you want to find something, which is a fact about the rail.
 *
 * The ids come from the daemon and are reused after a reboot, so a stale pin
 * can land on a terminal that is not the one that was pinned. That is a wrong
 * row near the top of a list, which costs a right-click to undo, and the
 * alternative — dropping every pin whenever the daemon restarts — costs them
 * all every time. The cheaper mistake wins.
 */
const PINNED_KEY = "hmux.pinned";
const pinned = new Set(
  (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PINNED_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n)) : [];
    } catch {
      return [];
    }
  })()
);

/**
 * The order you dragged the rail into, by id.
 *
 * Only ids that have been moved appear here. Anything else keeps the daemon's
 * order, which is the order terminals were started, so a rail nobody has
 * rearranged behaves exactly as it did before.
 */
const ORDER_KEY = "hmux.order";
let railOrder = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
})();

function saveRailOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(railOrder));
  } catch {}
}

/**
 * Put `id` where `beforeId` currently is, or at the end when dropped past the
 * last row.
 *
 * The list is rebuilt from what is on screen rather than patched, so an order
 * containing terminals that have since closed cannot drift out of step with
 * the rail.
 */
function moveRow(id, beforeId, visibleIds) {
  const order = visibleIds.filter((x) => x !== id);
  const at = beforeId === null ? order.length : order.indexOf(beforeId);
  order.splice(at < 0 ? order.length : at, 0, id);
  railOrder = order;
  saveRailOrder();
  refresh();
}

function savePinned() {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]));
  } catch {}
}

function togglePinned(id) {
  if (pinned.has(id)) pinned.delete(id);
  else pinned.add(id);
  savePinned();
  refresh();
}

/** The row currently being dragged, or null. */
let draggingId = null;

function openRowMenu(id, x, y) {
  const entry = terminals.get(id);
  if (!entry) return;

  openContextMenu(x, y, [
    {
      label: "Rename",
      action: async () => {
        // After selecting, so the row is certainly there and certainly the one
        // being looked at. Its label is found in the freshly built rail rather
        // than captured before, which would be a reference to a discarded node.
        await selectTerminal(id);
        const row = [...els.list.children].find(
          (r) => r.dataset.id === String(id)
        );
        const label = row && row.querySelector(".name");
        if (label) beginRename(id, label);
      },
    },
    {
      label: pinned.has(id) ? "Unpin" : "Pin to top",
      action: () => togglePinned(id),
    },
    {
      label: entry.browserOpen ? "Hide browser" : "Show browser",
      action: async () => {
        await selectTerminal(id);
        toggleBrowser();
      },
    },
    null,
    {
      label: "Close terminal",
      danger: true,
      action: () => {
        closeTerminal(id).catch((e) => showError("close terminal", e));
      },
    },
  ]);
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
  const matching = needle
    ? infos.filter((i) => displayName(i).toLowerCase().includes(needle))
    : infos;

  // Pinned first, then whatever order the rail has been dragged into, then
  // the daemon's own, which is the order the terminals were started in.
  //
  // A stable sort, so anything not covered by the two keys above does not
  // move: a rail that reshuffled itself for a reason you did not ask for costs
  // you the muscle memory of where each terminal sits, which is most of what
  // the rail is for.
  const rank = (id) => {
    const at = railOrder.indexOf(id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const shown = [...matching].sort((a, b) => {
    const pin = (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0);
    if (pin) return pin;
    return rank(a.id) - rank(b.id);
  });

  // Kept so closing a terminal can hand over to its neighbour rather than to
  // whichever one happens to be oldest; see `closeTerminal`.
  railIds = shown.map((i) => i.id);

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
      // Dragged by the row itself. A separate grip would be one more thing in
      // a row whose whole point is that it is a name and nothing else.
      row.draggable = true;

      name = document.createElement("span");
      name.className = "name";

      // The pin sits inside the name, before the text, so it is part of the
      // label rather than a second column. It is `display: none` until the row
      // is pinned, which keeps the markup the same for every row and means
      // pinning does not rebuild anything.
      const pin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      pin.setAttribute("class", "pin");
      const pinUse = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "use"
      );
      pinUse.setAttribute("href", "#i-pin");
      pin.appendChild(pinUse);
      name.appendChild(pin);
      name.appendChild(document.createElement("span"));

      row.append(name);
      existing.set(key, row);
    }

    row.className =
      "term-btn" +
      (info.id === activeId ? " active" : "") +
      (pinned.has(info.id) ? " pinned" : "");

    const label = displayName(info);
    // The last child, because the first is the pin.
    const text = name.lastElementChild || name;
    if (text.textContent !== label) text.textContent = label;

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
    row.ondragstart = (e) => {
      draggingId = info.id;
      row.classList.add("dragging-row");
      // Marks the whole list as a drop target for the duration, which is what
      // makes it obvious the rail is the thing you are dropping into rather
      // than something you happen to be dragging over.
      els.list.classList.add("reordering");
      // Firefox refuses to start a drag without data on the transfer.
      try {
        e.dataTransfer.setData("text/plain", key);
        e.dataTransfer.effectAllowed = "move";
      } catch {}
    };
    row.ondragend = () => {
      draggingId = null;
      els.list.classList.remove("reordering");
      for (const el of els.list.children) {
        el.classList.remove("dragging-row", "drop-before", "drop-after");
      }
    };
    row.ondragover = (e) => {
      if (draggingId === null || draggingId === info.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Above or below the midpoint decides which side of this row the drop
      // lands on, which is the only thing that makes dropping onto the last
      // row able to mean "after it".
      const box = row.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      // Both classes cleared, not just one. `drop-after` was only ever added
      // and never removed, so once you had hovered past the last row that line
      // stayed drawn for the rest of the drag and the rail showed two
      // insertion points at once.
      for (const el of els.list.children) {
        el.classList.remove("drop-before", "drop-after");
      }
      const target = after ? row.nextElementSibling : row;
      if (target) target.classList.add("drop-before");
      else row.classList.add("drop-after");
    };
    row.ondrop = (e) => {
      if (draggingId === null || draggingId === info.id) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      const ids = shown.map((i) => i.id);
      const at = ids.indexOf(info.id);
      const beforeId = after ? (ids[at + 1] ?? null) : info.id;
      // Pinned and unpinned are separate groups in the sort, so a row dragged
      // across that line has to change group or it would spring back.
      if (pinned.has(info.id) !== pinned.has(draggingId)) {
        if (pinned.has(info.id)) pinned.add(draggingId);
        else pinned.delete(draggingId);
        savePinned();
      }
      els.list.classList.remove("reordering");
      for (const el of els.list.children) {
        el.classList.remove("dragging-row", "drop-before", "drop-after");
      }
      moveRow(draggingId, beforeId, ids);
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
  document.title = active ? `${displayName(active)} — Hmux` : "Hmux";
}

/** Guards against a second poll adopting the same terminal mid-attach. */
const adopting = new Set();

async function refresh() {
  try {
    applyInfos(await invoke("list_terminals"));
  } catch (e) {
    showError("list_terminals", e);
  }
}

function applyInfos(infos) {
  const now = performance.now();

  // A terminal several listings in a row have stopped naming is closed as far
  // as both sides are concerned, so its tombstone has done its job. Done
  // before adoption, or an id would stay blocked for one refresh longer than
  // it needs to be.
  forgetClosed(infos);

  // Take on anything the daemon has that this window does not.
  //
  // A terminal can exist without the window knowing: a create whose reply came
  // back too late, or one started by another window against the same daemon.
  // The rail lists whatever the daemon reports, so without this those appear
  // as rows that cannot be opened, which is a worse outcome than the error
  // that produced them.
  //
  // `makeTerminal` attaches and replays, so adopting one is the same operation
  // as opening the window on it in the first place.
  for (const info of infos) {
    if (terminals.has(info.id)) continue;
    if (adopting.has(info.id)) continue;
    // Not one this window closed a moment ago. See `closed`.
    if (closed.has(info.id)) continue;
    adopting.add(info.id);
    try {
      makeTerminal(info.id, {
        cols: info.cols > 0 ? info.cols : 80,
        rows: info.rows > 0 ? info.rows : 24,
      });
      logInfo(`adopted terminal ${info.id}`);
    } catch (e) {
      logInfo(`could not adopt terminal ${info.id}: ${e}`);
    }
    adopting.delete(info.id);
  }

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
  let showing = entry && entry.browserOpen ? activeTab(entry) : null;

  // Nothing is placed until the window has stopped deciding how big it is.
  //
  // Opening one is three layouts in quick succession — built, sized, then
  // restored to the size it was last left at — and a native webview put over a
  // rectangle measured during any of them is a page hanging off the side of
  // the window until something moves. It cannot be clipped, so it is not a
  // stray pixel at the edge: it is a white panel across the desktop, and it
  // was the first thing you saw on every launch.
  //
  // Parked rather than skipped. Returning early would leave whichever page was
  // last placed sitting where it was, which is the same problem with an older
  // rectangle.
  if (!layoutReady) showing = null;

  // The editor is in this document and the browser is a separate window as far
  // as the OS is concerned, so nothing here can be drawn over one. Editing
  // therefore has to move the page out of the way rather than cover it, which
  // is the same thing a toast overlapping the slot does.
  if (editorShowing()) showing = null;

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
          // Whether the panel was open is deliberately not written: the window
          // always comes back with it shut. See `restoreTabs`.
          //
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
 * this window, so most of the time closing and reopening hmux does not restore
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
/**
 * How many browsers a restore is allowed to take, leaving the rest free.
 *
 * A session restored to the last slot is a window that cannot open a link
 * until you close something, on every launch, forever. Whatever is left over
 * is the headroom for the next thing you click.
 */
const RESTORE_BUDGET = 18;
let restoreSpend = 0;

/** True while the session is being rebuilt; see `reclaimTab`. */
let restoring = false;

async function restoreTabs(entry, remembered) {
  const urls = Array.isArray(remembered.tabs) && remembered.tabs.length
    ? remembered.tabs
    : remembered.url
      ? [remembered.url]
      : [];

  // The page that was in front comes back first.
  //
  // Restoring in saved order and stopping at the budget gives whichever
  // terminals were restored first all the browsers, and the ones after them
  // none, which has nothing to do with what you were using. Putting each
  // terminal's own active page first means every terminal gets the one that
  // matters before any of them gets a second.
  const at = Math.min(remembered.activeTab || 0, Math.max(0, urls.length - 1));
  const ordered = urls.length ? [urls[at], ...urls.filter((_, i) => i !== at)] : [];

  for (const url of ordered) {
    if (restoreSpend >= RESTORE_BUDGET) {
      logInfo(
        `not reopening ${url}: the restore budget of ${RESTORE_BUDGET} browsers is spent`
      );
      break;
    }
    const tab = await addTab(entry, url || HOME_PAGE);
    if (!tab) break;
    restoreSpend += 1;
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

  // The active page was restored first, so it is the first tab there is.
  const tabs = tabsOf(entry);
  entry.activeTab = tabs.length ? tabs[0].id : null;

  // Shut, always, however it was left.
  //
  // The pages are still restored and the panel still remembers them, so opening
  // it puts the same set back. What is not restored is the panel being open,
  // because a window that opens with half of it given to a browser is a window
  // that opens showing you less of the thing you came back for. Reopening it is
  // one click; getting a terminal back to full width is one click you did not
  // ask to have to make, every single time.
  entry.browserOpen = false;
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
/**
 * Wait until every browser in the pool exists.
 *
 * `setup` asks for all of them and returns before the last one is up, so a
 * restore that starts immediately hands pages to slots that do not exist yet
 * and they fail to load with nothing to retry them. Bounded, because a pool
 * that never finishes is a reason to carry on with a degraded window rather
 * than to sit at a blank one forever.
 */
async function waitForBrowsers(ms = 6000) {
  const until = performance.now() + ms;
  for (;;) {
    try {
      if (await invoke("browser_pool_ready")) return true;
    } catch {
      return false;
    }
    if (performance.now() > until) {
      logInfo("carrying on: the browser pool did not finish starting in time");
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function restoreOrStart() {
  restoring = true;
  await waitForBrowsers();
  try {
    await restoreOrStartInner();
  } finally {
    restoring = false;
  }
}

async function restoreOrStartInner() {
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
  "https://api.github.com/repos/hunterjreid/Hmux/releases/latest";
const RELEASES_PAGE = "https://github.com/hunterjreid/Hmux/releases/latest";
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

/// The binaries an update replaces, in the order they are fetched. Named here
/// as well as in Rust because this half has to know what to ask GitHub for; the
/// other half refuses anything not on its own list, and that is the one that
/// matters.
const UPDATE_BINARIES = ["hmux-gui.exe", "hmux.exe", "hmux-daemon.exe"];

/// Set once an update has been downloaded and is waiting to be applied, so the
/// six-hourly check does not start fetching the same release again behind a
/// dialogue that is already asking about it.
let updateReady = null;
let updateInProgress = false;

/**
 * Why the last check came to nothing, if it was not simply being up to date.
 *
 * Kept so that asking explicitly can tell the two apart. Reporting a check that
 * failed as "you are on the newest version" is worse than saying nothing: it is
 * a confident answer to the question, and it is wrong.
 */
let updateFailed = "";

/**
 * What is being downloaded, for the progress event to redraw against.
 *
 * The event carries only bytes, because Rust has no business knowing what the
 * dialogue says.
 */
let updateTarget = null;

/** A check that went wrong, in the same card the good news arrives in. */
function updateFailedToast(what) {
  showToast({
    key: "update-failed",
    title: "Could not check for updates",
    body: what,
    bad: true,
    life: 8000,
  });
}

async function checkForUpdate(explicit = false) {
  if (updateReady || updateInProgress) return;
  updateFailed = "";

  // A build you compiled is never out of date. See `is_release_build`: the
  // version lives in `Cargo.toml`, the workflow rewrites it just before
  // compiling and never commits it back, so a working copy reports 0.1.0 and
  // every release ever published looks newer than it. Offering that update is
  // offering to overwrite the thing you are working on with the last one CI
  // built, and the button for it says "Restart to update".
  try {
    if (!(await invoke("is_release_build"))) {
      // Said out loud once, because "it stopped offering updates" and "it is
      // correctly not offering updates" look identical from outside, and the
      // flag is set in one line of one workflow file. If that line ever goes,
      // every release quietly becomes its own last version, and this is the
      // only place that would say so.
      logInfo("not offering updates: this build did not come from a release");
      if (explicit) {
        showToast({
          key: "update-dev",
          title: "This is a local build",
          body: "Updates are only offered to builds from a release. Run install.ps1 without -FromBuild to go back to the published one.",
          life: 6000,
        });
      }
      return;
    }
  } catch {
    // An older build has no such command. It is also, by definition, one that
    // came from a release, since nothing else was shipping then.
  }

  let current;
  try {
    current = await invoke("app_version");
  } catch (e) {
    updateFailed = `could not read this build's version: ${e}`;
    if (explicit) updateFailedToast(updateFailed);
    return;
  }

  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    // A repository with no releases yet answers 404, and that genuinely is
    // nothing to report: there is no update because there are none at all.
    if (!response.ok) {
      if (response.status !== 404) {
        updateFailed = `GitHub answered ${response.status}`;
        if (explicit) updateFailedToast(updateFailed);
      }
      return;
    }

    const release = await response.json();
    const tag = release.tag_name;
    if (!tag || !isNewer(tag, current)) return;

    // The size travels with the address. GitHub has just told us how big each
    // one is, and this is the only place that answer is free: asking the
    // download host separately is three more round trips for a number already
    // in hand, and a HEAD cannot answer it anyway — see `update_download`.
    const assets = new Map(
      (release.assets || []).map((a) => [
        a.name,
        { url: a.browser_download_url, size: a.size || 0 },
      ])
    );

    // A release missing any of the three is not installable — the window would
    // come back paired with a daemon it does not match, or with none at all.
    // Better to keep running the version that works and say nothing.
    const missing = UPDATE_BINARIES.filter((n) => !assets.has(n));
    if (missing.length) {
      logInfo(`skipping ${tag}: it has no ${missing.join(", ")}`);
      return;
    }

    await downloadUpdate(tag, current, assets);
  } catch (e) {
    // Offline, rate limited, DNS down. Quietly not offering an update is the
    // right failure for the six-hourly check: this is never why someone opened
    // a terminal. Someone who asked deserves an answer either way.
    updateFailed = String(e);
    if (explicit) updateFailedToast(String(e && e.message ? e.message : e));
  }
}

/**
 * Fetch the new binaries and stage them, then offer the restart.
 *
 * Downloaded before anything is said about it. An update people are asked to
 * approve and then made to watch a progress bar for is two interruptions; this
 * way the only moment it costs anything is the one where it is already done and
 * the answer is a single click.
 *
 * Progress is per byte across all three, not per file, because three bars that
 * each fill and reset read as three updates.
 */
async function downloadUpdate(tag, current, assets) {
  updateInProgress = true;
  updateTarget = { tag, current };
  showUpdateToast({ tag, current, phase: "downloading", percent: 0 });

  try {
    // Rust does the fetching. See `update_download`: the webview is not allowed
    // to, because GitHub redirects a release asset to a host that sends no
    // `Access-Control-Allow-Origin`, and the refusal arrives as the bare string
    // "Failed to fetch" with no clue in it.
    await invoke("update_download", {
      assets: UPDATE_BINARIES.map((name) => ({ name, ...assets.get(name) })),
    });

    updateReady = tag;
    showUpdateToast({ tag, current, phase: "ready" });
  } catch (e) {
    // Nothing has been swapped — staging is a separate directory — so the
    // running install is untouched and the next check will try again.
    //
    // Said out loud, not only logged. This failing silently is what made a
    // broken updater look like a working one: the dialogue appeared, vanished
    // within a second, and asking again answered "you are on the newest
    // version", which was not true and was not what had happened.
    logInfo(`could not download ${tag}: ${e}`);
    updateFailed = String(e);
    showToast({
      key: "update-failed",
      title: `Could not download ${tag}`,
      body: String(e && e.message ? e.message : e),
      bad: true,
      life: 8000,
    });
  } finally {
    updateInProgress = false;
    updateTarget = null;
  }
}

/**
 * The update, as one card at the top of the terminal.
 *
 * Not a dialogue and deliberately not blocking. Downloading is not a question,
 * so nothing is asked while it happens and nothing is in the way of carrying
 * on. The one moment the update needs an answer is the end of it, and that
 * card stays until it gets one: the interesting sentence is the one about the
 * terminals, and it is only worth anything read at the moment someone is
 * deciding whether to let the app restart.
 */
function showUpdateToast({ tag, current, phase, percent }) {
  if (phase === "downloading") {
    showToast({
      key: "update-download",
      title: `Downloading Hmux ${tag}`,
      body: `You are on ${current}. Your terminals keep running throughout.`,
      percent: percent || 0,
    });
    return;
  }

  showToast({
    key: "update-ready",
    title: `Hmux ${tag} is ready`,
    body: "Restarting swaps the window for the new one. Your terminals keep running the whole time.",
    action: {
      label: "Restart to update",
      run: async (go) => {
        go.disabled = true;
        go.textContent = "Restarting…";
        try {
          // Does not return: the new window is started and this one exits.
          await invoke("update_apply");
        } catch (e) {
          logInfo(`could not apply ${tag}: ${e}`);
          showToast({
            key: "update-failed",
            title: "Could not install the update",
            body: String(e && e.message ? e.message : e),
            bad: true,
            life: 8000,
          });
        }
      },
    },
  });
}

// -------------------------------------------------------------- splitters

/**
 * Put back the widths the splitters were last left at.
 *
 * Dragging a panel to the size you want it and finding it back at the default
 * next time is the kind of thing you stop bothering to do. Stored per variable
 * name, so adding a third splitter needs nothing here.
 */
/**
 * The widths you actually chose, as opposed to the widths that currently fit.
 *
 * These are two different numbers and conflating them is what made the rail
 * shrink a little on every launch. See `fitPanelsToWindow`.
 */
const wanted = { "--rail-w": 0, "--browser-w": 0 };

function restorePanelWidths() {
  const root = document.documentElement;
  for (const name of ["--rail-w", "--browser-w"]) {
    const saved = Number(localStorage.getItem(`hmux${name}`));
    if (saved > 0) {
      wanted[name] = saved;
      root.style.setProperty(name, `${saved}px`);
    } else {
      // Whatever the stylesheet says, so the ceiling has something to compare
      // against before anything has ever been dragged.
      wanted[name] =
        parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
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
    const want = wanted[name];
    if (!want) continue;
    // Clamped for this window, never written back.
    //
    // The clamped value used to be saved, which quietly destroyed the width
    // you had chosen. A window is briefly narrow while it opens, before it is
    // restored to the size it was last left at, so the ceiling during those
    // first frames is computed against a window that is not the real one. The
    // rail was clamped to that, the clamp was persisted, and the next launch
    // started from the smaller number and clamped it again. It came back a
    // little narrower every time and there was no way to tell it had happened
    // except by dragging it out again.
    //
    // Remembering the width asked for and applying whatever fits keeps both
    // promises: the terminal is never squeezed out on a small screen, and the
    // rail is the width you set it to the moment there is room for it again.
    root.style.setProperty(name, `${Math.min(want, ceiling)}px`);
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
      wanted[varName] = clamped;
      localStorage.setItem(`hmux${varName}`, String(clamped));
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
  // Before any tab is claimed, so a failure can say the real number.
  try {
    poolSize = await invoke("browser_pool_size");
  } catch {}

  // Awaited, and before any terminal is made: a terminal is constructed either
  // see-through or not, so this has to be known first or the ones restored at
  // startup come back opaque over the picture.
  await loadBackground();
  // Not awaited: only the profile menu wants it, and that cannot be open yet.
  loadAccountName();
  loadVersion();
  document.getElementById("err-close").onclick = () => (els.err.hidden = true);

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
    if (e.key === "F11") {
      e.preventDefault();
      invoke("window_toggle_fullscreen")
        .then((now) => {
          // The command answers with the state it ended up in, so the title bar
          // knows whether it is still a drag surface — and whether maximise is
          // still a thing this window can be asked for. See `refreshMaxIcon`.
          fullscreen = now;
          refreshMaxIcon();
          // Refit explicitly, and more than once.
          //
          // Going fullscreen gains exactly the height of the taskbar, about
          // fifty pixels, which is two or three rows. The terminal kept the
          // row count it had while merely maximised and left that strip of
          // background below the last line, which is the whole of what "it
          // does not fill the bottom" was.
          //
          // Why the observer did not catch it: the window is resized by the OS
          // outside any layout the page is doing, and the webview's own box
          // catches up a frame or two later. One callback fires against a host
          // that has not moved yet. Asking again after the next frame and
          // again once the transition is over costs two measurements that
          // usually change nothing.
          const refit = () => {
            if (activeId !== null) syncSize(activeId);
            scheduleBounds();
          };
          requestAnimationFrame(() => requestAnimationFrame(refit));
          setTimeout(refit, 120);
          setTimeout(refit, 400);

        })
        .catch((err) => showError("fullscreen", err));
    }
    if (e.key === "Escape") {
      closeRowMenu();
      closeSettings();
    }
  });
  document.getElementById("back-btn").onclick = () => history("back");
  document.getElementById("fwd-btn").onclick = () => history("forward");
  document.getElementById("reload-btn").onclick = () => history("reload");

  els.editBtn.onclick = () => openEditor().catch((e) => showError("edit", e));
  els.editorCancel.onclick = closeEditor;
  els.editorSave.onclick = () => saveEditor().catch((e) => showError("save", e));

  // Save is offered only when there is something to save, which is also the
  // only readout saying whether what is on screen has reached the disk.
  els.editorText.addEventListener("input", () => {
    els.editorSave.disabled = !editorDirty();
  });

  els.editorText.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveEditor().catch((err) => showError("save", err));
      return;
    }
    // Escape closes, but only when closing costs nothing. Unsaved text needs
    // the button that says Cancel on it, because a key pressed by habit is not
    // a decision to throw work away.
    if (e.key === "Escape" && !editorDirty()) {
      e.stopPropagation();
      closeEditor();
      return;
    }
    // Tab indents rather than leaving the box. There is nowhere useful for it
    // to go, and a file with indentation in it is most of what gets edited.
    if (e.key === "Tab") {
      e.preventDefault();
      const box = els.editorText;
      const { selectionStart: from, selectionEnd: to } = box;
      box.value = `${box.value.slice(0, from)}\t${box.value.slice(to)}`;
      box.selectionStart = box.selectionEnd = from + 1;
      els.editorSave.disabled = !editorDirty();
    }
  });

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

  // Rust does the downloading, so the bar is driven from there. Clamped at 99
  // because the last thing to happen after the bytes arrive is staging them,
  // and a bar that reads 100 while something is still going is a bar that has
  // stopped telling the truth.
  await listen("update-progress", (event) => {
    if (!updateInProgress || !updateTarget) return;
    const { received, total } = event.payload || {};
    if (!total) return;
    showUpdateToast({
      tag: updateTarget.tag,
      current: updateTarget.current,
      phase: "downloading",
      percent: Math.min(99, Math.round((received / total) * 100)),
    });
  });

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

  // Refit whenever the box the terminal lives in actually changes size.
  //
  // Everything else here fits in a `requestAnimationFrame` after doing whatever
  // moved the columns — which is one frame into a transition that runs for
  // `--slide`, 260ms. What gets measured is therefore the width the panel was
  // *leaving*, and nothing measures the width it arrives at. Opening the window
  // was the visible case: the browser column collapses on startup, the fit
  // lands 16ms into the 260ms it takes to collapse, and the terminal spends the
  // whole session at the handful of columns that were free at that instant,
  // wrapping every line in a narrow ribbon down the left of an empty pane.
  //
  // An observer is the fix rather than another timeout because it is answering
  // the question that was actually being asked — has this element changed size
  // — instead of guessing at when it might have. It fires for each frame of a
  // transition and once more at the resting size; `fitTerminal` returns
  // immediately when the column count has not changed, so the intermediate
  // frames cost a measurement and nothing else.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (activeId !== null) syncSize(activeId);
      scheduleBounds();
    }).observe(els.host);
  }

  // A drag that started on a terminal ends wherever the pointer got to, which
  // for a scrollbar flung at the top of the window is not over the terminal at
  // all. One listener rather than one per terminal, because terminals close
  // and a window listener holding a closed one alive is a leak.
  window.addEventListener(
    "mouseup",
    () => {
      for (const entry of terminals.values()) {
        if (!entry.dragging) continue;
        entry.dragging = false;
        // The moment the button comes up is still the reader's; a smooth
        // scroll started by the drag is still arriving.
        entry.claimedAt = performance.now();
      }
    },
    true
  );

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

      // Changing the font size is not one reflow. xterm recalculates the cell
      // dimensions, the fit that follows changes the column count, and the
      // rewrap those cause finishes after this handler has returned. Asking
      // "are we at the bottom" partway through that gets the answer for a
      // layout that is already gone, and `preservingView` then faithfully
      // holds a position nobody chose — which is the view jumping half a
      // screen up on every notch of the wheel. `follow` is the same answer at
      // every point in that sequence, because it is not a measurement.
      pinBottom(entry);
    },
    { passive: false, capture: true }
  );

  // The same gesture over the rail, sizing the rail instead. Captured for the
  // same reason: the list scrolls, so it would otherwise swallow the event
  // everywhere except at the ends.
  const RAIL_FONT_KEY = "hmux.railFont";
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
  // Always closed — see `restoreTabs`. The markup already says so, so this
  // agrees with what is on screen rather than changing it; it is here to wire
  // the rest of the state that goes with a shut panel.
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
  setTimeout(() => {
    settle();
    // The window is where it is going to be, so a page can finally be put over
    // the slot without landing outside it.
    layoutReady = true;
    pushBrowserBounds(true);
  }, STARTUP_SETTLE_MS + 200);

  // Fit again once the terminal font has actually loaded.
  //
  // Every column count here is the box divided by the width of a cell, and the
  // cell is measured from the DOM — so a fit that happens before the font is
  // ready measures a fallback face, or nothing at all, and lands on a number
  // that has no relationship to what is on screen. It is not a small error
  // either: it produced a three-column terminal in a window nineteen hundred
  // pixels wide.
  //
  // `fonts.ready` is the event for exactly this, and after it the measurement
  // is the real one. Nothing else triggers a refit at that moment, because
  // loading a font does not resize anything the observer is watching.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (activeId !== null) syncSize(activeId);
    });
  }

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
    `<pre class="term-empty">hmux failed to start:\n${e}</pre>`;
  console.error(e);
  invoke("ui_log", { message: `failed to start: ${e}` }).catch(() => {});
});
