//! What mux remembers between runs.
//!
//! The shells themselves do not survive quitting — panes outlive *switching*,
//! not the process exiting, and real detach needs a daemon that owns the ptys.
//! What can survive is everything around them: which terminals you had, what
//! you called them, the directory each was working in, how wide each one was,
//! and the text it was showing. Restoring that puts you back where you left
//! off rather than at a bare prompt, which is most of what "where I left off"
//! means in practice.
//!
//! The text is the terminal's own buffer, serialized by the UI — the screen as
//! it was drawn, not the pty stream that drew it. See `save_layout`.
//!
//! Written to `%APPDATA%\mux\session.json`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Scrollback kept per terminal, in bytes.
///
/// A backstop rather than the real limit: the UI serializes a fixed number of
/// lines, and this only catches the case where those lines are enormous. Set
/// well above what three thousand ordinary lines come to, because every byte
/// under it is a line you get back.
const SAVED_SCROLLBACK: usize = 1024 * 1024;

/// One terminal, as it was when the app last closed.
///
/// Every field is optional on the way in: a file written by an older build, or
/// half-written by a crash, should cost you the fields it lacks rather than
/// the whole session.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedTerminal {
    pub id: u32,
    /// What you renamed it to, if you did.
    pub name: Option<String>,
    pub shell: String,
    pub cwd: Option<String>,
    pub scrollback: String,
    /// The size the scrollback was drawn at. Serialized text is a grid, and a
    /// grid put back at a different width wraps in different places.
    pub cols: u16,
    pub rows: u16,
    pub browser_open: bool,
    pub url: String,
    /// Every page that was open beside this terminal, in strip order.
    ///
    /// Defaulted so a session written before tabs existed still loads: it comes
    /// back with no tabs and the single `url` above, which is exactly what it
    /// had.
    #[serde(default)]
    pub tabs: Vec<String>,
    /// Which of them was on top, as an index. Not an id: tab ids only mean
    /// anything to the window that handed them out.
    #[serde(default)]
    pub active_tab: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub active: Option<u32>,
    pub terminals: Vec<SavedTerminal>,
}

fn directory() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("mux")
}

pub fn path() -> PathBuf {
    directory().join("session.json")
}

/// Write the session out, replacing whatever was there.
///
/// Through a temporary file and a rename, because this runs on a timer: a save
/// interrupted half way would otherwise leave a truncated file that the next
/// launch cannot read, and losing the session is exactly the failure this
/// whole module exists to avoid.
pub fn save(layout: &Layout) -> Result<()> {
    let dir = directory();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("could not create {}", dir.display()))?;

    let json = serde_json::to_string(layout).context("could not encode the session")?;

    let final_path = path();
    let temp_path = final_path.with_extension("json.tmp");
    std::fs::write(&temp_path, json)
        .with_context(|| format!("could not write {}", temp_path.display()))?;
    std::fs::rename(&temp_path, &final_path)
        .with_context(|| format!("could not replace {}", final_path.display()))?;
    Ok(())
}

