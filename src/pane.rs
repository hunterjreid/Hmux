//! A terminal: one ConPTY, one child shell, one `Grid`.
//!
//! The important property is that a pane is *not* ephemeral. Its reader thread
//! runs for the pane's whole life, feeding output into the grid whether or not
//! anyone is looking at it. Switching away from a pane does nothing to it —
//! the build keeps building, the prompt keeps working — and switching back
//! shows the real current screen because the grid never stopped being updated.

use std::io::{Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use vte::Parser;

use crate::grid::Grid;
use crate::pty::PtyProcess;
use crate::Ev;

pub struct Pane {
    pub id: usize,
    /// What the user named it, e.g. "cmd". The child can override this via an
    /// OSC title sequence, which we surface on the button.
    pub label: String,
    pub grid: Arc<Mutex<Grid>>,
    proc: PtyProcess,
    /// When this pane last produced output, which is how a command that is
    /// working is told apart from one waiting on input.
    last_output: Arc<Mutex<std::time::Instant>>,
}

/// How recently a terminal must have printed something to count as working.
const WORKING_WINDOW: std::time::Duration = std::time::Duration::from_millis(700);

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

        let (proc, reader) = PtyProcess::spawn(program, cols, rows)?;
        let grid = Arc::new(Mutex::new(Grid::new(cols as usize, rows as usize)));
        let last_output = Arc::new(Mutex::new(std::time::Instant::now()));

        spawn_reader(
            id,
            reader,
            Arc::clone(&grid),
            Arc::clone(&last_output),
            &proc,
            events.clone(),
        );

        let exit_tx = events;
        proc.watch_exit(move || {
            let _ = exit_tx.send(Ev::Exited(id));
        });

        Ok(Pane {
            id,
            label: label.to_string(),
            grid,
            proc,
            last_output,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.proc.is_alive()
    }

    /// Whether this pane is running a command, and whether that command is
    /// actually doing anything right now.
    pub fn activity(&self, table: &crate::activity::ProcessTable) -> crate::activity::Activity {
        let working = self
            .last_output
            .lock()
            .map(|t| t.elapsed() < WORKING_WINDOW)
            .unwrap_or(false);
        table.activity_of(self.proc.pid(), self.is_alive(), working)
    }

    /// Title reported by the child, falling back to the label we gave it.
    pub fn display_name(&self) -> String {
        let title = self.grid.lock().unwrap().title.clone();
        if title.is_empty() {
            return self.label.clone();
        }
        shorten_title(&title)
    }

    pub fn write_input(&self, bytes: &[u8]) {
        self.proc.write_input(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        // Order matters: resize our model first so a redraw racing the child's
        // response never indexes outside the grid.
        self.grid.lock().unwrap().resize(cols as usize, rows as usize);
        self.proc.resize(cols, rows);
    }

    pub fn kill(&mut self) {
        self.proc.kill();
    }
}

// The old per-pane waiter now lives in `PtyProcess::watch_exit`, shared with
// the GUI front end.

/// cmd.exe announces its title as the full path to its own executable, which
/// fills a narrow button with `C:\Windows\syst` and tells you nothing. Reduce a
/// bare executable path to its stem; leave any other title alone, since a
/// program that sets a real title means it.
fn shorten_title(title: &str) -> String {
    let t = title.trim();
    // Keyed on a path separator rather than the absence of spaces: plenty of
    // real paths live under "Program Files".
    if t.to_ascii_lowercase().ends_with(".exe") && (t.contains('\\') || t.contains('/')) {
        if let Some(stem) = std::path::Path::new(t).file_stem() {
            return stem.to_string_lossy().to_string();
        }
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::shorten_title;

    #[test]
    fn executable_paths_are_reduced_to_a_name() {
        assert_eq!(shorten_title(r"C:\Windows\system32\cmd.exe"), "cmd");
        assert_eq!(shorten_title(r"C:\Program Files\PowerShell\pwsh.exe"), "pwsh");
    }

    #[test]
    fn a_real_title_is_left_alone() {
        assert_eq!(shorten_title("npm run dev"), "npm run dev");
        assert_eq!(shorten_title("vim README.md"), "vim README.md");
    }
}

fn spawn_reader(
    id: usize,
    mut reader: Box<dyn Read + Send>,
    grid: Arc<Mutex<Grid>>,
    last_output: Arc<Mutex<std::time::Instant>>,
    proc: &PtyProcess,
    events: Sender<Ev>,
) {
    // Cloned so the reader can answer the child's queries without holding a
    // borrow on the pane.
    let replies = proc.reply_channel();
    let alive = proc.alive_handle();

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

                if let Ok(mut t) = last_output.lock() {
                    *t = std::time::Instant::now();
                }

                let reply = {
                    let mut g = grid.lock().unwrap();
                    parser.advance(&mut *g, &buf[..n]);
                    g.take_reply()
                };

                // Cursor-position and device-attribute answers go straight back
                // to the child; it may be blocked waiting on them.
                if !reply.is_empty() {
                    if let Ok(mut w) = replies.lock() {
                        let _ = w.write_all(&reply);
                        let _ = w.flush();
                    }
                }

                if events.send(Ev::Output).is_err() {
                    return; // main loop is gone; shut this thread down
                }
            }

            if alive.swap(false, std::sync::atomic::Ordering::Relaxed) {
                let _ = events.send(Ev::Exited(id));
            }
        })
        .expect("failed to spawn pane reader thread");
}
