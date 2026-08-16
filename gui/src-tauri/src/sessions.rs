//! The set of live terminals.
//!
//! Each session is a `PtyProcess` plus a reader thread that does two things
//! with every chunk it receives: push it to the webview, and append it to a
//! bounded backlog.
//!
//! The backlog exists so a view can be attached to a session that has already
//! been running — output produced before anyone was listening is not lost.
//!
//! Every chunk carries a sequence number and the backlog reports the last
//! sequence it contains. Without that the receiver cannot tell which live
//! chunks a replay already covered, and it writes them twice.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use mux::activity::ProcessTable;
use mux::pty::PtyProcess;

use crate::TerminalInfo;

pub type SessionId = u32;

/// Roughly a few thousand lines of scrollback per terminal. Bounded because an
/// unattended `ping -t` would otherwise grow without limit.
const BACKLOG_LIMIT: usize = 512 * 1024;

#[derive(Clone, Serialize)]
pub struct Chunk {
    pub id: SessionId,
    pub data: String,
    /// Monotonic per session. Lets a late attacher discard the chunks its
    /// backlog replay already contained.
    pub seq: u64,
}

/// A replay plus the point in the stream it reaches.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlog {
    pub text: String,
    pub last_seq: u64,
}

/// Output history for one session, guarded as a unit so the text and the
/// sequence number can never disagree.
#[derive(Default)]
struct History {
    text: Vec<u8>,
    last_seq: u64,
}

/// How recently a terminal must have printed something to count as working.
///
/// An interactive TUI redraws constantly while it is doing something — a
/// spinner alone is several frames a second — and falls silent the moment it
/// wants input. Comfortably longer than a spinner frame, short enough that
/// "finished" registers immediately.
const WORKING_WINDOW: Duration = Duration::from_millis(700);

struct Session {
    id: SessionId,
    title: String,
    proc: PtyProcess,
    history: Arc<Mutex<History>>,
    /// When this terminal last produced output.
    last_output: Arc<Mutex<Instant>>,
}

#[derive(Default)]
pub struct Sessions {
    map: HashMap<SessionId, Session>,
    /// Preserves button order; a HashMap would shuffle the sidebar on every
    /// repaint.
    order: Vec<SessionId>,
    next_id: SessionId,
}

impl Sessions {
    pub fn create(
        &mut self,
        app: &AppHandle,
        shell: &str,
        cols: u16,
        rows: u16,
    ) -> Result<SessionId> {
        self.next_id += 1;
        let id = self.next_id;

        let (proc, reader) = PtyProcess::spawn(shell, cols, rows)?;
        let history = Arc::new(Mutex::new(History::default()));
        let last_output = Arc::new(Mutex::new(Instant::now()));

        spawn_reader(
            id,
            reader,
            Arc::clone(&history),
            Arc::clone(&last_output),
            app.clone(),
            &proc,
        );

        let exit_app = app.clone();
        proc.watch_exit(move || {
            let _ = exit_app.emit("terminal-exit", id);
        });

        let title = std::path::Path::new(shell)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| shell.to_string());

        self.map.insert(
            id,
            Session {
                id,
                title,
                proc,
                history,
                last_output,
            },
        );
        self.order.push(id);
        Ok(id)
    }

    pub fn write(&self, id: SessionId, bytes: &[u8]) {
        if let Some(s) = self.map.get(&id) {
            s.proc.write_input(bytes);
        }
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) {
        if let Some(s) = self.map.get(&id) {
            s.proc.resize(cols, rows);
        }
    }

    pub fn close(&mut self, id: SessionId) {
        if let Some(s) = self.map.remove(&id) {
            s.proc.kill();
        }
        self.order.retain(|&x| x != id);
    }

    pub fn backlog(&self, id: SessionId) -> Backlog {
        self.map
            .get(&id)
            .and_then(|s| s.history.lock().ok())
            .map(|h| Backlog {
                text: String::from_utf8_lossy(&h.text).to_string(),
                last_seq: h.last_seq,
            })
            .unwrap_or(Backlog {
                text: String::new(),
                last_seq: 0,
            })
    }

    /// Current state of every terminal, in button order.
    pub fn info(&self) -> Vec<TerminalInfo> {
        // One process-table walk for all sessions.
        let table = ProcessTable::capture();

        self.order
            .iter()
            .filter_map(|id| self.map.get(id))
            .map(|s| {
                let working = s
                    .last_output
                    .lock()
                    .map(|t| t.elapsed() < WORKING_WINDOW)
                    .unwrap_or(false);
                let activity = table.activity_of(s.proc.pid(), s.proc.is_alive(), working);
                TerminalInfo {
                    id: s.id,
                    title: s.title.clone(),
                    status: activity.label(),
                    busy: activity.is_busy(),
                    running: activity.is_running(),
                    alive: s.proc.is_alive(),
                }
            })
            .collect()
    }
}

fn spawn_reader(
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    history: Arc<Mutex<History>>,
    last_output: Arc<Mutex<Instant>>,
    app: AppHandle,
    proc: &PtyProcess,
) {
    let alive = proc.alive_handle();

    std::thread::Builder::new()
        .name(format!("session-{id}-reader"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            // A multi-byte character can straddle a read boundary; holding the
            // tail avoids emitting a replacement character mid-glyph.
            let mut carry: Vec<u8> = Vec::new();

            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };

                carry.extend_from_slice(&buf[..n]);
                let text = match std::str::from_utf8(&carry) {
                    Ok(s) => {
                        let owned = s.to_string();
                        carry.clear();
                        owned
                    }
                    Err(e) => {
                        let good = e.valid_up_to();
                        let owned =
                            String::from_utf8_lossy(&carry[..good]).to_string();
                        carry.drain(..good);
                        // A genuinely invalid sequence would never drain; cap
                        // the carry so one bad byte can't wedge the stream.
                        if carry.len() > 8 {
                            carry.clear();
                        }
                        owned
                    }
                };

                if text.is_empty() {
                    continue;
                }

                // Stamped before the emit so a slow UI cannot make a working
                // terminal look idle.
                if let Ok(mut t) = last_output.lock() {
                    *t = Instant::now();
                }

                // Append and take the sequence number under one lock, so the
                // number a chunk carries always matches what the backlog holds.
                let seq = match history.lock() {
                    Ok(mut h) => {
                        h.text.extend_from_slice(text.as_bytes());
                        if h.text.len() > BACKLOG_LIMIT {
                            let excess = h.text.len() - BACKLOG_LIMIT;
                            h.text.drain(..excess);
                        }
                        h.last_seq += 1;
                        h.last_seq
                    }
                    Err(_) => return,
                };

                if app
                    .emit("terminal-output", Chunk { id, data: text, seq })
                    .is_err()
                {
                    return;
                }
            }

            if alive.swap(false, std::sync::atomic::Ordering::Relaxed) {
                let _ = app.emit("terminal-exit", id);
            }
        })
        .expect("failed to spawn session reader thread");
}
