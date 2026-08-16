# mux

Terminals that keep running whether or not you're looking at them, in two front
ends: a GUI app, and a console-only version.

## The GUI — `cargo run --release -p mux-gui`

Thick buttons down the left with a live idle/busy light, the active terminal in
the middle, and **that terminal's own browser** on the right.

```
┌────────────┬──────────────────────┬──────────────────┐
│ TERMINALS  │ cmd 1   running ping │ ‹ › ⟳  address   │
│ ● cmd 1    │ Reply from 127.0.0.1 ├──────────────────┤
│   ping     │ Reply from 127.0.0.1 │                  │
│ ○ cmd 2    │                      │   its own page   │
│   idle     │                      │                  │
│  + new     │                      │                  │
└────────────┴──────────────────────┴──────────────────┘
```

Each terminal owns a browser, so switching terminals switches the page —
scroll position, forms and logins all still there, because it is a separate
webview rather than one that re-navigates.

**Idle or busy is asked of the OS, not guessed from output.** A shell sitting at
a prompt has no child processes; a shell running `ping` has `ping.exe` under it.
So a compile that has been silent for a minute still reads as busy, which the
usual "did it print recently" heuristic gets wrong. It walks to the deepest
descendant, so `cargo` spawning `rustc` reads as `rustc`.

Colours are the Windows console's own Campbell palette, with the 256-colour cube
and 24-bit truecolor passed through untouched.

Problems go to `%TEMP%\mux.log` and to a banner in the window. A GUI has nowhere
to print, and a silent failure is how a bug here stays invisible.

---

## The console version — `cargo run --release --bin mux`

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
│ mux · 3/3 live · pane 1   C-b c new  …    │
└───────────────────────────────────────────┘
```

Every button is a real ConPTY running a real shell, and **all of them keep
running whether or not they're on screen**. Switching is a change of view, not a
change to the process: a build you started in pane 2 keeps building while you
work in pane 1, and switching back shows its current screen, not a blank one.

## Build and run

```
cargo build --release
.\target\release\mux.exe
.\target\release\mux.exe --shell powershell.exe
```

Needs Windows 10 1809 or newer (for ConPTY) and a real console — piping its
output somewhere is refused with a clear message rather than a crash.

## Keys

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

## How it works

The interesting thing about a multiplexer is that a pane cannot be a byte pipe.
The moment a pane is hidden or resized you have to be able to *redraw* it, and
the only way is to have kept the screen it would have drawn. So there is a
terminal emulator inside:

| Module | Job |
| --- | --- |
| `term` | the host console — raw mode, VT in/out, alternate screen, restored on drop and on panic |
| `pane` | one ConPTY child, a reader thread draining it, a waiter thread watching it die |
| `grid` | the emulator: a rectangle of styled cells, mutated by the escape sequences the shell emits |
| `layout` | where the rail, the terminal, and the status line are |
| `render` | compose a frame from chrome + active grid, diff against the last one, emit only the difference |
| `input` | prefix chords and mouse reports vs. everything else, which is forwarded untouched |

`vte` does the escape-sequence lexing (it's Alacritty's parser). Everything in
`grid.rs` is the semantics — what each sequence does to the screen.

Two things that are easy to get wrong and are handled:

- **Deferred wrap.** Printing in the last column must *not* move to the next
  line; the wrap happens when the next character arrives. Emulators that wrap
  eagerly scroll a line early on full-width output.
- **Replies.** `CSI 6n` and `CSI c` are questions. A program that asks and never
  hears back will hang, so the grid queues answers and the pane writes them back
  to the pty.

## What isn't done

- **Not detachable.** Panes survive *switching*, not mux exiting — quitting
  kills the shells. Real detach/reattach needs a daemon that owns the ptys with
  the UI as a thin client over a named pipe. That's the next big piece, and the
  reason the pty state deliberately lives behind `Arc<Mutex<…>>` rather than in
  the render loop.
- **No scrollback UI.** History is captured (`Grid::scrollback`) but there's no
  way to look at it yet.
- **No reflow on resize.** Lines are truncated and padded, not re-wrapped —
  tmux mostly declines to solve this too.
- **Mouse depends on the host.** Clicks rely on conhost translating them into VT
  sequences. Works in Windows Terminal; may not in the legacy console host. Every
  action has a keyboard equivalent.
- Combining characters are dropped rather than composed onto the previous cell.
- No bracketed paste, no mouse forwarding to child programs, no sixel.

## Two things that will bite you here

Recording these because both cost real time and neither is obvious.

**A raw byte reader is not a terminal.** `cmd.exe` opens by sending `\x1b[6n`
(report cursor position) and then *blocks until something answers*. A plain
byte sink deadlocks after exactly four bytes. The console front end answers from
`Grid`; the GUI relies on xterm.js answering.

**A WebView2 can only be created before the event loop runs.** Creating one from
a command handler wedges the main thread permanently — every later command stops
being answered, which looks like the app going quiet rather than like an error.
That's why browsers come from a pool built during `setup` and handed out
afterwards, and why there is a ceiling on how many terminals get one.

## Tests

```
cargo test --workspace
```

52 tests. The unit tests feed bytes to the emulator directly; `tests/pty_smoke.rs`
spawns real `cmd.exe` processes through ConPTY and checks that commands execute,
that an unattended pane keeps making progress, that resize reaches the child,
that a dead shell is noticed, and that a composed frame actually contains the
rail, the divider, and live output.
