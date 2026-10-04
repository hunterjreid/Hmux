//! Naming terminals from what is in them, by asking OpenAI.
//!
//! Through the `codex` CLI rather than `api.openai.com`. Codex is signed in to
//! a ChatGPT account, which bills the subscription and needs no platform key;
//! the API wants a key of its own and a key is one more thing to keep alive.
//! The cost is a process start, so every terminal goes in one prompt and one
//! run rather than one each.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

/// What the window sends for each terminal: its id, where it is, and the end
/// of its screen as plain text.
#[derive(serde::Deserialize)]
pub struct Screen {
    pub id: u32,
    pub cwd: Option<String>,
    pub text: String,
}

/// The newest model a ChatGPT login is allowed. The configured default in
/// `~/.codex/config.toml` may be one only an API key can reach, so this does
/// not lean on it.
const MODEL: &str = "gpt-5.6-sol";

/// Per terminal, so one with a huge scrollback cannot crowd out the rest.
const MAX_CHARS: usize = 2500;

fn prompt(screens: &[Screen]) -> String {
    let mut p = String::from(
        "Below are the ends of several terminal windows. Give each one a label for a narrow \
         sidebar: 1 to 3 words, at most 22 characters, sentence case, no quotes, no punctuation. \
         Name the exact thing it is about, the specific project plus the specific subject, \
         not a generic activity. No filler verbs like updating, working on, fixing, \
         deploying, reviewing, explaining. Good: \"Cryptoflip deploy\", \"Fable bg music\", \
         \"Kea held balance\", \"Omorfia Meta ads\", \"hmux tidy button\". Bad: \"Updating \
         Slipstream section labels\", \"Working on website\", \"PowerShell session\".\n\
         Reply with JSON only, nothing else: {\"names\":{\"<id>\":\"<label>\"}}\n",
    );
    for s in screens {
        let text = s.text.trim();
        let start = text.len().saturating_sub(MAX_CHARS);
        let start = (start..=text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(0);
        p.push_str(&format!(
            "\n--- terminal {} (folder {}) ---\n{}\n",
            s.id,
            s.cwd.as_deref().unwrap_or("unknown"),
            &text[start..]
        ));
    }
    p
}

/// Pull `{"names":{...}}` out of a reply, tolerating a code fence around it.
fn parse(reply: &str) -> Result<HashMap<u32, String>, String> {
    let from = reply.find('{').ok_or("the reply had no JSON in it")?;
    let to = reply.rfind('}').ok_or("the reply had no JSON in it")?;
    let value: serde_json::Value =
        serde_json::from_str(&reply[from..=to]).map_err(|e| format!("bad JSON: {e}"))?;
    let names = value
        .get("names")
        .and_then(|n| n.as_object())
        .ok_or("the reply had no names")?;
    Ok(names
        .iter()
        .filter_map(|(k, v)| {
            let id = k.trim().parse().ok()?;
            let name = v.as_str()?.trim().trim_matches('"').trim();
            (!name.is_empty()).then(|| (id, name.chars().take(28).collect()))
        })
        .collect())
}

fn run(screens: Vec<Screen>) -> Result<HashMap<u32, String>, String> {
    let dir = std::env::temp_dir().join("hmux-describe");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("reply-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&out);

    let mut cmd = Command::new("codex.cmd");
    cmd.args(["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-m", MODEL])
        .args(["-c", "model_reasoning_effort=\"low\"", "-o"])
        .arg(&out)
        .arg("-")
        // Somewhere empty, so the agent has no repository to go reading.
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Below normal, and inherited by the node process codex.cmd starts:
        // naming terminals is never worth a stutter in whatever else is running.
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start codex ({e}). Is the Codex CLI installed?"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin for codex")?
        .write_all(prompt(&screens).as_bytes())
        .map_err(|e| e.to_string())?;
    let done = child.wait_with_output().map_err(|e| e.to_string())?;

    let reply = std::fs::read_to_string(&out).unwrap_or_default();
    let _ = std::fs::remove_file(&out);
    if !done.status.success() || reply.trim().is_empty() {
        let err = String::from_utf8_lossy(&done.stderr);
        let line = err
            .lines()
            .filter(|l| l.contains("ERROR") && !l.contains("rmcp::"))
            .last()
            .unwrap_or("codex returned nothing");
        return Err(line.chars().take(300).collect());
    }
    parse(&reply)
}

#[tauri::command]
pub async fn describe_terminals(screens: Vec<Screen>) -> Result<HashMap<u32, String>, String> {
    if screens.is_empty() {
        return Ok(HashMap::new());
    }
    tauri::async_runtime::spawn_blocking(move || run(screens))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_fenced_reply() {
        let got = parse("```json\n{\"names\":{\"1\":\"Foamie dev server\",\"7\":\" \"}}\n```").unwrap();
        assert_eq!(got.get(&1).map(String::as_str), Some("Foamie dev server"));
        assert!(!got.contains_key(&7));
    }
}
