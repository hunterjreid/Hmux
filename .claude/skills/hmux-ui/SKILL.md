---
name: hmux-ui
description: Change how the hmux window looks or behaves - the rail of sessions, the terminals, the browser panel beside them, the title bar, settings, toasts, the update prompt. Covers where the front end lives (gui/dist, hand-written, no bundler), the one command that makes an edit visible, how the JS talks to Rust, and the handful of rules that are easy to break by accident. Use whenever the task touches gui/dist/ or gui/src-tauri/.
---

# Changing the hmux window

## Where it is

The whole front end is `gui/dist/`, and it is hand-written. There is no
bundler, no npm build, no TypeScript, no framework.

| File | What it is |
|---|---|
| `gui/dist/index.html` | The markup, and the SVG sprite every icon is a `<use>` of. Loads the four vendored scripts, then `app.js`. |
| `gui/dist/app.js` | All the UI logic, one plain script, no modules. ~4,500 lines. |
| `gui/dist/app.css` | All the styling. Design tokens are the `:root` block at the top. |
| `gui/dist/vendor/` | xterm.js and its three addons, pinned. |
| `gui/dist/newtab.html` | What the browser panel shows with no page in it. |
| `gui/dist/backgrounds/` | The wallpapers offered in settings. |

Editing one of those files *is* the change. Nothing generates them.

**`gui/node_modules` is only where the vendored copies came from.** Nothing
loads out of it at runtime. `gui/dist/vendor/*` are byte-for-byte copies of the
`@xterm/*` packages at the versions in `gui/package.json`. To move xterm: `npm
install` in `gui/`, then copy the five files across (`xterm.js`, `xterm.css`,
`addon-fit.js`, `addon-serialize.js`, `addon-web-links.js`) and diff what
changed in the parts of `app.js` that reach into them.

## Seeing the change

```
cargo build --release -p hmux-gui
target/release/hmux-gui.exe
```

A rebuild for a file a browser could have reloaded, because `frontendDist:
"../dist"` in `tauri.conf.json` means Tauri embeds the whole folder in the
binary, and there is no `devUrl` so there is no server to reload from. It is
cheaper than it looks: `tauri_build` watches the folder, so touching only
`app.js` invalidates one crate and the incremental build is about a minute.

**Relaunching the window costs nothing.** The shells belong to the daemon, not
to the window, so quitting to look at a change leaves every terminal running
mid-command and they are all still there when it comes back.

Syntax-check before rebuilding, because a typo in `app.js` is not a compile
error, it is a window that opens black:

```
node --check gui/dist/app.js
```

## Talking to Rust

`withGlobalTauri` is on, so the two bridges come straight off the window and
are already destructured at the top of `app.js`:

```js
invoke("write_terminal", { id, data })   // call a command, returns a promise
listen("terminal-output", (event) => …)  // subscribe to something Rust pushes
```

Commands are `#[tauri::command]` functions in `gui/src-tauri/src/`. **Adding one
is two edits, not one**: write the function, then add its name to
`generate_handler![…]` in `main.rs`. That list is not generated, and a command
missing from it fails at runtime with nothing at compile time to warn you.
Arguments are camelCase on the JS side.

The events Rust pushes, all of them:

| Event | Carries |
|---|---|
| `terminal-output` | `{ id, data, seq }` - a chunk of pty output, for **any** terminal, not just the visible one |
| `terminal-exit` | the id of a terminal whose process ended |
| `terminals` | the full session list, whenever it changes |
| `daemon-error` | the daemon has gone, which means every terminal has |
| `update-progress` | download percent, driven from `update.rs` |
| `browser-loading` | a page in the browser panel started or finished |

## The shape of app.js

One file, read top to bottom, grouped by responsibility:

- **Terminals** - `makeTerminal`, `attachBacklog` / `goLive` (history replay and
  the queue that stops live output being written twice), `applyChunk`,
  `selectTerminal`, `newTerminal`, `closeTerminal`.
- **Sizing and scrolling** - `syncSize` → `fitTerminal` → `preservingView`, plus
  `pinSoon` / `pinBottom`. Read all five before changing any of them.
