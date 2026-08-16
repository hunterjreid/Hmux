//! A rail of buttons down the left, one terminal filling the rest of the
//! screen. Every terminal is a real ConPTY running a real shell, and every one
//! of them keeps running whether or not it is the one on screen: switching
//! panes is a change of view, never a change to the process behind it.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use mux::input::{Action, Router};
use mux::pane::Pane;
use mux::render::Renderer;
use mux::{layout, render, term, Ev};

/// What the panes are. `cmd.exe` because that's the shell being multiplexed;
/// `--shell` overrides it.
const DEFAULT_SHELL: &str = "cmd.exe";
const DEFAULT_SIDEBAR_W: u16 = 20;

/// Roughly 60fps. Output arrives in bursts far faster than that, so the loop
/// coalesces everything that lands inside one frame into a single repaint.
const FRAME: Duration = Duration::from_millis(16);
/// Windows has no SIGWINCH, so console size is polled instead.
const RESIZE_POLL: Duration = Duration::from_millis(100);

fn main() {
    let shell = parse_args();

    if let Err(e) = run(&shell) {
        // The HostTerm guard has been dropped by now, so the console is back to
        // normal and this is readable.
        eprintln!("mux: {e:#}");
        std::process::exit(1);
    }
}

fn parse_args() -> String {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--shell" | "-s" => {
                if let Some(s) = args.next() {
                    return s;
                }
            }
            "-h" | "--help" => {
                println!(
                    "mux — terminal multiplexer\n\n\
                     usage: mux [--shell <program>]\n\n\
                     keys:\n  \
                       C-b c    new terminal\n  \
                       C-b n/p  next / previous\n  \
                       C-b 1-9  select by number\n  \
                       C-b x    close terminal\n  \
                       C-b < >  narrow / widen the rail\n  \
                       C-b r    force redraw\n  \
                       C-b q    quit\n  \
                       C-b C-b  send a literal Ctrl-B\n\n\
                     Buttons on the left are clickable."
                );
                std::process::exit(0);
            }
            _ => {}
        }
    }
    DEFAULT_SHELL.to_string()
}

struct Mux {
    panes: Vec<Pane>,
    active: usize,
    sidebar_w: u16,
    cols: u16,
    rows: u16,
    shell: String,
    next_id: usize,
    events: Sender<Ev>,
}

impl Mux {
    fn layout(&self) -> layout::Layout {
        layout::compute(self.cols, self.rows, self.sidebar_w)
    }

    fn spawn_pane(&mut self) -> Result<()> {
        let l = self.layout();
        let id = self.next_id;
        self.next_id += 1;

        let label = std::path::Path::new(&self.shell)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| self.shell.clone());

        let pane = Pane::spawn(
            id,
            &label,
            &self.shell,
            l.content.w,
            l.content.h,
            self.events.clone(),
        )?;

        self.panes.push(pane);
        self.active = self.panes.len() - 1;
        Ok(())
    }

    fn close_active(&mut self) {
        if self.panes.is_empty() {
            return;
        }
        let mut pane = self.panes.remove(self.active);
        pane.kill();
        if self.active >= self.panes.len() {
            self.active = self.panes.len().saturating_sub(1);
        }
    }

    /// Every pane is resized, not just the visible one — a hidden shell that
    /// still thinks it has the old width will wrap its next prompt wrongly the
    /// instant you switch back to it.
    fn resize_all(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        let l = self.layout();
        for p in &self.panes {
            p.resize(l.content.w, l.content.h);
        }
    }

    fn select(&mut self, idx: usize) {
        if idx < self.panes.len() {
            self.active = idx;
        }
    }

    fn cycle(&mut self, forward: bool) {
        if self.panes.is_empty() {
            return;
        }
        let n = self.panes.len();
        self.active = if forward {
            (self.active + 1) % n
        } else {
            (self.active + n - 1) % n
        };
    }
}

