// mux — UI logic.
//
// Three responsibilities:
//   1. keep one xterm.js instance per terminal, alive across view switches
//   2. keep the sidebar buttons in sync with what Rust reports
//   3. tell Rust where to put the native browser webview, since it does not
//      flow with the DOM

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The new-tab page reports an empty address, so the bar shows its placeholder
// instead of an internal asset path.
const HOME_PAGE = "";

const els = {
  list: document.getElementById("list"),
  count: document.getElementById("count"),
  newBtn: document.getElementById("new-btn"),
  host: document.getElementById("term-host"),
  closeBtn: document.getElementById("close-btn"),
  slot: document.getElementById("browser-slot"),
  url: document.getElementById("url"),
  err: document.getElementById("err"),
  errText: document.getElementById("err-text"),
  app: document.querySelector(".app"),
  browserBtn: document.getElementById("browser-btn"),
  shellBtn: document.getElementById("shell-btn"),
  shellMenu: document.getElementById("shell-menu"),
  newLabel: document.getElementById("new-label"),
};

/** Shell used for new terminals; the first one Rust offers is the default. */
let shells = [];
let chosenShell = null;

/** Ctrl+scroll adjusts this, which is the whole of the font UI. */
let fontSize = 13;

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

// ---------------------------------------------------------------- terminals

// Campbell: the palette the Windows console actually ships with. Using it
// means colours look the way they do in any other terminal on this machine,
// rather than being re-mapped into some house style.
//
// This only defines the 16 named ANSI colours. The 256-colour cube and 24-bit
// truecolor pass through untouched, so `\x1b[38;2;r;g;b m` is exact.
const THEME = {
  background: "#0C0C0C",
  foreground: "#CCCCCC",
  cursor: "#CCCCCC",
  cursorAccent: "#0C0C0C",
  selectionBackground: "#3A3D41",
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  magenta: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightMagenta: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2",
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
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(view);

  // Every keystroke goes straight to the pty. No local echo — the shell echoes.
  term.onData((data) => {
    invoke("write_terminal", { id, data }).catch(console.error);
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

/** Resize the pty to match what xterm.js just laid out. */
function syncSize(id) {
  const entry = terminals.get(id);
  if (!entry || entry.view.offsetParent === null) return;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  invoke("resize_terminal", {
    id,
    cols: entry.term.cols,
    rows: entry.term.rows,
  }).catch(() => {});
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

function toggleBrowser() {
  if (activeId === null) return;
  const entry = terminals.get(activeId);
  entry.browserOpen = !entry.browserOpen;
  applyBrowserVisibility();
  renderButtons();
}

async function newTerminal(shell = chosenShell) {
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
}

// ------------------------------------------------------------------ sidebar

/** A terminal's name: whatever you renamed it to, else the shell and number. */
function displayName(info) {
  const entry = terminals.get(info.id);
  if (entry && entry.customName) return entry.customName;
  return `${info.title} ${info.id}`;
}

/**
 * Turn a button's name into an editable field in place.
 *
 * Deliberately not a dialog: renaming a terminal should cost one click and one
 * Enter, or nothing at all if you change your mind.
 */
function beginRename(id, btn, nameEl) {
  const entry = terminals.get(id);
  if (!entry || btn.querySelector(".rename-input")) return;

  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = nameEl.textContent;
  input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const value = input.value.trim();
      // Clearing the name hands it back to the shell rather than leaving it
      // blank.
      entry.customName = value.length ? value : null;
    }
    renderButtons();
  };

  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  // The button's own click handler would otherwise re-select or re-open.
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
}

function renderButtons() {
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

  els.count.textContent = String(infos.length);
  els.list.innerHTML = "";

  for (const info of infos) {
    const entryForBtn = terminals.get(info.id);
    const btn = document.createElement("button");
    btn.className = "term-btn" + (info.id === activeId ? " active" : "");

    const dot = document.createElement("span");
    // Green pulse = producing output. Steady amber = a command is open but has
    // gone quiet, which almost always means it is waiting on you.
    dot.className =
      "dot" +
      (!info.alive
        ? " dead"
        : info.busy
          ? " busy"
          : info.running
            ? " waiting"
            : "");

    const label = displayName(info);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label;

    // Click the name of the terminal you are already in to rename it; double
    // click works from anywhere.
    btn.onclick = (e) => {
      if (info.id === activeId && e.target === name) {
        beginRename(info.id, btn, name);
      } else {
        selectTerminal(info.id);
      }
    };
    btn.ondblclick = (e) => {
      e.preventDefault();
      beginRename(info.id, btn, name);
    };

    const status = document.createElement("span");
    status.className = "status";
    // The window title is usually more specific than the process name.
    status.textContent =
      entryForBtn && entryForBtn.shellTitle && info.busy
        ? entryForBtn.shellTitle
        : info.status;

    btn.append(dot, name, status);

    // Unread wins over the browser marker: new output is the more urgent thing
    // to report, and both occupy the same corner.
    const entry = terminals.get(info.id);
    if (entry && entry.unread > 0 && info.id !== activeId) {
      const badge = document.createElement("span");
      badge.className = "unread";
      badge.textContent = entry.unread > 99 ? "99+" : String(entry.unread);
      badge.title = `${entry.unread} new lines`;
      btn.appendChild(badge);
    } else if (entry && entry.browserOpen) {
      const marks = document.createElement("span");
      marks.className = "marks";
      marks.textContent = "◧";
      marks.title = "has a browser open";
      btn.appendChild(marks);
    }

    els.list.appendChild(btn);
  }

  // The window title is the only place the active terminal is named now; the
  // panel header deliberately says nothing.
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

/** Populate the shell picker and pick a sensible default. */
async function loadShells() {
  try {
    shells = await invoke("list_shells");
  } catch (e) {
    showError("list_shells", e);
    shells = [];
  }
  if (shells.length) {
    chosenShell = shells[0].program;
    els.newLabel.textContent = `New ${shells[0].name}`;
  }

  els.shellMenu.innerHTML = "";
  for (const shell of shells) {
    const item = document.createElement("button");
    item.textContent = shell.name;
    item.onclick = () => {
      chosenShell = shell.program;
      els.newLabel.textContent = `New ${shell.name}`;
      els.shellMenu.hidden = true;
      newTerminal(shell.program).catch((e) => showError("new terminal", e));
    };
    els.shellMenu.appendChild(item);
  }
}

async function main() {
  els.newBtn.onclick = () => newTerminal().catch((e) => showError("new terminal", e));
  els.closeBtn.onclick = () => activeId !== null && closeTerminal(activeId);
  els.browserBtn.onclick = toggleBrowser;
  document.getElementById("err-close").onclick = () => (els.err.hidden = true);

  els.shellBtn.onclick = (e) => {
    e.stopPropagation();
    els.shellMenu.hidden = !els.shellMenu.hidden;
  };
  document.addEventListener("click", () => (els.shellMenu.hidden = true));

  await loadShells();

  els.url.value = HOME_PAGE;
  els.url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
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

  await newTerminal();
  // Starts closed; the toggle in the terminal header opens it per terminal.
  applyBrowserVisibility();
  logInfo(
    `started; terminals=${terminals.size} active=${activeId} shell=${chosenShell}`
  );

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
}

main().catch((e) => {
  document.body.innerHTML =
    `<pre class="term-empty">mux failed to start:\n${e}</pre>`;
  console.error(e);
  invoke("ui_log", { message: `failed to start: ${e}` }).catch(() => {});
});
