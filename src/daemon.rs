//! The process that owns the terminals, so closing a window does not end them.
//!
//! Everything else in hmux is a view. The shells themselves live here, in a
//! process with no window, and a front end attaches to them the way you attach
//! to a tmux session: it asks what exists, asks for the backlog, and then gets
//! the live stream. Close the window and nothing happens to the shells — the
//! daemon is still holding the pseudoconsoles, the compile is still compiling,
//! and opening a window again puts you back in front of it mid-command.
//!
//! What this does not do, because nothing can: survive the machine restarting.
//! A process cannot outlive the OS being shut down, so a reboot still falls
//! back to replaying the last session's text into fresh shells. The daemon
//! covers every case except that one.
//!
//! ## Why a named pipe, and why blocking
//!
//! A pipe rather than a socket on localhost because a pipe is already scoped
//! to the account that made it, so there is no port for anything else on the
//! machine to reach and no token to invent to keep them out.
//!
//! Blocking, one thread per client, rather than overlapped IO. There are only
//! ever a couple of clients, the threads are asleep in a read almost all of the
//! time, and the alternative is completion ports through the whole file. The
//! handle is turned into a [`File`] as soon as it is connected, which means the
//! rest of this reads as ordinary Rust IO rather than as Win32.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::FromRawHandle;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use vte::Parser;

use crate::activity::ProcessTable;
use crate::grid::Grid;
use crate::proto::{Event, Request, Role, SessionId, SessionInfo};
use crate::pty::PtyProcess;

/// How much of each terminal is kept for a client that attaches later.
///
/// This is the whole reason a reattach shows you what happened while no window
/// was open, so it is generous: the cost is memory in a process that is
/// otherwise idle, and the thing it buys is the difference between coming back
/// to your session and coming back to a prompt.
const BACKLOG_LIMIT: usize = 4 * 1024 * 1024;

/// See the identically named constant in the GUI: recent output is how "is it
/// working" is decided, and a repaint is not work.
const WORKING_WINDOW: Duration = Duration::from_millis(700);
const REPAINT_GRACE: Duration = Duration::from_millis(350);

/// How long the daemon stays up with nothing to hold.
///
/// It exists to outlive windows, not to be a permanent resident: once the last
/// terminal is gone and no front end is connected there is nothing to be the
/// custodian of. Long enough that closing the last window and opening a new one
/// does not pay for a restart.
const IDLE_EXIT: Duration = Duration::from_secs(120);

/// Say something, to the only place a process with no console can say it.
///
/// A daemon that fails silently is a daemon nobody can fix: when the terminals
/// are gone the question is always "did it start, and what did it think it was
/// doing", and there is no window to have printed it to. Appended rather than
/// truncated, and small enough to never need rotating because it only records
/// connections and failures, not traffic.
pub fn log(message: &str) {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let dir = std::path::Path::new(&appdata).join("hmux");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("daemon.log"))
    {
        let _ = writeln!(f, "{message}");
    }
}

/// One chunk of output, and where it falls in the stream.
struct Chunk {
    seq: u64,
    text: String,
}

/// Everything the daemon remembers about a terminal.
struct Session {
    id: SessionId,
    title: String,
    shell: String,
    name: Option<String>,
    cols: u16,
    rows: u16,
    proc: PtyProcess,
    /// Kept as chunks rather than one string so an attach from a sequence
    /// number can start exactly where the client left off instead of resending
    /// everything and making the client work out the overlap.
    backlog: VecDeque<Chunk>,
    backlog_bytes: usize,
    last_seq: u64,
    last_output: Instant,
    quiet_until: Instant,
    /// A terminal emulator the daemon keeps for one reason: programs ask the
    /// terminal questions — where is the cursor, what are you — and block until
    /// something answers. A front end answers them today because it is a
    /// terminal. The daemon has to be able to as well, because the whole point
    /// is that there are stretches with no front end attached, and a shell that
    /// asks into an empty room never gets its prompt back.
    ///
    /// Only the replies are used. Tracking the screen is what makes the replies
    /// truthful: a cursor position invented on the spot would put a full-screen
    /// program back together wrong.
    grid: Arc<Mutex<Grid>>,
}

