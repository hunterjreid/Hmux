//! One ConPTY child process, with none of the opinions about what to do with
//! its output.
//!
//! Two very different front ends need this: the console UI feeds the bytes to
//! its own emulator ([`crate::grid::Grid`]), the GUI ships them to xterm.js.
//! The Windows-specific parts — ConPTY setup, the exit detection ConPTY forces
//! on you, resize plumbing — are subtle enough that having two copies would
//! guarantee they drift.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

pub struct PtyProcess {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    alive: Arc<AtomicBool>,
    pid: Option<u32>,
}

impl PtyProcess {
    /// Start `program` under a new pseudoconsole, in whatever directory hmux
    /// itself is running from. Returns the handle plus the read side, which the
    /// caller is expected to drain on its own thread.
    pub fn spawn(program: &str, cols: u16, rows: u16) -> Result<(Self, Box<dyn Read + Send>)> {
        Self::spawn_in(program, None, cols, rows)
    }

    /// As [`spawn`](Self::spawn), but starting in `cwd`.
    ///
    /// Restoring a session needs the shell to come back up where the old one
    /// left off. Spawning it anywhere else and then writing a `cd` into the pty
    /// would work, but it puts a command in the history the user never typed
    /// and races whatever the shell's profile is doing at the time.
    pub fn spawn_in(
        program: &str,
        cwd: Option<&std::path::Path>,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, Box<dyn Read + Send>)> {
        let cols = cols.max(1);
        let rows = rows.max(1);

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open a ConPTY — needs Windows 10 1809 or newer")?;

        let mut cmd = CommandBuilder::new(program);
        // A directory that has since been deleted would make the spawn fail
        // outright, so fall back rather than refusing to open a terminal.
        match cwd.filter(|p| p.is_dir()) {
            Some(dir) => cmd.cwd(dir),
            None => {
                if let Ok(here) = std::env::current_dir() {
                    cmd.cwd(here);
                }
            }
        }

        // Tell programs what this terminal can actually do.
        //
        // TERM alone is not enough. Node's `supports-color` (and most of the
        // ecosystem built on it) treats a terminal without COLORTERM as
        // 16-colour, and rich TUIs then collapse their entire palette onto one
        // of those sixteen — which reads as "the terminal has no colours" when
        // the terminal was never the problem.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "hmux");

        // Whatever launched hmux may have had colour switched off for its own
        // output — build scripts, CI wrappers and agent harnesses all do this.
        // Inheriting that would silently strip colour from every shell inside a
        // terminal that has just declared itself truecolor, and the symptom
        // ("this terminal has no colours") points nowhere near the cause.
        // Anyone who genuinely wants monochrome can still set it in the shell.
        cmd.env_remove("NO_COLOR");
        cmd.env_remove("NODE_DISABLE_COLORS");

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to start {program}"))?;
        let pid = child.process_id();

        // The slave handle must go away or the pty never reports EOF when the
        // child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));

        Ok((
            PtyProcess {
                writer,
                master: pair.master,
                child: Arc::new(Mutex::new(child)),
                alive: Arc::new(AtomicBool::new(true)),
                pid,
            },
            reader,
        ))
    }

    /// Call `on_exit` once the child dies.
    ///
    /// On Unix the reader hitting EOF would be enough. ConPTY keeps its output
    /// pipe open until the pseudoconsole itself is closed, so the read never
    /// ends and the process has to be watched directly — without this an exited
    /// shell looks alive forever. Polls rather than blocking in `wait()` so
    /// [`kill`](Self::kill) can still take the lock.
    pub fn watch_exit<F>(&self, on_exit: F)
    where
        F: FnOnce() + Send + 'static,
    {
        let child = Arc::clone(&self.child);
        let alive = Arc::clone(&self.alive);

        std::thread::Builder::new()
            .name("pty-waiter".into())
            .spawn(move || {
                loop {
                    let finished = match child.lock() {
                        Ok(mut c) => !matches!(c.try_wait(), Ok(None)),
                        Err(_) => true,
                    };
                    if finished {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                // One-shot: a reader noticing EOF may race us here.
                if alive.swap(false, Ordering::Relaxed) {
                    on_exit();
                }
            })
            .expect("failed to spawn pty waiter thread");
    }

    /// Mark the process dead exactly once. Returns true for the caller that won
    /// the race, so an exit is reported a single time.
    pub fn mark_dead(&self) -> bool {
        self.alive.swap(false, Ordering::Relaxed)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// The shell's own process id. Used to ask the OS whether it currently has
    /// children, which is how idle-versus-busy is decided.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The write side, for a reader thread that needs to answer the child's
    /// queries (cursor position, device attributes) without going through the
    /// owning pane.
    pub fn reply_channel(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        Arc::clone(&self.writer)
    }

    /// Shared liveness flag, so a reader noticing EOF can report the death
    /// itself and race the waiter safely.
    pub fn alive_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.alive)
    }

    pub fn write_input(&self, bytes: &[u8]) {
        if !self.is_alive() {
            return;
        }
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(bytes);
            let _ = w.flush();
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn kill(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
        self.alive.store(false, Ordering::Relaxed);
    }
}
