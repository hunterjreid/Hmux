//! A terminal: one ConPTY, one child shell, one `Grid`.
//!
//! The important property is that a pane is *not* ephemeral. Its reader thread
//! runs for the pane's whole life, feeding output into the grid whether or not
//! anyone is looking at it. Switching away from a pane does nothing to it —
//! the build keeps building, the prompt keeps working — and switching back
//! shows the real current screen because the grid never stopped being updated.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use vte::Parser;

use crate::grid::Grid;
use crate::Ev;

pub struct Pane {
    pub id: usize,
    /// What the user named it, e.g. "cmd". The child can override this via an
    /// OSC title sequence, which we surface on the button.
    pub label: String,
    pub grid: Arc<Mutex<Grid>>,
    pub alive: Arc<AtomicBool>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    /// Shared with the waiter thread. On Unix the reader hitting EOF would be
    /// enough to know the child is gone; ConPTY keeps its output pipe open
    /// until the pseudoconsole is closed, so the process has to be watched
    /// directly or an exited shell looks alive forever.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl Pane {
    pub fn spawn(
        id: usize,
        label: &str,
        program: &str,
        cols: u16,
        rows: u16,
        events: Sender<Ev>,
    ) -> Result<Self> {
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
        if let Ok(cwd) = std::env::current_dir() {
            cmd.cwd(cwd);
        }
        // Advertise a terminal type; some tools consult it before emitting colour.
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to start {program}"))?;

        // The slave handle must go away or the pty never reports EOF when the
        // child exits, and the pane would look alive forever.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let grid = Arc::new(Mutex::new(Grid::new(cols as usize, rows as usize)));
        let alive = Arc::new(AtomicBool::new(true));
        let child = Arc::new(Mutex::new(child));

        spawn_reader(
            id,
            reader,
            Arc::clone(&grid),
            Arc::clone(&writer),
            Arc::clone(&alive),
            events.clone(),
        );
        spawn_waiter(id, Arc::clone(&child), Arc::clone(&alive), events);

        Ok(Pane {
            id,
            label: label.to_string(),
            grid,
            alive,
            writer,
            master: pair.master,
            child,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Title reported by the child, falling back to the label we gave it.
    pub fn display_name(&self) -> String {
        let title = self.grid.lock().unwrap().title.clone();
        if title.is_empty() {
            self.label.clone()
        } else {
            title
        }
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
        let cols = cols.max(1);
        let rows = rows.max(1);
        // Order matters: resize our model first so a redraw racing the child's
        // response never indexes outside the grid.
        self.grid.lock().unwrap().resize(cols as usize, rows as usize);
        let _ = self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn kill(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
        self.alive.store(false, Ordering::Relaxed);
    }
}

/// Watches the child process itself, because on Windows the pty gives us no
/// signal when it dies. Polls rather than blocking in `wait()` so that `kill`
/// can still take the lock.
fn spawn_waiter(
    id: usize,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    alive: Arc<AtomicBool>,
    events: Sender<Ev>,
) {
    std::thread::Builder::new()
        .name(format!("pane-{id}-waiter"))
        .spawn(move || loop {
            let finished = match child.lock() {
                Ok(mut c) => !matches!(c.try_wait(), Ok(None)),
                Err(_) => true,
            };

            if finished {
                // `swap` makes this a one-shot: the reader may also notice EOF
                // and we want exactly one exit event per pane.
                if alive.swap(false, Ordering::Relaxed) {
                    let _ = events.send(Ev::Exited(id));
                }
                return;
            }

            std::thread::sleep(std::time::Duration::from_millis(150));
        })
        .expect("failed to spawn pane waiter thread");
}

fn spawn_reader(
    id: usize,
    mut reader: Box<dyn Read + Send>,
    grid: Arc<Mutex<Grid>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    events: Sender<Ev>,
) {
    std::thread::Builder::new()
        .name(format!("pane-{id}-reader"))
        .spawn(move || {
            let mut parser = Parser::new();
            let mut buf = [0u8; 8192];

            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };

                let reply = {
                    let mut g = grid.lock().unwrap();
                    parser.advance(&mut *g, &buf[..n]);
                    g.take_reply()
                };

                // Cursor-position and device-attribute answers go straight back
                // to the child; it may be blocked waiting on them.
                if !reply.is_empty() {
                    if let Ok(mut w) = writer.lock() {
                        let _ = w.write_all(&reply);
                        let _ = w.flush();
                    }
                }

                if events.send(Ev::Output).is_err() {
                    return; // main loop is gone; shut this thread down
                }
            }

            if alive.swap(false, Ordering::Relaxed) {
                let _ = events.send(Ev::Exited(id));
            }
        })
        .expect("failed to spawn pane reader thread");
}