- **The rail** - `renderButtons`, `scheduleButtons`, `displayName`, `beginRename`,
  `openRowMenu`, `saveRailOrder`, `togglePinned`.
- **The browser** - `applyBrowserVisibility`, `slideBrowser`, `pushBrowserBounds`,
  `openInBrowserPanel`, and the tab strip (`addTab`, `selectTab`, `renderTabs`,
  `moveTab`).
- **The window frame** - `wireWindowFrame`, `toggleMaximize`, `setChrome`. The OS
  decorations are off, so dragging and the minimise/maximise/close buttons are
  ours.
- **Persistence** - `saveLayout`, `snapshotOf`, `restoreOrStart`, `restoreTabs`.
- **Updates** - `checkForUpdate`, `downloadUpdate`, `showUpdateToast`.
- **Chrome** - `showToast`, `openSettings`, `applyBackground`, `showError`.

`els` at the top holds every element, looked up once. Add to it rather than
calling `getElementById` mid-function.

## The rules that are easy to break

**A fit reflows the entire scrollback.** Fifty thousand lines, re-wrapped. So
`fitTerminal` reads `proposeDimensions()` and returns without fitting when the
answer matches the size the terminal already has - and the resize observer fires
constantly on sizes that have not really changed. Keep that early return; taking
it out does not look like a performance bug, it looks like the view jumping
while you scroll.

**Never fit to a box that is mid-layout.** `FIT_FLOOR_PX` exists because a host
measured at a few pixels - during a collapse, during a slide, before the columns
first resolve - puts the terminal at three columns and leaves it there.

**Scroll position is intent, not measurement.** Each entry carries `follow`,
maintained from real input events (wheel, Shift+PageUp/PageDown, mouse down).
Do not go back to deciding "were we at the bottom" by reading `viewportY >=
baseY` at the moment somebody asks: xterm latches an internal "the user has
scrolled up" flag whenever its scroll element reports a smaller offset, and a
reflow that shortens the scroll area makes the browser report exactly that. The
viewport then answers for what the layout did rather than for what the reader
did. `preservingView` asks `follow` first for this reason.

**Resizes reach ConPTY on a quiet timer.** `RESIZE_QUIET_MS`, and
`STARTUP_SETTLE_MS` while the window is still arriving at its size. ConPTY
repaints its whole screen for every resize it is handed, and an inline TUI
answers that repaint by drawing its banner *again*, below the last one. A resize
sent per frame is a banner per frame.

**The browser does not flow with the DOM.** It is a native child surface placed
from Rust. CSS moves the hole; `pushBrowserBounds` moves the page. `SLIDE_MS` in
`app.js` and `--slide` in `app.css` are the same number written twice, and the
two drifting apart shows as the page stopping short of the panel.

**Hidden terminals are `visibility: hidden`, not `display: none`.** They stay
laid out so each can be measured and fitted to its own font size while off
screen, which is what makes switching free. A terminal with no size cannot be
measured, and the alternative - telling hidden terminals to take the visible
one's size - is wrong the moment two terminals have different font sizes.

**State is per terminal, not per window.** Font size, browser tabs, whether the
panel is open, `follow`, the custom name. Anything new that a reader would
expect to find as they left it goes on the entry.

**Errors go through `showError` / `logInfo`**, which reach `ui_log` in Rust and
land in the daemon's log. `console.log` in a release build goes nowhere anybody
can read.

## House style

The comments carry the reasoning, and they are the reason this codebase can be
picked up cold. Match them:

- Say **why**, and say **what was measured**. A comment restating the line under
  it is noise here.
- When a fix rests on a fact about the platform - xterm's `isUserScrolling`,
  ConPTY repainting on resize, Chromium reporting a native-scrollbar press as a
  press on its element - write the fact down where the next person will hit it.
- When something obvious was tried and did not work, say so, so it is not tried
  again.
- Sentence case in the UI, no exclamation marks, no emoji.

## Before you finish

```
node --check gui/dist/app.js       # a typo here is a black window, not an error
cargo build --release -p hmux-gui  # re-embeds dist/
cargo test                         # the Rust side
```

Then open the window and use the thing you changed. Switching terminals,
opening the browser panel, dragging a splitter and resizing the window all touch
the same reflow path, so a change to any of it wants all four tried.
