//! The set of live terminals — none of which live here.
//!
//! This used to own the pseudoconsoles. It does not any more: they belong to
//! `hmux-daemon`, a process with no window, and this is the half that talks to
//! it. The reason is the one thing a window cannot do, which is outlive itself.
//! A terminal owned by the GUI ends when the GUI ends, so every restart began
//! with fresh shells and a picture of the old ones. Owned by the daemon, the
//! window is a view onto something that was already running and still is.
//!
//! The shape of this module is deliberately unchanged from when it owned the
//! ptys — same methods, same events out to the webview, same sequence numbers.
//! Everything above it was written against that surface and none of it cares
//! where the bytes come from.
//!
//! Two connections, because a named pipe cannot be read and written at the same
//! time; see [`hmux::proto::Role`].

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use hmux::proto::{Event, Request, Role, SessionInfo};

pub type SessionId = u32;

/// How long to wait for the daemon to answer something we cannot proceed
/// without. Generous: starting a shell can be slow on a cold machine, and the
/// failure this guards against is a hang, not a delay.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);

/// How long to keep trying to reach a daemon we have just started.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Everything about a live session that is worth writing to disk.
pub struct Snapshot {
    pub shell: String,
    pub scrollback: String,
    /// Where the shell's process believes it is. Not always where its prompt
    /// says; see `persist::cwd_from_prompt`.
    pub cwd: Option<String>,
}

/// Answers we are waiting on, by the thing that will satisfy them.
///
/// The pipe carries one stream of events with no request ids in it, so a caller
/// that needs an answer parks a channel here and the reader thread hands the
/// matching event over. Creates are serialised by the state lock, so the queue
/// only ever needs to cope with one at a time; replays are keyed by session
/// because two terminals can be attaching at once on startup.
#[derive(Default)]
struct Waiting {
    created: Vec<Sender<SessionId>>,
    replays: HashMap<SessionId, Vec<Sender<Backlog>>>,
}

#[derive(Default)]
struct Shared {
    /// The last thing the daemon said the world looks like.
    infos: Mutex<Vec<SessionInfo>>,
    waiting: Mutex<Waiting>,
}

struct Client {
    /// The request half. Never read from.
    out: Mutex<File>,
    shared: Arc<Shared>,
}

#[derive(Default)]
pub struct Sessions {
    client: Option<Client>,
}

impl Sessions {
    /// Find the daemon, starting one if there is not already one running, and
    /// begin pumping its events into the webview.
    pub fn connect(&mut self, app: &AppHandle) -> Result<()> {
        // Short patience first: if a daemon is already up this succeeds at
        // once, and if there is none there is nothing to wait for yet.
        let (requests, events) = open_pair(Duration::from_millis(400)).or_else(|_| {
            start_daemon()?;
            open_pair(STARTUP_TIMEOUT)
        })?;

        let shared = Arc::new(Shared::default());
        spawn_event_reader(events, Arc::clone(&shared), app.clone());

        self.client = Some(Client {
            out: Mutex::new(requests),
            shared,
        });
        // Nothing is known until the daemon says so, and the first thing the UI
        // asks is what exists.
        self.ask(Request::List)?;
        Ok(())
    }

    fn client(&self) -> Result<&Client> {
        self.client
            .as_ref()
            .ok_or_else(|| anyhow!("not connected to the hmux daemon"))
    }

    fn ask(&self, req: Request) -> Result<()> {
        let client = self.client()?;
        let line = serde_json::to_string(&req)? + "\n";
        let mut out = client
            .out
            .lock()
            .map_err(|_| anyhow!("the request channel is poisoned"))?;
        out.write_all(line.as_bytes())
            .context("the daemon stopped listening")?;
        out.flush().ok();
        Ok(())
    }

    pub fn create(
        &mut self,
        _app: &AppHandle,
        shell: &str,
        cols: u16,
        rows: u16,
    ) -> Result<SessionId> {
        self.start(shell, None, String::new(), cols, rows)
    }