impl Session {
    fn info(&self, table: &ProcessTable) -> SessionInfo {
        let working =
            self.last_output.elapsed() < WORKING_WINDOW && Instant::now() >= self.quiet_until;
        let activity = table.activity_of(self.proc.pid(), self.proc.is_alive(), working);
        SessionInfo {
            id: self.id,
            title: self.title.clone(),
            shell: self.shell.clone(),
            name: self.name.clone(),
            cwd: self
                .proc
                .pid()
                .and_then(crate::cwd::of_process)
                .map(|p| p.display().to_string()),
            cols: self.cols,
            rows: self.rows,
            alive: self.proc.is_alive(),
            busy: activity.is_busy(),
            seq: self.last_seq,
        }
    }

    fn push(&mut self, text: String) -> u64 {
        self.last_seq += 1;
        self.backlog_bytes += text.len();
        self.backlog.push_back(Chunk {
            seq: self.last_seq,
            text,
        });
        while self.backlog_bytes > BACKLOG_LIMIT {
            match self.backlog.pop_front() {
                Some(c) => self.backlog_bytes -= c.text.len(),
                None => break,
            }
        }
        self.last_seq
    }

    /// Everything after `from`, as one string.
    fn replay_from(&self, from: u64) -> String {
        let mut out = String::new();
        for c in self.backlog.iter().filter(|c| c.seq > from) {
            out.push_str(&c.text);
        }
        out
    }
}

/// A client is identified by the token its two connections share.
type ClientId = String;

/// A connected front end.
struct Client {
    tx: Sender<Event>,
    /// Taken by whichever connection turns up carrying [`Role::Events`].
    ///
    /// The pair can arrive in either order, and the channel exists from the
    /// moment either half does. A request answered before the events half has
    /// connected is not dropped: it waits in here until there is somewhere to
    /// send it.
    rx: Option<Receiver<Event>>,
    /// Which terminals it wants the live stream for. A client sees output only
    /// for what it asked for, so a second window watching one terminal is not
    /// paying for the other five.
    attached: Vec<SessionId>,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<SessionId, Session>,
    order: Vec<SessionId>,
    next_session: SessionId,
    clients: HashMap<ClientId, Client>,
    /// When the last client disconnected with nothing left to hold.
    empty_since: Option<Instant>,
}

impl Registry {
    fn infos(&self) -> Vec<SessionInfo> {
        let table = ProcessTable::capture();
        self.order
            .iter()
            .filter_map(|id| self.sessions.get(id))
            .map(|s| s.info(&table))
            .collect()
    }

    /// Send to every client watching `id`.
    fn broadcast(&self, id: SessionId, event: &Event) {
        for client in self.clients.values() {
            if client.attached.contains(&id) {
                let _ = client.tx.send(event.clone());
            }
        }
    }

    /// Send to every client, attached or not. Used for anything that changes
    /// the shape of the world rather than the contents of one terminal.
    fn broadcast_all(&self, event: &Event) {
        for client in self.clients.values() {
            let _ = client.tx.send(event.clone());
        }
    }
}

