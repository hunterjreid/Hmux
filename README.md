<p align="center">
  <img src=".github/hero.jpg" alt="A terminal, a rail of live sessions and a browser in one window" width="100%" />
</p>

<h1 align="center">Hmux</h1>

<p align="center">
  <strong>Hunter's Terminal Multiplexer.</strong><br />
  Terminals that keep running whether or not you're looking at them.
</p>

<p align="center">
  <a href="https://hmux.hunterjreid.com/">hmux.hunterjreid.com</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/hunterjreid/Hmux/releases/latest">Releases</a>
  &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a>
</p>

<p align="center">
  <img alt="Windows 10 1809+" src="https://img.shields.io/badge/Windows-10%201809%2B-0a0a0d?style=flat-square&labelColor=0a0a0d&color=e619ff" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2024-0a0a0d?style=flat-square&labelColor=0a0a0d&color=ff4db8" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-0a0a0d?style=flat-square&labelColor=0a0a0d&color=ff1a88" />
</p>

---

The shells do not belong to the window. They belong to a daemon with no window
of its own, so closing Hmux closes a view onto them rather than the things
themselves. A build you started and then quit the window on is still building
when you come back.

Two front ends share that: a GUI app with a browser beside every terminal, and
a console-only version that runs inside the terminal you are already in.

## Install

```powershell
irm https://raw.githubusercontent.com/hunterjreid/Hmux/master/install.ps1 | iex
```

Puts the latest release in `%LOCALAPPDATA%\hmux`, adds it to your PATH and makes
a Start menu entry. Per-user, so it never asks for administrator rights, and
uninstalling is deleting that folder.

Run it again later and it updates in place. It will not do that while a window
is open, but it does not mind the daemon running, because your terminals are
in it. Windows refuses to overwrite a running program and allows renaming one,
so the running daemon is moved aside and keeps going from the moved file while
its replacement takes the name.

**After the first install it updates itself.** The window checks for a new
release on startup and every six hours, downloads it in the background, and
then offers a restart. Taking it costs you the window for about a second: the
terminals are the daemon's and are still there, mid-command, when it comes
back. The new daemon is put in place but deliberately not started, so an update
never interrupts what is running. It is picked up the next time the daemon
starts on its own.