    /// Bring a session back: the same shell, in the directory the old one was
    /// working in, with the old one's output already in its backlog.
    ///
    /// Only reached when the daemon has nothing — after a reboot, or the very
    /// first run. Any other time the terminals are still there and are attached
    /// to rather than recreated.
    pub fn restore(
        &mut self,
        _app: &AppHandle,
        shell: &str,
        cwd: Option<PathBuf>,
        replay: String,
        cols: u16,
        rows: u16,
    ) -> Result<SessionId> {
        self.start(shell, cwd, replay, cols, rows)
    }

    fn start(
        &mut self,
        shell: &str,
        cwd: Option<PathBuf>,
        replay: String,
        cols: u16,
        rows: u16,
    ) -> Result<SessionId> {
        let (tx, rx) = channel();
        {
            let client = self.client()?;
            let mut waiting = client
                .shared
                .waiting
                .lock()
                .map_err(|_| anyhow!("the wait table is poisoned"))?;
            waiting.created.push(tx);
        }

        self.ask(Request::Create {
            shell: Some(shell.to_string()),
            cwd: cwd.map(|p| p.display().to_string()),
            cols,
            rows,
            replay: if replay.is_empty() {
                None
            } else {
                Some(replay)
            },
        })?;

        rx.recv_timeout(REPLY_TIMEOUT)
            .map_err(|_| anyhow!("the daemon did not start a shell"))
    }

    /// Attach to a terminal the daemon already had, and hand back everything it
    /// has said so far. The warm path: this is what makes a reopened window
    /// show the session rather than a new one.
    pub fn attach(&self, id: SessionId) -> Result<Backlog> {
        let (tx, rx) = channel();
        {
            let client = self.client()?;
            let mut waiting = client
                .shared
                .waiting
                .lock()
                .map_err(|_| anyhow!("the wait table is poisoned"))?;
            waiting.replays.entry(id).or_default().push(tx);
        }
        self.ask(Request::Attach { id, from: 0 })?;
        rx.recv_timeout(REPLY_TIMEOUT)
            .map_err(|_| anyhow!("the daemon did not send terminal {id}'s history"))
    }

    /// What the daemon knows about a session, for the session file.
    ///
    /// No scrollback: the text written to disk is the one the UI serialises out
    /// of its own buffer, because only the terminal that drew it knows what it
    /// ended up looking like.
    pub fn snapshot_of(&self, id: SessionId) -> Option<Snapshot> {
        let client = self.client().ok()?;
        let infos = client.shared.infos.lock().ok()?;
        let info = infos.iter().find(|i| i.id == id)?;
        Some(Snapshot {
            shell: info.shell.clone(),
            scrollback: String::new(),
            cwd: info.cwd.clone(),
        })
    }

    pub fn write(&self, id: SessionId, bytes: &[u8]) {
        let _ = self.ask(Request::Input {
            id,
            data: String::from_utf8_lossy(bytes).to_string(),
        });
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) {
        let _ = self.ask(Request::Resize { id, cols, rows });
    }

    pub fn close(&mut self, id: SessionId) {
        let _ = self.ask(Request::Close { id });
    }

    /// Ask the daemon to say what exists. The answer arrives as an event and
    /// updates [`Sessions::info`]; nothing waits for it.
    pub fn poll(&self) {
        let _ = self.ask(Request::List);
    }

    pub fn info(&self) -> Vec<SessionInfo> {
        self.client()
            .ok()
            .and_then(|c| c.shared.infos.lock().ok().map(|i| i.clone()))
            .unwrap_or_default()
    }
}

// ------------------------------------------------------------- the connection