/// The daemon's shared state. Cheap to clone; everything is behind one lock.
#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<Mutex<Registry>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        // A poisoned lock here means a thread panicked holding it, and the
        // daemon holding every terminal in the account is not something to
        // abort over: the worst case is one session's state being odd.
        match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        }
    }

    /// Make sure a client exists for `token`, whichever half of it arrived.
    fn ensure_client(&self, token: &str) -> Sender<Event> {
        let mut reg = self.lock();
        reg.empty_since = None;
        if let Some(c) = reg.clients.get(token) {
            return c.tx.clone();
        }
        let (tx, rx) = channel::<Event>();
        reg.clients.insert(
            token.to_string(),
            Client {
                tx: tx.clone(),
                rx: Some(rx),
                attached: Vec::new(),
            },
        );
        tx
    }

    /// Claim the outbound half. `None` if some other connection already has it,
    /// which would mean two events connections for one token.
    fn take_receiver(&self, token: &str) -> Option<Receiver<Event>> {
        self.lock().clients.get_mut(token).and_then(|c| c.rx.take())
    }

    fn drop_client(&self, token: &str) {
        let mut reg = self.lock();
        reg.clients.remove(token);
        if reg.clients.is_empty() && reg.sessions.values().all(|s| !s.proc.is_alive()) {
            reg.empty_since = Some(Instant::now());
        }
    }

    /// Start a shell and begin draining it.
    fn create(
        &self,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        replay: Option<String>,
    ) -> Result<SessionId> {
        let shell = shell
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_program);
        let dir = cwd.filter(|c| !c.is_empty()).map(std::path::PathBuf::from);

        let (proc, reader) = PtyProcess::spawn_in(&shell, dir.as_deref(), cols, rows)?;
        log(&format!("spawned {shell} pid={:?}", proc.pid()));

        let title = std::path::Path::new(&shell)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| shell.clone());

        let id = {
            let mut reg = self.lock();
            reg.next_session += 1;
            let id = reg.next_session;

            let mut session = Session {
                id,
                title,
                shell: shell.clone(),
                name: None,
                cols,
                rows,
                proc,
                backlog: VecDeque::new(),
                backlog_bytes: 0,
                last_seq: 0,
                last_output: Instant::now(),
                // A shell printing its banner is not the terminal working.
                quiet_until: Instant::now() + REPAINT_GRACE,
                grid: Arc::new(Mutex::new(Grid::new(cols as usize, rows as usize))),
            };
            // Seeded before anything live, so a restored terminal's history sits
            // above its new prompt in the order it happened.
            if let Some(text) = replay.filter(|t| !t.is_empty()) {
                session.push(text);
            }
            reg.sessions.insert(id, session);
            reg.order.push(id);
            reg.empty_since = None;
            id
        };

        self.spawn_reader(id, reader);
        self.watch_exit(id);
        Ok(id)
    }

    /// Drain one pty into its backlog and out to whoever is watching.
    fn spawn_reader(&self, id: SessionId, mut reader: Box<dyn Read + Send>) {
        let hub = self.clone();
        let (alive, grid, replies) = {
            let reg = self.lock();
            match reg.sessions.get(&id) {
                Some(s) => (
                    s.proc.alive_handle(),
                    Arc::clone(&s.grid),
                    s.proc.reply_channel(),
                ),
                None => return,
            }
        };

        std::thread::Builder::new()
            .name(format!("session-{id}-reader"))
            .spawn(move || {
                let mut parser = Parser::new();
                let mut buf = [0u8; 8192];
                // A character can straddle a read; hold the tail rather than
                // emitting a replacement character mid-glyph.
                let mut carry: Vec<u8> = Vec::new();

                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    };

                    // Answered before anything else is done with the bytes: the
                    // child may be sitting waiting for this, and everything
                    // below is bookkeeping it is not waiting for.
                    //
                    // Always the daemon, never the front end, even though a
                    // front end is a terminal and could. Exactly one side may
                    // answer — a second reply is not a reply, it is typing, and
                    // it lands in the shell as `[24;1R` — and the daemon is the
                    // only side guaranteed to be there. The alternative, letting
                    // whoever is attached do it, means a shell asks into an
                    // empty room the moment the window closes and never gets
                    // its prompt back. A front end's own answers are filtered
                    // out on the way in; see the GUI's input handler.
                    let reply = {
                        let mut g = match grid.lock() {
                            Ok(g) => g,
                            Err(e) => e.into_inner(),
                        };
                        parser.advance(&mut *g, &buf[..n]);
                        g.take_reply()
                    };
                    if !reply.is_empty() {
                        if let Ok(mut w) = replies.lock() {
                            let _ = w.write_all(&reply);
                            let _ = w.flush();
                        }
                    }

                    carry.extend_from_slice(&buf[..n]);

                    let text = match std::str::from_utf8(&carry) {
                        Ok(s) => {
                            let owned = s.to_string();
                            carry.clear();
                            owned
                        }
                        Err(e) => {
                            let good = e.valid_up_to();
                            let owned = String::from_utf8_lossy(&carry[..good]).to_string();
                            carry.drain(..good);
                            // A genuinely invalid sequence would never drain;
                            // cap the carry so one bad byte cannot wedge it.
                            if carry.len() > 8 {
                                carry.clear();
                            }
                            owned
                        }
                    };
                    if text.is_empty() {
                        continue;
                    }

                    let mut reg = hub.lock();
                    let Some(session) = reg.sessions.get_mut(&id) else {
                        break;
                    };
                    let now = Instant::now();
                    if now >= session.quiet_until {
                        session.last_output = now;
                    }
                    let seq = session.push(text.clone());
                    reg.broadcast(id, &Event::Output { id, seq, data: text });
                }

                if alive.swap(false, Ordering::Relaxed) {
                    let reg = hub.lock();
                    reg.broadcast_all(&Event::Exit { id });
                }
            })
            .expect("failed to spawn a session reader");
    }

    fn watch_exit(&self, id: SessionId) {
        let hub = self.clone();
        let reg = self.lock();
        let Some(session) = reg.sessions.get(&id) else {
            return;
        };
        session.proc.watch_exit(move || {
            let reg = hub.lock();
            reg.broadcast_all(&Event::Exit { id });
        });
    }

    /// Answer one request. Anything worth saying back goes down `tx`.
    fn handle(&self, client: &str, req: Request, tx: &Sender<Event>) {
        match req {
            // Only ever the first line on a connection; the server deals with
            // it before this is reached.
            Request::Hello { .. } => {}

            Request::List => {
                let sessions = self.lock().infos();
                let _ = tx.send(Event::Sessions { sessions });
            }

            Request::Create {
                shell,
                cwd,
                cols,
                rows,
                replay,
            } => match self.create(shell, cwd, cols, rows, replay) {
                Ok(id) => {
                    // Created before attached, so the client is watching before
                    // the shell's first prompt can arrive.
                    if let Some(c) = self.lock().clients.get_mut(client) {
                        c.attached.push(id);
                    }
                    let _ = tx.send(Event::Created { id });
                }
                Err(e) => {
                    let _ = tx.send(Event::Error {
                        message: format!("{e:#}"),
                    });
                }
            },

            Request::Attach { id, from } => {
                let mut reg = self.lock();
                let Some(session) = reg.sessions.get(&id) else {
                    let _ = tx.send(Event::Error {
                        message: format!("no terminal {id}"),
                    });
                    return;
                };
                let data = session.replay_from(from);
                let seq = session.last_seq;
                if let Some(c) = reg.clients.get_mut(client) {
                    if !c.attached.contains(&id) {
                        c.attached.push(id);
                    }
                }
                let _ = tx.send(Event::Replay { id, data, seq });
            }

            Request::Input { id, data } => {
                let reg = self.lock();
                if let Some(s) = reg.sessions.get(&id) {
                    s.proc.write_input(data.as_bytes());
                }
            }

            Request::Resize { id, cols, rows } => {
                let mut reg = self.lock();
                if let Some(s) = reg.sessions.get_mut(&id) {
                    s.cols = cols;
                    s.rows = rows;
                    // Opened before the resize, so the repaint it provokes is
                    // already inside the window when its first byte lands.
                    s.quiet_until = Instant::now() + REPAINT_GRACE;
                    if let Ok(mut g) = s.grid.lock() {
                        g.resize(cols as usize, rows as usize);
                    }
                    s.proc.resize(cols, rows);
                }
            }

            Request::Close { id } => {
                let mut reg = self.lock();
                if let Some(s) = reg.sessions.remove(&id) {
                    s.proc.kill();
                }
                reg.order.retain(|&x| x != id);
                for c in reg.clients.values_mut() {
                    c.attached.retain(|&x| x != id);
                }
                if reg.clients.is_empty() && reg.sessions.is_empty() {
                    reg.empty_since = Some(Instant::now());
                }
                let sessions = reg.infos();
                reg.broadcast_all(&Event::Sessions { sessions });
            }

            Request::Rename { id, name } => {
                let mut reg = self.lock();
                if let Some(s) = reg.sessions.get_mut(&id) {
                    s.name = name;
                }
                let sessions = reg.infos();
                reg.broadcast_all(&Event::Sessions { sessions });
            }
        }
    }
}

