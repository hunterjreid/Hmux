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
    /// A command is running. `working` separates "actively doing something"
    /// from "still open, but waiting on you".
    ///
    /// The process tree alone cannot tell those apart. A long-lived interactive
    /// program — Claude Code, a REPL, `top` — is a running child the entire
    /// time it is on screen, so the tree says "busy" even while it sits idle
    /// waiting for input. Output does distinguish them: something that is
    /// working emits text or animates, and something waiting for you goes
    /// quiet.
    Running { command: String, working: bool },
    /// The shell itself is gone.
    Dead,
}

impl Activity {
    pub fn label(&self) -> String {
        match self {
            Activity::Idle => "idle".into(),
            Activity::Running { command, working } => {
                if *working {
                    command.clone()
                } else {
                    format!("{command} · waiting")
                }
            }
            Activity::Dead => "exited".into(),
        }
    }

    /// Actively producing output — the thing worth pulsing a light for.
    pub fn is_busy(&self) -> bool {
        matches!(self, Activity::Running { working: true, .. })
    }

    /// A command is open, whether or not it is currently doing anything.
    pub fn is_running(&self) -> bool {
        matches!(self, Activity::Running { .. })
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

    /// Classify a shell: is anything running under it, and is that thing doing
    /// something right now?
    ///
    /// `producing_output` is the caller's judgement about recent activity on
    /// the pty; see [`Activity::Running`] for why the process tree cannot
    /// answer that part on its own.
    pub fn activity_of(
        &self,
        shell_pid: Option<u32>,
        alive: bool,
        producing_output: bool,
    ) -> Activity {
        if !alive {
            return Activity::Dead;
        }
        let Some(pid) = shell_pid else {
            return Activity::Idle;
        };

        match self.child_command(pid) {
            Some(name) => Activity::Running {
                command: strip_exe(&name),
                working: producing_output,
            },
            None => Activity::Idle,
        }
    }

    /// The command the shell itself launched.
    ///
    /// Deliberately the direct child rather than the deepest descendant. Going
    /// to the bottom of the tree reports whatever the command happens to be
    /// running *right now* — a terminal running Claude Code would announce
    /// "python" the moment it shelled out to a script, which is both confusing
    /// and unstable. The direct child is what you actually typed.
    ///
    /// Every console shell also has a conhost hanging off it, which is why
    /// plumbing is skipped rather than reported.
    fn child_command(&self, shell: u32) -> Option<String> {
        self.entries
            .iter()
            .filter(|e| e.parent == shell && e.pid != shell)
            .find(|e| !is_infrastructure(&e.name))
            .map(|e| e.name.clone())
    }
}

/// Console plumbing that Windows attaches to shells. Present in every process
/// tree, never what the user is actually running.
fn is_infrastructure(name: &str) -> bool {
    const PLUMBING: &[&str] = &["conhost.exe", "openconsole.exe"];
    let lower = name.to_ascii_lowercase();
    PLUMBING.contains(&lower.as_str())
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
        assert_eq!(table.activity_of(Some(4), false, true), Activity::Dead);
        assert_eq!(table.activity_of(None, false, false), Activity::Dead);
    }

    #[test]
    fn a_childless_process_reads_as_idle() {
        let table = ProcessTable::capture();
        // A pid that cannot have children in the table.
        assert_eq!(table.activity_of(Some(u32::MAX), true, true), Activity::Idle);
    }

    #[test]
    fn a_process_with_a_child_reads_as_running() {
        // Spawn a real child and confirm we notice it.
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 4 127.0.0.1 > NUL"])
            .spawn()
            .expect("failed to spawn a child process");

        let table = ProcessTable::capture();
        let activity = table.activity_of(Some(std::process::id()), true, true);

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            activity.is_running(),
            "a process with a live child was reported as {activity:?}"
        );
    }

    #[test]
    fn a_quiet_command_is_running_but_not_working() {
        // This is the Claude Code case: the program is open the whole time, so
        // the process tree always says "running". Only the absence of output
        // distinguishes waiting-for-you from doing-something.
        let table = ProcessTable {
            entries: vec![
                Entry { pid: 100, parent: 1, name: "powershell.exe".into() },
                Entry { pid: 101, parent: 100, name: "node.exe".into() },
            ],
        };

        let busy = table.activity_of(Some(100), true, true);
        assert!(busy.is_busy());
        assert_eq!(busy.label(), "node");

        let quiet = table.activity_of(Some(100), true, false);
        assert!(quiet.is_running(), "a quiet command is still running");
        assert!(!quiet.is_busy(), "a quiet command must not pulse as working");
        assert_eq!(quiet.label(), "node · waiting");
    }

    #[test]
    fn the_command_reported_is_what_the_shell_launched() {
        // Claude Code shelling out to python must not relabel the terminal as
        // "python" -- the direct child is the thing the user actually ran.
        let table = ProcessTable {
            entries: vec![
                Entry { pid: 100, parent: 1, name: "powershell.exe".into() },
                Entry { pid: 101, parent: 100, name: "node.exe".into() },
                Entry { pid: 102, parent: 101, name: "python.exe".into() },
            ],
        };
        assert_eq!(
            table.activity_of(Some(100), true, true),
            Activity::Running { command: "node".into(), working: true }
        );
    }

    #[test]
    fn exe_suffixes_are_stripped_for_display() {
        assert_eq!(strip_exe("ping.exe"), "ping");
        assert_eq!(strip_exe("node"), "node");
        assert_eq!(strip_exe("cargo.EXE"), "cargo");
    }

    #[test]
    fn console_plumbing_is_not_mistaken_for_a_command() {
        assert!(is_infrastructure("conhost.exe"));
        assert!(is_infrastructure("OpenConsole.exe"));
        assert!(is_infrastructure("CONHOST.EXE"));
        assert!(!is_infrastructure("node.exe"));
        assert!(!is_infrastructure("cargo.exe"));
    }

    #[test]
    fn a_shell_with_only_a_conhost_child_still_reads_as_idle() {
        // Every console shell has a conhost attached. Counting it as a running
        // command would make every terminal permanently busy.
        let table = ProcessTable {
            entries: vec![
                Entry { pid: 100, parent: 1, name: "powershell.exe".into() },
                Entry { pid: 101, parent: 100, name: "conhost.exe".into() },
            ],
        };
        assert_eq!(table.activity_of(Some(100), true, true), Activity::Idle);
    }

    #[test]
    fn a_real_command_is_preferred_over_plumbing() {
        let table = ProcessTable {
            entries: vec![
                Entry { pid: 100, parent: 1, name: "powershell.exe".into() },
                // conhost comes first, exactly as it does in the real table.
                Entry { pid: 101, parent: 100, name: "conhost.exe".into() },
                Entry { pid: 102, parent: 100, name: "node.exe".into() },
            ],
        };
        assert_eq!(
            table.activity_of(Some(100), true, true),
            Activity::Running { command: "node".into(), working: true }
        );
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