/// Open the pipe, waiting out the moments when there is no free instance.
///
/// A named pipe serves one client per instance, and the daemon creates the next
/// one only after the last has been claimed. Opening two connections back to
/// back lands in that gap almost every time, and it reports as "all pipe
/// instances are busy" rather than as anything to do with timing. Retrying is
/// the documented answer; the wait is measured in microseconds in practice.
fn connect_with_retry(patience: Duration) -> Result<File> {
    let deadline = std::time::Instant::now() + patience;
    loop {
        match hmux::daemon::connect() {
            Ok(file) => return Ok(file),
            Err(e) if std::time::Instant::now() >= deadline => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

/// Open both halves and introduce them to each other.
///
/// Both are opened before either says hello. The other order is worse than it
/// looks: a hello registers the connection with the daemon, so failing to open
/// the second half after announcing the first leaves a client behind that owns
/// the token, and every retry is then refused for colliding with the wreck of
/// the attempt before it.
fn open_pair(patience: Duration) -> Result<(File, File)> {
    let mut events = connect_with_retry(patience)?;
    let mut requests = connect_with_retry(patience)?;

    // Unique per window, which is all it needs to be: it pairs two connections,
    // it does not authorise them.
    let token = format!("gui-{}", std::process::id());

    writeln!(
        events,
        "{}",
        serde_json::to_string(&Request::Hello {
            role: Role::Events,
            token: token.clone(),
        })?
    )?;
    events.flush().ok();

    writeln!(
        requests,
        "{}",
        serde_json::to_string(&Request::Hello {
            role: Role::Requests,
            token,
        })?
    )?;
    requests.flush().ok();

    Ok((requests, events))
}

/// Start the daemon that should have been running.
///
/// Detached on purpose: it must not die with this window, which is the entire
/// point of it. It lives beside this executable, because that is where the
/// installer puts both.
fn start_daemon() -> Result<()> {
    let exe = std::env::current_exe()
        .context("could not find our own path")?
        .parent()
        .ok_or_else(|| anyhow!("no directory to look in"))?
        .join("hmux-daemon.exe");

    if !exe.exists() {
        bail!("{} is missing", exe.display());
    }

    std::process::Command::new(&exe)
        .spawn()
        .with_context(|| format!("could not start {}", exe.display()))?;
    Ok(())
}

/// Turn the daemon's events into the ones the webview already listens for.
fn spawn_event_reader(events: File, shared: Arc<Shared>, app: AppHandle) {
    std::thread::Builder::new()
        .name("daemon-events".into())
        .spawn(move || {
            for line in BufReader::new(events).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Event>(&line) else {
                    continue;
                };

                match event {
                    Event::Output { id, seq, data } => {
                        let _ = app.emit("terminal-output", Chunk { id, data, seq });
                    }

                    Event::Exit { id } => {
                        let _ = app.emit("terminal-exit", id);
                    }

                    Event::Sessions { sessions } => {
                        if let Ok(mut infos) = shared.infos.lock() {
                            *infos = sessions.clone();
                        }
                        let _ = app.emit("terminals", sessions);
                    }

                    Event::Created { id } => {
                        if let Ok(mut w) = shared.waiting.lock() {
                            if let Some(tx) = w.created.pop() {
                                let _ = tx.send(id);
                            }
                        }
                    }

                    Event::Replay { id, data, seq } => {
                        if let Ok(mut w) = shared.waiting.lock() {
                            if let Some(list) = w.replays.remove(&id) {
                                for tx in list {
                                    let _ = tx.send(Backlog {
                                        text: data.clone(),
                                        last_seq: seq,
                                    });
                                }
                            }
                        }
                    }

                    Event::Error { message } => {
                        let _ = app.emit("daemon-error", message);
                    }
                }
            }

            // The daemon went away. Say so rather than leaving a window full of
            // terminals that quietly stopped being connected to anything.
            let _ = app.emit(
                "daemon-error",
                "lost the connection to the hmux daemon".to_string(),
            );
        })
        .expect("failed to start the daemon event reader");
}