/// The program to start when a client does not name one.
fn default_program() -> String {
    // Matches the GUI's own default; a shell the machine definitely has.
    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
}

// ------------------------------------------------------------------ the pipe

/// Serve until there is nothing left to serve.
pub fn run() -> Result<()> {
    let hub = Hub::new();
    let name = crate::proto::pipe_name();
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    log(&format!("--- daemon starting on {name} (pid {}) ---", std::process::id()));

    // The first instance claims the name. A second daemon fails here rather
    // than quietly running beside the first with its own set of terminals,
    // which would present as half your session having disappeared.
    let mut first = true;

    let idle = hub.clone();
    std::thread::Builder::new()
        .name("idle-watch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(10));
            let reg = idle.lock();
            if let Some(since) = reg.empty_since {
                if since.elapsed() > IDLE_EXIT && reg.clients.is_empty() {
                    std::process::exit(0);
                }
            }
        })
        .ok();

    loop {
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let err = std::io::Error::last_os_error();
            if first {
                bail!("another hmux daemon already owns {name}: {err}");
            }
            bail!("could not open {name}: {err}");
        }
        first = false;

        // Blocks until somebody opens the other end. Already-connected is a
        // success: a client can win the race between create and connect.
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
        if connected == 0 {
            let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
            if code != ERROR_PIPE_CONNECTED {
                unsafe { CloseHandle(handle) };
                continue;
            }
        }

        // From here it is an ordinary file with two ends, which is the point of
        // doing the handshake by hand: nothing below this line is Win32.
        // Handed to a thread immediately, so the loop is back to creating the
        // next instance in the time it takes to spawn one. A client opens two
        // connections in a row and the second lands in whatever gap there is
        // between a claimed instance and its replacement; the client retries
        // through it, and this keeps the gap to nothing worth measuring.
        let file = unsafe { File::from_raw_handle(handle as _) };
        let hub = hub.clone();
        std::thread::Builder::new()
            .name("client".into())
            .spawn(move || match serve_client(hub, file) {
                Ok(()) => log("client disconnected"),
                Err(e) => log(&format!("client ended: {e:#}")),
            })
            .ok();
    }
}

