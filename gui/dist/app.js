// mux — UI logic.
//
// Three responsibilities:
//   1. keep one xterm.js instance per terminal, alive across view switches
//   2. keep the sidebar buttons in sync with what Rust reports
//   3. tell Rust where to put the native browser webview, since it does not
//      flow with the DOM

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const els = {
  list: document.getElementById("list"),
  count: document.getElementById("count"),
  newBtn: document.getElementById("new-btn"),
  host: document.getElementById("term-host"),
  activeTitle: document.getElementById("active-title"),
  activeStatus: document.getElementById("active-status"),
  activeDot: document.getElementById("active-dot"),
  closeBtn: document.getElementById("close-btn"),
  slot: document.getElementById("browser-slot"),
  url: document.getElementById("url"),
};

/** id -> { term, fit, view, info } */
const terminals = new Map();
let activeId = null;

// ---------------------------------------------------------------- terminals

const THEME = {
  background: "#0e1013",
  foreground: "#d6dae1",
  cursor: "#4a9eff",
  selectionBackground: "#2c4a6e",
  black: "#14161a",
  red: "#ff5f56",
  green: "#3fd07f",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d6dae1",
  brightBlack: "#5c6370",
  brightRed: "#ff7b72",
  brightGreen: "#7ee787",
  brightYellow: "#ffd580",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#7bd7e0",
  brightWhite: "#ffffff",
};

function makeTerminal(id) {
  const view = document.createElement("div");
  view.className = "term-view";
  els.host.appendChild(view);

  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: THEME,
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
  };
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
    .catch(console.error);

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
  syncSize(id);
  entry.term.focus();
  renderButtons();
}

async function newTerminal() {
  // 80x24 is a placeholder; the real size is sent by syncSize once laid out.
  const id = await invoke("create_terminal", { shell: null, cols: 80, rows: 24 });
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
  await refresh();
}

// ------------------------------------------------------------------ sidebar

function renderButtons() {
  const infos = [...terminals.values()]
    .map((e) => e.info)
    .filter(Boolean);

  els.count.textContent = String(infos.length);
  els.list.innerHTML = "";

  for (const info of infos) {
    const btn = document.createElement("button");
    btn.className = "term-btn" + (info.id === activeId ? " active" : "");
    btn.onclick = () => selectTerminal(info.id);

    const dot = document.createElement("span");
    dot.className = "dot" + (!info.alive ? " dead" : info.busy ? " busy" : "");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${info.title} ${info.id}`;

    const status = document.createElement("span");
    status.className = "status";
    status.textContent = info.busy ? `running ${info.status}` : info.status;

    btn.append(dot, name, status);
    els.list.appendChild(btn);
  }

  const active = terminals.get(activeId)?.info;
  els.activeTitle.textContent = active ? `${active.title} ${active.id}` : "no terminal";
  els.activeStatus.textContent = active
    ? active.busy
      ? `running ${active.status}`
      : active.status
    : "";
  els.activeDot.className =
    "dot" + (!active ? "" : !active.alive ? " dead" : active.busy ? " busy" : "");
}

async function refresh() {
  try {
    const infos = await invoke("list_terminals");
    applyInfos(infos);
  } catch (e) {
    console.error(e);
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

function pushBrowserBounds() {
  const r = els.slot.getBoundingClientRect();
  invoke("browser_bounds", {
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height,
  }).catch(() => {});
}

function scheduleBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(pushBrowserBounds, 16);
}

async function go() {
  const target = els.url.value;
  try {
    const full = await invoke("browser_navigate", { url: target });
    els.url.value = full;
    els.url.blur();
  } catch (e) {
    console.error(e);
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
  els.newBtn.onclick = () => newTerminal().catch(console.error);
  els.closeBtn.onclick = () => activeId !== null && closeTerminal(activeId);

  els.url.value = "https://duckduckgo.com";
  els.url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  document.getElementById("back-btn").onclick = () =>
    invoke("browser_history", { action: "back" });
  document.getElementById("fwd-btn").onclick = () =>
    invoke("browser_history", { action: "forward" });
  document.getElementById("reload-btn").onclick = () =>
    invoke("browser_history", { action: "reload" });

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

  await newTerminal();
  pushBrowserBounds();

  // Keep the URL bar showing wherever the browser actually ended up, including
  // after in-page navigation we did not initiate.
  setInterval(async () => {
    if (document.activeElement === els.url) return;
    try {
      const u = await invoke("browser_url");
      if (u && u !== els.url.value) els.url.value = u;
    } catch {}
  }, 1000);
}

main().catch((e) => {
  document.body.innerHTML =
    `<pre class="term-empty">mux failed to start:\n${e}</pre>`;
  console.error(e);
});