/// The last session, or an empty one if there isn't a readable file.
///
/// A corrupt file is not an error worth stopping the app for — there is
/// nothing the user could do about it, and starting fresh is the right
/// outcome either way.
pub fn load() -> Layout {
    let Ok(text) = std::fs::read_to_string(path()) else {
        return Layout::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Trim scrollback to what is worth persisting, keeping the end.
///
/// Cut at a line break rather than at the byte the limit lands on. The text is
/// full of escape sequences, and a cut through the middle of one leaves the
/// terminal reading the tail of it as characters to print — a line of stray
/// digits and brackets across the top of a restored session.
pub fn trim_scrollback(text: &str) -> String {
    if text.len() <= SAVED_SCROLLBACK {
        return text.to_string();
    }
    let mut start = text.len() - SAVED_SCROLLBACK;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    // The line the cut lands in is partial in both senses; drop it. Falls back
    // to the raw cut if the kept region is one enormous line with no break.
    let from = text[start..]
        .find('\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    text[from..].to_string()
}

/// The directory a shell's own prompt says it is in.
///
/// Preferred over the process's real working directory, because for the
/// default shell they disagree: Windows PowerShell's `Set-Location` moves its
/// provider location without ever calling `SetCurrentDirectory`, so the OS
/// still believes a 5.1 session is wherever it started. The prompt is what the
/// user is looking at, so it is the better answer when it can be read at all.
///
/// Only recognises the default `cmd` and PowerShell prompts. A customised
/// prompt falls through to the process directory, which is why that is kept.
pub fn cwd_from_prompt(scrollback: &str) -> Option<PathBuf> {
    // Only the tail matters, and stripping escapes over a full backlog on
    // every autosave would be real work for no gain.
    let mut start = scrollback.len().saturating_sub(8192);
    while start > 0 && !scrollback.is_char_boundary(start) {
        start -= 1;
    }

    let plain = strip_escapes(&scrollback[start..]);

    for line in plain.lines().rev().take(80) {
        let line = line.trim_end();
        let Some(body) = line.strip_suffix('>') else {
            continue;
        };
        // `PS C:\dir>` for PowerShell, `C:\dir>` for cmd.
        let body = body.strip_prefix("PS ").unwrap_or(body).trim();

        // A drive-qualified absolute path and nothing else. Anything with a
        // redirection or a pipe in it is a command, not a prompt.
        if body.len() < 3 || body.as_bytes()[1] != b':' {
            continue;
        }
        if body.contains(['<', '|', '"']) {
            continue;
        }

        let candidate = PathBuf::from(body);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// Remove the escape sequences from terminal output, leaving the text.
///
/// Not an emulator — it only has to be good enough to find a prompt in the
/// tail of a buffer.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then a byte in @ to ~ ends it.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: runs until BEL or ESC \.
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            // Character-set selection: one more byte.
            Some('(') | Some(')') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

/// What a restored terminal shows above its new prompt.
///
/// The old text is replayed, then this. Without a rule it is not obvious that
/// everything above is from a shell that is no longer running, and someone
/// scrolls up expecting to be able to interact with it.
///
/// Nothing here moves the cursor. The replay leaves it where the old session
/// had it — under the last prompt, which is where the next line belongs — and
/// anything that repositions first lands the new shell on top of the text that
/// was just restored. Switching screen buffers counts as repositioning: it
/// restores the cursor from before an alternate screen that was never entered,
/// which is the top of the terminal, and the new shell then overwrites the
/// session from the first line down.
pub fn restored_marker(cwd: Option<&Path>) -> String {
    let where_at = cwd
        .map(|p| format!(" · {}", p.display()))
        .unwrap_or_default();
    format!(
        "\x1b[0m\r\n\x1b[38;5;244m── restored{where_at} ── \
         above is the previous session\x1b[0m\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_are_removed_but_text_survives() {
        assert_eq!(strip_escapes("\x1b[32mhello\x1b[0m"), "hello");
        assert_eq!(strip_escapes("\x1b]0;a title\x07PS C:\\>"), "PS C:\\>");
        assert_eq!(strip_escapes("plain"), "plain");
    }

    #[test]
    fn a_powershell_prompt_gives_up_its_directory() {
        let dir = std::env::current_dir().unwrap();
        let text = format!("something\r\nPS {}> ", dir.display());
        assert_eq!(cwd_from_prompt(&text).as_deref(), Some(dir.as_path()));
    }

    #[test]
    fn a_cmd_prompt_gives_up_its_directory() {
        let dir = std::env::current_dir().unwrap();
        let text = format!("Microsoft Windows\r\n\r\n{}>", dir.display());
        assert_eq!(cwd_from_prompt(&text).as_deref(), Some(dir.as_path()));
    }

    #[test]
    fn the_latest_prompt_wins() {
        let dir = std::env::current_dir().unwrap();
        let parent = dir.parent().unwrap().to_path_buf();
        let text = format!("PS {}> cd ..\r\nPS {}> ", dir.display(), parent.display());
        assert_eq!(cwd_from_prompt(&text).as_deref(), Some(parent.as_path()));
    }

    #[test]
    fn output_that_merely_ends_in_an_angle_bracket_is_not_a_prompt() {
        assert!(cwd_from_prompt("echo hi > file.txt\r\n").is_none());
        assert!(cwd_from_prompt("<html>\r\n").is_none());
        assert!(cwd_from_prompt("PS Q:\\nowhere-at-all>").is_none());
    }

    #[test]
    fn trimming_keeps_the_end_and_stays_on_a_character_boundary() {
        let text = "é".repeat(SAVED_SCROLLBACK);
        let trimmed = trim_scrollback(&text);
        assert!(trimmed.len() <= SAVED_SCROLLBACK);
        assert!(text.ends_with(&trimmed));
        assert!(trimmed.chars().all(|c| c == 'é'));
    }

    #[test]
    fn trimming_cuts_at_a_line_break() {
        // Otherwise the cut lands inside an escape sequence and the rest of it
        // is printed as text at the top of the restored terminal.
        let text = format!("{}\n\x1b[31mred\x1b[0m\n", "x".repeat(SAVED_SCROLLBACK));
        let trimmed = trim_scrollback(&text);
        assert_eq!(trimmed, "\x1b[31mred\x1b[0m\n");
    }

    #[test]
    fn a_short_scrollback_is_kept_whole() {
        assert_eq!(trim_scrollback("short"), "short");
    }

    #[test]
    fn an_unreadable_session_file_reads_as_no_session() {
        // `load` must never propagate a parse failure: there is nothing the
        // user could do about it and starting fresh is the right outcome.
        let layout: Layout = serde_json::from_str("{ not json").unwrap_or_default();
        assert!(layout.terminals.is_empty());
    }

    #[test]
    fn a_session_survives_a_round_trip() {
        let layout = Layout {
            active: Some(2),
            terminals: vec![SavedTerminal {
                id: 2,
                name: Some("build".into()),
                shell: "pwsh.exe".into(),
                cwd: Some("C:\\work".into()),
                scrollback: "output".into(),
                cols: 120,
                rows: 40,
                browser_open: true,
                url: "https://example.com/".into(),
                tabs: vec![
                    "https://example.com/".into(),
                    "https://example.org/".into(),
                ],
                active_tab: 1,
            }],
        };
        let json = serde_json::to_string(&layout).unwrap();
        let back: Layout = serde_json::from_str(&json).unwrap();
        assert_eq!(back.active, Some(2));
        assert_eq!(back.terminals[0].name.as_deref(), Some("build"));
        assert_eq!(back.terminals[0].cwd.as_deref(), Some("C:\\work"));
        assert_eq!(back.terminals[0].cols, 120);
        assert_eq!(back.terminals[0].rows, 40);
        assert!(back.terminals[0].browser_open);
        // Every page that was open, and which of them was on top. Reopening a
        // window with one of several tabs is not reopening the session.
        assert_eq!(back.terminals[0].tabs.len(), 2);
        assert_eq!(back.terminals[0].tabs[1], "https://example.org/");
        assert_eq!(back.terminals[0].active_tab, 1);
    }

    #[test]
    fn a_file_missing_fields_still_loads() {
        let back: Layout = serde_json::from_str(r#"{"terminals":[{"id":1}]}"#).unwrap();
        assert_eq!(back.terminals.len(), 1);
        assert_eq!(back.terminals[0].name, None);
        assert!(back.terminals[0].shell.is_empty());
    }

    #[test]
    fn the_restored_marker_never_moves_the_cursor() {
        // The one that mattered was `?1049l`: leaving a screen buffer that was
        // never entered puts the cursor back at the top of the terminal, and
        // the restored session is then overwritten line by line by the shell
        // that just started.
        let marker = restored_marker(None);
        assert!(!marker.contains("1049"));
        assert!(!marker.contains("\x1b[H"));
        assert!(marker.contains("restored"));
    }
}