/// One connected front end, for as long as it stays connected.
fn serve_client(hub: Hub, file: File) -> Result<()> {
    // The opening line says which way this connection runs. It is read through
    // a BufReader on both roles; on an events connection nothing is ever read
    // after it, which is the whole point — see [`Role`].
    let mut reader = BufReader::new(file.try_clone().context("could not split the pipe")?);
    let mut opening = String::new();
    reader
        .read_line(&mut opening)
        .context("the client connected and said nothing")?;

    let (role, token) = match serde_json::from_str::<Request>(opening.trim()) {
        Ok(Request::Hello { role, token }) => (role, token),
        Ok(other) => bail!("opened with {} instead of hello", summarise(&other)),
        Err(e) => bail!("could not read the opening line: {e}"),
    };
    log(&format!("hello: {role:?} for {token}"));

    let tx = hub.ensure_client(&token);

    match role {
        Role::Events => {
            let Some(rx) = hub.take_receiver(&token) else {
                bail!("{token} already has an events connection");
            };
            // The reader goes, so this connection has exactly one thing
            // happening on it for the rest of its life.
            drop(reader);
            pump_events(file, rx);
            // Normally the requests half has already done this and the pump
            // ended because the last sender went. If this half died first, the
            // client is still registered and nothing else would clear it.
            hub.drop_client(&token);
            Ok(())
        }
        Role::Requests => {
            // The write half is never touched, so the blocking reads below
            // have the file object to themselves.
            drop(file);
            let result = read_requests(&hub, &token, &tx, reader);
            // The request side ending ends the client. Dropping the last
            // sender stops the pump, which closes the events half with it.
            hub.drop_client(&token);
            result
        }
    }
}

