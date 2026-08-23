//! What a front end and the daemon say to each other.
//!
//! One JSON object per line, both directions. The obvious alternative is a
//! length-prefixed binary frame, which would be smaller; a line of JSON is
//! chosen because the whole point of the daemon is that it outlives everything
//! else, so the moment anything goes wrong the thing you want is to be able to
//! open the pipe by hand and read what it is saying. A format you can only
//! inspect with the tool that is broken is no help at that point.
//!
//! Terminal output crosses as a string rather than bytes. The pty gives bytes,
//! but a chunk can end in the middle of a character, so somebody has to hold
//! the tail and reassemble — and that somebody has to be the side that owns the
//! stream, or every client would have to solve it again. The daemon does it
//! once and what crosses the wire is always valid text.

use serde::{Deserialize, Serialize};

/// Identifies a terminal for as long as the daemon is alive. Not reused: a
/// client that reconnects with a stale id gets an error rather than somebody
/// else's shell.
pub type SessionId = u32;

/// The pipe both sides meet on.
///
/// Per user, because a named pipe is machine-wide and two people logged into
/// the same box must not land in each other's terminals. Windows already
/// restricts a pipe to the account that created it, so this is about not
/// colliding rather than about access.
pub fn pipe_name() -> String {
    format!(r"\\.\pipe\hmux-{}", pipe_user())
}

/// The name this used when the project was called `mux`.
///
/// A client tries this after the real one and before starting a daemon of its
/// own. The rename would otherwise have cost everybody every terminal they had
/// open: the daemon holding them is still running and still perfectly healthy,
/// and the only reason the new window could not see it is that the two halves
/// of the same program now disagree about where to meet.
///
/// Only worth keeping until nobody is running a daemon old enough to have
/// claimed it, which is however long it takes them to reboot.
pub fn legacy_pipe_name() -> String {
    format!(r"\\.\pipe\mux-{}", pipe_user())
}

fn pipe_user() -> String {
    std::env::var("USERNAME")
        .unwrap_or_else(|_| "default".into())
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Which direction a connection carries.
///
/// A client opens the pipe twice and uses each end one way only. This is not
/// tidiness: a named pipe opened without overlapped IO has a single file
/// object behind it, and duplicating the handle duplicates the handle, not the
/// object. A write attempted while a blocking read is in flight on the same
/// object fails outright — "the pipe is being closed" — which presents as the
/// daemon having gone away the first time a terminal produces output while the
/// client is waiting for a command. Splitting the directions means neither
/// connection is ever doing two things at once, and both ends stay blocking.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Client writes, daemon reads. The daemon never writes to this one.
    Requests,
    /// Daemon writes, client reads. The daemon never reads from this one, so a
    /// disconnect shows up as a failed write rather than as end of input.
    Events,
}

/// Asked of the daemon.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    /// The first line on every connection, naming its direction and which
    /// client it belongs to. The token pairs the two halves; it only has to be
    /// unique among connected clients, not unguessable, because the pipe is
    /// already restricted to this account.
    Hello { role: Role, token: String },
    /// What terminals exist. The first thing a front end asks, and the answer
    /// is what tells it whether this is a fresh start or a reattach.
    List,
    /// Start a shell. `replay` is text to seed the backlog with — how a
    /// restored session carries the previous run's output without the daemon
    /// needing to know anything about session files.
    Create {
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        replay: Option<String>,
    },
    /// Send everything from `from` onward, then keep sending.
    ///
    /// `from` is a sequence number rather than "everything": a client that
    /// dropped for a second wants the second it missed, not the whole backlog
    /// again. Zero means the lot.
    Attach { id: SessionId, from: u64 },
    /// Keystrokes.
    Input { id: SessionId, data: String },
    Resize { id: SessionId, cols: u16, rows: u16 },
    /// Kill the shell and forget the session. Distinct from a client going
    /// away, which leaves it running.
    Close { id: SessionId },
    /// The name shown in the rail, kept here so it survives the window.
    Rename { id: SessionId, name: Option<String> },
}

/// One terminal, as the daemon currently sees it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SessionInfo {
    pub id: SessionId,
    /// What the shell is called, from the program name.
    pub title: String,
    pub shell: String,
    /// What the user renamed it to, if anything.
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    /// Running a command that is actively producing output.
    pub busy: bool,
    /// The last chunk the daemon has. An attaching client asks from here to
    /// find out how far behind it is.
    pub seq: u64,
}

/// Sent by the daemon, either in answer to a request or because something
/// happened.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Sessions { sessions: Vec<SessionInfo> },
    Created { id: SessionId },
    /// The backlog from an attach, in one piece rather than as a flood of
    /// `Output` events, so a client can write it before it starts drawing.
    Replay {
        id: SessionId,
        data: String,
        seq: u64,
    },
    Output {
        id: SessionId,
        seq: u64,
        data: String,
    },
    Exit { id: SessionId },
    /// A request that could not be answered. Carries no id: a front end that
    /// asked about a session that has gone needs to re-list, not retry.
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire format is the contract with a front end that may be a
    /// different build, so the exact bytes are pinned rather than assumed.
    #[test]
    fn requests_parse_from_the_json_a_client_actually_sends() {
        let list: Request = serde_json::from_str(r#"{"cmd":"list"}"#).unwrap();
        assert!(matches!(list, Request::List));

        let attach: Request = serde_json::from_str(r#"{"cmd":"attach","id":3,"from":0}"#).unwrap();
        assert!(matches!(attach, Request::Attach { id: 3, from: 0 }));

        let create: Request = serde_json::from_str(
            r#"{"cmd":"create","shell":"powershell.exe","cwd":null,"cols":100,"rows":30,"replay":null}"#,
        )
        .unwrap();
        match create {
            Request::Create { shell, cols, .. } => {
                assert_eq!(shell.as_deref(), Some("powershell.exe"));
                assert_eq!(cols, 100);
            }
            other => panic!("parsed as {other:?}"),
        }
    }

    #[test]
    fn events_serialize_as_one_object_with_a_tag() {
        let line = serde_json::to_string(&Event::Exit { id: 7 }).unwrap();
        assert_eq!(line, r#"{"ev":"exit","id":7}"#);
        assert!(!line.contains('\n'), "a newline would split one event in two");
    }
}
