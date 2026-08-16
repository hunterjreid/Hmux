//! Is this terminal doing something, or sitting at a prompt?
//!
//! The naive answer is "did it print recently", which is wrong in both
//! directions: a compile that has been silent for ten seconds reads as idle,
//! and a cursor blink reads as busy.
//!
//! The real question is whether the shell is currently running a command, and
//! on Windows that is directly observable — a shell sitting at its prompt has
//! no children, and a shell running `ping` has `ping.exe` as a child. So we
//! walk the process table and look.

use std::mem::size_of;

use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// What a terminal is currently doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Activity {
    /// Sitting at a prompt with no command running.
    Idle,
    /// Running something. Carries the name of the deepest descendant, which is
    /// the thing actually doing the work — `cargo` spawning `rustc` should read
    /// as `rustc`.
    Busy { command: String },
    /// The shell itself is gone.
    Dead,
}

impl Activity {
    pub fn label(&self) -> String {
        match self {
            Activity::Idle => "idle".into(),
            Activity::Busy { command } => command.clone(),
            Activity::Dead => "exited".into(),
        }
    }

    pub fn is_busy(&self) -> bool {
        matches!(self, Activity::Busy { .. })
    }
}

/// One (pid, parent pid, name) row of the process table.
struct Entry {
    pid: u32,
    parent: u32,
    name: String,
}

/// Snapshot every process on the machine.
///
/// Taken once per poll and shared across all panes — doing this per pane would
/// mean walking the whole table N times for the same data.
fn snapshot() -> Vec<Entry> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.push(Entry {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                });

                entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// Reusable process-table snapshot. Build one, then query it for every pane.
pub struct ProcessTable {
    entries: Vec<Entry>,
}

impl ProcessTable {
    pub fn capture() -> Self {
        ProcessTable {
            entries: snapshot(),
        }
    }

    /// Classify a shell by whether it has any descendants.
    pub fn activity_of(&self, shell_pid: Option<u32>, alive: bool) -> Activity {
        if !alive {
            return Activity::Dead;
        }
        let Some(pid) = shell_pid else {
            return Activity::Idle;
        };

        match self.deepest_descendant(pid) {
            Some(name) => Activity::Busy {
                command: strip_exe(&name),
            },
            None => Activity::Idle,
        }
    }

    /// Walk down the process tree, following the first child at each level.
    ///
    /// Depth-first to the bottom rather than just naming the direct child,
    /// because the direct child is often a wrapper — the interesting name is
    /// the leaf.
    fn deepest_descendant(&self, root: u32) -> Option<String> {
        let mut current = root;
        let mut found: Option<String> = None;
        // Bounded: a pathological or cyclic table must not spin forever.
        for _ in 0..16 {
            match self
                .entries
                .iter()
                .find(|e| e.parent == current && e.pid != current)
            {
                Some(child) => {
                    found = Some(child.name.clone());
                    current = child.pid;
                }
                // Stop at the leaf, keeping the deepest name found so far —
                // `?` here would throw away a perfectly good direct child.
                None => break,
            }
        }
        found
    }
}

fn strip_exe(name: &str) -> String {
    let base = if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
        &name[..name.len() - 4]
    } else {
        name
    };

    // Windows stores many system binaries in caps, so the table hands back
    // "PING.EXE". A badge reading "running PING" looks like shouting, and it
    // isn't what the user typed. Fold all-caps names down, but leave anything
    // with deliberate casing ("node", "Code") alone.
    let letters: Vec<char> = base.chars().filter(|c| c.is_alphabetic()).collect();
    if !letters.is_empty() && letters.iter().all(|c| c.is_uppercase()) {
        base.to_lowercase()
    } else {
        base.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_current_process_is_visible_in_the_table() {
        let table = ProcessTable::capture();
        let me = std::process::id();
        assert!(
            table.entries.iter().any(|e| e.pid == me),
            "process snapshot did not include this test process"
        );
    }

    #[test]
    fn a_dead_shell_is_dead_regardless_of_pid() {
        let table = ProcessTable::capture();
        assert_eq!(table.activity_of(Some(4), false), Activity::Dead);
        assert_eq!(table.activity_of(None, false), Activity::Dead);
    }

    #[test]
    fn a_childless_process_reads_as_idle() {
        let table = ProcessTable::capture();
        // A pid that cannot have children in the table.
        assert_eq!(table.activity_of(Some(u32::MAX), true), Activity::Idle);
    }

    #[test]
    fn a_process_with_a_child_reads_as_busy() {
        // Spawn a real child and confirm we notice it.
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 4 127.0.0.1 > NUL"])
            .spawn()
            .expect("failed to spawn a child process");

        let table = ProcessTable::capture();
        let activity = table.activity_of(Some(std::process::id()), true);

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            activity.is_busy(),
            "a process with a live child was reported as {activity:?}"
        );
    }

    #[test]
    fn exe_suffixes_are_stripped_for_display() {
        assert_eq!(strip_exe("ping.exe"), "ping");
        assert_eq!(strip_exe("node"), "node");
        assert_eq!(strip_exe("cargo.EXE"), "cargo");
    }

    #[test]
    fn shouty_system_binaries_are_folded_but_real_casing_is_kept() {
        // The process table really does report "PING.EXE".
        assert_eq!(strip_exe("PING.EXE"), "ping");
        assert_eq!(strip_exe("ROBOCOPY.EXE"), "robocopy");
        assert_eq!(strip_exe("Code.exe"), "Code");
        assert_eq!(strip_exe("node.exe"), "node");
    }
}