/// A request in one line, without its payload.
///
/// Keystrokes and terminal output never reach the log. What is useful when
/// something has gone wrong is the shape of the conversation, and recording
/// what somebody typed into their shell to get it would be a keylogger.
fn summarise(req: &Request) -> String {
    match req {
        Request::Hello { role, token } => format!("hello {role:?} {token}"),
        Request::List => "list".into(),
        Request::Create { shell, cols, rows, .. } => {
            format!("create {} {cols}x{rows}", shell.as_deref().unwrap_or("default"))
        }
        Request::Attach { id, from } => format!("attach {id} from {from}"),
        Request::Input { id, data } => format!("input {id} ({} bytes)", data.len()),
        Request::Resize { id, cols, rows } => format!("resize {id} {cols}x{rows}"),
        Request::Close { id } => format!("close {id}"),
        Request::Rename { id, .. } => format!("rename {id}"),
    }
}

fn read_requests(
    hub: &Hub,
    token: &str,
    tx: &Sender<Event>,
    reader: BufReader<File>,
) -> Result<()> {
    for line in reader.lines() {
        let line = line.context("the client went away mid-request")?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(req) => {
                log(&format!("<- {}", summarise(&req)));
                hub.handle(token, req, tx);
            }
            Err(e) => {
                log(&format!("unreadable request: {line}"));
                let _ = tx.send(Event::Error {
                    message: format!("could not read a request: {e}"),
                });
            }
        }
    }
    Ok(())
}

/// Write events to a client until there are none left to write.
///
/// Ends when every sender has gone, which happens when the matching requests
/// connection closes. That is the only shutdown signal it needs: this
/// connection is never read from, so it has no end of input of its own.
fn pump_events(mut out: File, rx: Receiver<Event>) {
    while let Ok(event) = rx.recv() {
        let Ok(mut line) = serde_json::to_string(&event) else {
            continue;
        };
        line.push('\n');
        if let Err(e) = out.write_all(line.as_bytes()) {
            log(&format!("events connection closed: {e}"));
            return;
        }
        let _ = out.flush();
    }
}

/// Open the daemon's pipe, or say why not.
///
/// Separate from the server so a front end can use it without pulling the
/// server in, and so the name is only written down once.
pub fn connect() -> Result<File> {
    let name = crate::proto::pipe_name();
    match open_pipe(&name) {
        Ok(file) => Ok(file),
        // Fall back to the name this used before the rename, so a daemon
        // started by the old build is still reachable and the terminals it is
        // holding survive the update. See `proto::legacy_pipe_name`.
        Err(e) => open_pipe(&crate::proto::legacy_pipe_name())
            .map_err(|_| anyhow!("no daemon on {name}: {e}")),
    }
}

fn open_pipe(name: &str) -> std::io::Result<File> {
    // Opened without any overlapped flag, so this side gets the same blocking
    // reads the server uses and the handle behaves as an ordinary file.
    std::fs::OpenOptions::new().read(true).write(true).open(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pipe_name_is_per_user_and_a_legal_pipe_path() {
        let name = crate::proto::pipe_name();
        assert!(name.starts_with(r"\\.\pipe\hmux-"));
        // A pipe path cannot contain a backslash past the prefix, and a
        // username can.
        assert!(!name[r"\\.\pipe\".len()..].contains('\\'));
    }

    #[test]
    fn a_backlog_replays_only_what_came_after_the_asked_for_point() {
        let mut backlog = VecDeque::new();
        for (seq, text) in [(1u64, "one"), (2, "two"), (3, "three")] {
            backlog.push_back(Chunk {
                seq,
                text: text.into(),
            });
        }
        let after: String = backlog
            .iter()
            .filter(|c| c.seq > 1)
            .map(|c| c.text.as_str())
            .collect();
        assert_eq!(after, "twothree");
    }

    #[test]
    fn the_backlog_drops_from_the_front_when_it_is_full() {
        // Standing in for a long-running session: what falls off is the oldest
        // output, never the newest, or a reattach would show a stale screen.
        let mut kept: VecDeque<Chunk> = VecDeque::new();
        let mut bytes = 0usize;
        for seq in 1..=10u64 {
            let text = "x".repeat(100);
            bytes += text.len();
            kept.push_back(Chunk { seq, text });
            while bytes > 500 {
                if let Some(c) = kept.pop_front() {
                    bytes -= c.text.len();
                }
            }
        }
        assert_eq!(kept.front().map(|c| c.seq), Some(6));
        assert_eq!(kept.back().map(|c| c.seq), Some(10));
    }
}
