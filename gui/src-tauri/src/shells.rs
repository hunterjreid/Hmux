//! Which shells this machine can actually offer.
//!
//! The default used to be `cmd.exe`, which made the app look like it had no
//! colour support at all. It does — `cmd.exe` simply never emits any. Its
//! banner, its prompt and `dir` are all monochrome, so a fresh terminal was a
//! wall of grey through no fault of the renderer.
//!
//! Order here is the preference order, and the first one present becomes the
//! default for new terminals.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct Shell {
    /// What the picker shows.
    pub name: String,
    /// What gets spawned.
    pub program: String,
}

/// Candidates in preference order: most colourful first.
const CANDIDATES: &[(&str, &str)] = &[
    ("PowerShell 7", "pwsh.exe"),
    ("Windows PowerShell", "powershell.exe"),
    ("WSL", "wsl.exe"),
    ("Command Prompt", "cmd.exe"),
];

/// Resolve an executable against `PATH`.
fn which(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(program))
        .find(|p| p.is_file())
}

/// Every shell present, best first. Never empty in practice — `cmd.exe` is
/// always there — but the caller should still cope with an empty list rather
/// than indexing into it.
pub fn available() -> Vec<Shell> {
    CANDIDATES
        .iter()
        .filter(|(_, program)| which(program).is_some())
        .map(|(name, program)| Shell {
            name: (*name).to_string(),
            program: (*program).to_string(),
        })
        .collect()
}

/// The shell a new terminal gets when nothing is chosen.
pub fn default_program() -> String {
    available()
        .first()
        .map(|s| s.program.clone())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_is_always_findable_on_windows() {
        assert!(which("cmd.exe").is_some(), "cmd.exe was not on PATH");
    }

    #[test]
    fn nonsense_resolves_to_nothing() {
        assert!(which("definitely-not-a-real-shell-9f3a.exe").is_none());
    }

    #[test]
    fn at_least_one_shell_is_offered_and_it_is_not_the_dullest() {
        let shells = available();
        assert!(!shells.is_empty(), "no shells found at all");

        // cmd.exe exists everywhere, so it should only be the default on a
        // machine with nothing better installed.
        let default = default_program();
        let has_powershell = shells.iter().any(|s| s.program.contains("powershell"));
        if has_powershell {
            assert_ne!(
                default, "cmd.exe",
                "PowerShell is installed but cmd.exe is still the default"
            );
        }
    }

    #[test]
    fn preference_order_is_preserved() {
        let shells = available();
        let names: Vec<&str> = shells.iter().map(|s| s.program.as_str()).collect();
        if let (Some(ps), Some(cmd)) = (
            names.iter().position(|p| *p == "powershell.exe"),
            names.iter().position(|p| *p == "cmd.exe"),
        ) {
            assert!(ps < cmd, "cmd.exe was offered before PowerShell");
        }
    }
}