fn run(shell: &str) -> Result<()> {
    let mut host = term::HostTerm::enter().context("could not take over the console")?;

    // The panic hook runs *before* unwinding, so it has to get us off the
    // alternate screen itself — otherwise the message prints onto a buffer
    // that's about to be discarded and the user sees a bare exit. Console
    // modes are handled by `HostTerm::drop` during the unwind that follows.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(b"\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
        let _ = out.flush();
        default_hook(info);
    }));

    let (tx, rx) = mpsc::channel::<Ev>();

    // Reading stdin has to be its own thread: `ReadFile` on the console blocks,
    // and the main loop must stay free to repaint panes that are producing
    // output while nobody is typing.
    {
        let tx = tx.clone();
        std::thread::Builder::new()
            .name("stdin".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match term::read_stdin(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if tx.send(Ev::Input(buf[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .context("failed to spawn stdin reader")?;
    }

    let (cols, rows) = term::size();
    let mut mux = Mux {
        panes: Vec::new(),
        active: 0,
        sidebar_w: DEFAULT_SIDEBAR_W,
        cols,
        rows,
        shell: shell.to_string(),
        next_id: 1,
        events: tx,
    };
    mux.spawn_pane()?;

    let mut router = Router::new();
    let mut renderer = Renderer::new();
    let mut dirty = true;
    let mut last_frame = Instant::now();
    let mut last_resize_check = Instant::now();

    'outer: loop {
        match rx.recv_timeout(FRAME) {
            Ok(ev) => {
                if handle(&mut mux, &mut router, &mut renderer, ev)? {
                    break 'outer;
                }
                dirty = true;
                // Drain the burst: a busy shell can queue hundreds of output
                // events per frame and each one does not deserve a repaint.
                while let Ok(ev) = rx.try_recv() {
                    if handle(&mut mux, &mut router, &mut renderer, ev)? {
                        break 'outer;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break 'outer,
        }

        if last_resize_check.elapsed() >= RESIZE_POLL {
            last_resize_check = Instant::now();
            let (c, r) = term::size();
            if (c, r) != (mux.cols, mux.rows) {
                mux.resize_all(c, r);
                renderer.invalidate();
                dirty = true;
            }
        }

        if mux.panes.is_empty() {
            break;
        }

        if dirty && last_frame.elapsed() >= FRAME {
            let l = mux.layout();
            let frame = render::compose(
                &mux.panes,
                mux.active,
                &l,
                mux.cols,
                mux.rows,
                router.prefix_armed(),
            );
            renderer.draw(&frame)?;
            dirty = false;
            last_frame = Instant::now();
        }
    }

    host.restore();
    Ok(())
}

/// Returns `Ok(true)` when the user asked to quit.
fn handle(mux: &mut Mux, router: &mut Router, renderer: &mut Renderer, ev: Ev) -> Result<bool> {
    match ev {
        Ev::Output => {}
        Ev::Exited(id) => {
            // The pane stays in the list showing "(exited)" rather than
            // vanishing — a shell that died from a typo should leave its output
            // on screen to be read, not disappear.
            let _ = id;
        }
        Ev::Input(bytes) => {
            for action in router.feed(&bytes) {
                match action {
                    Action::Forward(b) => {
                        if let Some(p) = mux.panes.get(mux.active) {
                            p.write_input(&b);
                        }
                    }
                    Action::NewPane => mux.spawn_pane()?,
                    Action::ClosePane => {
                        mux.close_active();
                        renderer.invalidate();
                        if mux.panes.is_empty() {
                            return Ok(true);
                        }
                    }
                    Action::NextPane => mux.cycle(true),
                    Action::PrevPane => mux.cycle(false),
                    Action::SelectPane(i) => mux.select(i),
                    Action::GrowSidebar => {
                        mux.sidebar_w = (mux.sidebar_w + 2).min(layout::SIDEBAR_MAX);
                        let (c, r) = (mux.cols, mux.rows);
                        mux.resize_all(c, r);
                        renderer.invalidate();
                    }
                    Action::ShrinkSidebar => {
                        mux.sidebar_w = mux.sidebar_w.saturating_sub(2).max(layout::SIDEBAR_MIN);
                        let (c, r) = (mux.cols, mux.rows);
                        mux.resize_all(c, r);
                        renderer.invalidate();
                    }
                    Action::Redraw => renderer.invalidate(),
                    Action::Quit => return Ok(true),
                    Action::Mouse(m) => {
                        // Only act on press; the matching release would
                        // otherwise fire every action twice.
                        if !m.pressed || m.button != 0 {
                            continue;
                        }
                        let l = mux.layout();
                        if l.is_new_button(m.x, m.y) {
                            mux.spawn_pane()?;
                        } else if let Some(i) = l.button_at(m.x, m.y, mux.panes.len()) {
                            mux.select(i);
                        }
                    }
                }
            }
        }
    }
    Ok(false)
}