If you'd rather click something, take an installer from the
[latest release](https://github.com/hunterjreid/Hmux/releases/latest).

Neither is code signed yet, so Windows will have something to say the first
time you run it. `hmux-gui` needs the WebView2 runtime, which Windows 11 already
has; the installer checks and tells you where to get it if yours doesn't.

Needs Windows 10 1809 or newer, for ConPTY.

## The GUI: `cargo run --release -p hmux-gui`

A rail of terminals down one side, the active one filling the middle, and
**that terminal's own browser** on the other.

```
┌──────────────────────────────────────────────────────┬──────────────┐
│ HMUX       ◧                       ─    □    ✕       │            + │
├───────────────────────┬──────────────────────────────┼──────────────┤
│         ────          │ Reply from 127.0.0.1         │ ⌕ Search     │
├───────────────────────┤ Reply from 127.0.0.1         │ claude       │
│                       │ Reply from 127.0.0.1         │   node     ◜ │
│     its own page      │                              │ cmd 2        │
│                       │                              │              │
└───────────────────────┴──────────────────────────────┴──────────────┘
```

The rail is on the right by default: it is a list you glance at, the terminal
is the thing you look at, and the window buttons are already up in that corner.
**Settings → Layout** swaps the two, and the choice is remembered per window.

Each terminal owns a browser, so switching terminals switches the page:
scroll position, forms and logins all still there, because it is a separate
webview rather than one that re-navigates.

**Links go to the terminal's own browser, not to another application.** A URL
in the output is clickable, and so is a bare Windows path: clicking
`C:\Users\you\Pictures\shot.png` opens the image in the panel beside the shell
that printed it. Handing it to the system browser instead would defeat the
point of having a browser per terminal.

The bare-path pattern has to end on a file extension followed by whitespace or
punctuation, because Windows paths contain spaces. A greedy match on
`C:\...\Screenshot 2025-10-11 113658.png Want me to open it?` swallows the
sentence after the filename.

**The window has no OS title bar, because it did not need two bars.** The app
draws its own, carrying the browser toggle and the window buttons. It says
nothing about which terminal is active: the rail already does, and twice was
once too many.

**Rows say as little as possible.** A terminal at a prompt, and a terminal sat
inside a program waiting for you, are what a terminal is doing nearly all the
time, so marking those marks everything. An idle row is a name and nothing
else. A spinner appears on the right only while work is genuinely happening,
which is what makes anything moving worth looking at.

Renaming is a click on the terminal you are already in, or `F2`. Right-clicking
a row gives rename, show or hide its browser, and close.

**Idle or busy is asked of the OS, not guessed from output.** A shell sitting at
a prompt has no child processes; a shell running `ping` has `ping.exe` under it.
So a compile that has been silent for a minute still reads as busy, which the
usual "did it print recently" heuristic gets wrong.

**It comes back the way you left it, still running.** The shells do not belong
to the window. They belong to `hmux-daemon`, a process with no window of its
own, and closing the window closes a view onto them rather than the things
themselves. Reopening it attaches to the same terminals, mid-command, with
everything they printed while nobody was looking already in the scrollback. A
build you started and then quit the window on is still building.

So there are two paths back, and which one you get is not a preference:

- **Attach**, the ordinary one. The daemon is still up, the terminals are still
  running, and the window simply sits back down in front of them.
- **Restore**, when the daemon is not there. The first ever run, or after a
  reboot, which is the one thing no daemon survives. Then the terminals are
  rebuilt from `%APPDATA%\hmux\session.json`: the same shells in the same
  directories, with the old output replayed above a rule saying where the
  previous session ended. These are new processes, and whatever was running in
  the old ones is gone.

The daemon exits on its own once the last terminal has closed and no window is
attached, so it is not a permanent resident. It just outlives any particular
window.

The browser's address bar is collapsed to the `────` strip at the top of the
page, and comes down when you reach it or press <kbd>Ctrl+Shift+L</kbd>. It goes
away again when you leave it, or on <kbd>Esc</kbd>. Ctrl+L is left to the shell.

The strip has to exist rather than being nothing at all, because the page is a
native webview painted over the app, and an overlay in that rectangle would be
invisible and unclickable. The strip is the one part of the top edge the webview
does not cover, which is also why the title bar spans the full width above every
column rather than stopping at the browser. For the same reason its height is
not animated: the webview sits at absolute coordinates that no CSS transition
can carry along, so a height still in motion when the bounds were measured put
the page over the top of the bar.

**Colours are read out of the editor's theme rather than invented.** The chrome
and all sixteen ANSI colours come from Monokai Dimmed, straight out of
`Cursor/resources/app/extensions/theme-monokai-dimmed`, so a shell here and a
shell in the editor render identically. Two terminals side by side that
disagree about what "green" is read as two different machines. The 256-colour
cube and 24-bit truecolor pass through untouched, so `\x1b[38;2;r;g;b m` is
exact.

Problems go to `%TEMP%\hmux.log` and to a banner in the window. A GUI has nowhere
to print, and a silent failure is how a bug here stays invisible.

---

## The console version: `cargo run --release --bin hmux`

A rail of buttons down the left, one terminal filling the rest of the screen.
Click a button, get that terminal.

```
┌────────────┬──────────────────────────────┐
│ TERMINALS  │ C:\Users\you>set /a 21*2     │
│ ▸ 1: cmd   │ 42                           │
│   2: cmd   │                              │
│   3: cmd   │ C:\Users\you>_               │
│            │                              │
│   + new    │                              │
├────────────┴──────────────────────────────┤
│ hmux · 3/3 live · pane 1   C-b c new  …    │
└───────────────────────────────────────────┘
```

Every button is a real ConPTY running a real shell, and **all of them keep
running whether or not they're on screen**. Switching is a change of view, not a
change to the process: a build you started in pane 2 keeps building while you
work in pane 1, and switching back shows its current screen, not a blank one.

## Build and run

```
cargo build --release
.\target\release\hmux-gui.exe
.\target\release\hmux.exe
.\target\release\hmux.exe --shell powershell.exe
```

The console version needs a real console. Piping its output somewhere is
refused with a clear message rather than a crash.

## Keys

Console front end:

| Key | Does |
| --- | --- |
| `C-b c` | new terminal |
| `C-b n` / `C-b p` | next / previous |
| `C-b 1`…`9` | select by number |
| `C-b x` | close the active terminal |
| `C-b <` / `>` | narrow / widen the rail |
| `C-b r` | force a full redraw |
| `C-b q` | quit |
| `C-b C-b` | send a literal `Ctrl-B` to the shell |

The buttons are clickable, and so is `+ new`.

GUI:

| Key | Does |
| --- | --- |
| `Ctrl+Shift+L` | open the browser's address bar |
| `Esc` | put it away again |
| `F2` | rename the terminal the rail has focus on |
| `F11` | fullscreen, and back |
| `Ctrl+scroll` | font size |

## How it works

The interesting thing about a multiplexer is that a pane cannot be a byte pipe.
The moment a pane is hidden or resized you have to be able to *redraw* it, and
the only way is to have kept the screen it would have drawn. So there is a
terminal emulator inside:

| Module | Job |
| --- | --- |
| `term` | the host console: raw mode, VT in/out, alternate screen, restored on drop and on panic |
| `pane` | one ConPTY child, a reader thread draining it, a waiter thread watching it die |
| `grid` | the emulator: a rectangle of styled cells, mutated by the escape sequences the shell emits |
| `layout` | where the rail, the terminal, and the status line are |
| `render` | compose a frame from chrome + active grid, diff against the last one, emit only the difference |
| `input` | prefix chords and mouse reports vs. everything else, which is forwarded untouched |
| `activity` | walk the process table: is this shell running anything, and is it doing something |
| `cwd` | read another process's working directory out of its PEB, for session restore |

`vte` does the escape-sequence lexing (it's Alacritty's parser). Everything in
`grid.rs` is the semantics, meaning what each sequence does to the screen.

The GUI does not use `grid` at all: it streams raw pty bytes to xterm.js, which
is already a better terminal emulator than this project would maintain. It uses
`pty`, `activity` and `cwd`, which are the parts only the OS can answer.

Two things that are easy to get wrong and are handled:

- **Deferred wrap.** Printing in the last column must *not* move to the next
  line; the wrap happens when the next character arrives. Emulators that wrap
  eagerly scroll a line early on full-width output.
- **Replies.** `CSI 6n` and `CSI c` are questions. A program that asks and never
  hears back will hang, so the grid queues answers and the pane writes them back
  to the pty.

## What isn't done

- **The console front end is not detachable.** `hmux.exe` still owns its own
  ptys, so quitting it kills its shells. The daemon is only behind the GUI;
  pointing the console version at it is the same client work done twice.
- **A reboot is still a reboot.** Nothing survives one, and the restore path
  above is what you get.
- **No scrollback UI** in the console front end. History is captured
  (`Grid::scrollback`) but there's no way to look at it yet. The GUI has
  xterm.js's.
- **No reflow on resize.** Lines are truncated and padded, not re-wrapped.
  tmux mostly declines to solve this too.
- **Mouse depends on the host.** Clicks in the console version rely on conhost
  translating them into VT sequences. Works in Windows Terminal; may not in the
  legacy console host. Every action has a keyboard equivalent.
- Combining characters are dropped rather than composed onto the previous cell.
- No bracketed paste, no mouse forwarding to child programs, no sixel.
- Nothing is code signed, so both installers trip SmartScreen.

## Three things that will bite you here

Recording these because all three cost real time and none is obvious.

**A raw byte reader is not a terminal.** `cmd.exe` opens by sending `\x1b[6n`
(report cursor position) and then *blocks until something answers*. A plain
byte sink deadlocks after exactly four bytes. The console front end answers from
`Grid`; the GUI relies on xterm.js answering.

**A WebView2 can only be created before the event loop runs.** Creating one from
a command handler wedges the main thread permanently. Every later command stops
being answered, which looks like the app going quiet rather than like an error.
That's why browsers come from a pool built during `setup` and handed out
afterwards, and why there is a ceiling on how many terminals get one.

**ConPTY repaints on every resize, including one to the size it is already at.**
The GUI recomputes its layout on window resize, splitter drags and opening the
browser, and each of those used to forward a resize unconditionally. An
interactive TUI answers a repaint by reprinting its banner, so a handful of
those in a row filled the pane with copies of it, looking for all the world like
the output stream had duplicated itself. `syncSize` now drops a resize that
would not change `cols` or `rows`.

## Tests

```
cargo test --workspace
```

The unit tests feed bytes to the emulator directly; `tests/pty_smoke.rs` spawns
real `cmd.exe` processes through ConPTY and checks that commands execute, that
an unattended pane keeps making progress, that resize reaches the child, that a
dead shell is noticed, and that a composed frame actually contains the rail, the
divider, and live output. `cwd` checks it can read this process's own working
directory, and `persist` checks a session survives a round trip and that a
prompt gives up the directory it is sitting in.
