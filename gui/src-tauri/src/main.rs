// Release builds must not pop a console window behind the GUI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! GUI front end: terminals down the left, the active one in the middle, a real
//! browser on the right.
//!
//! The division of labour is deliberate. Rust owns the pseudoconsoles and the
//! process table — the things only the OS can answer. The webview owns the
//! pixels. Raw pty bytes are streamed to xterm.js rather than being interpreted
//! here, because xterm.js is already a better terminal emulator than the one
//! this project would maintain.
//!
//! The window holds *two* webviews, not one. The chrome (sidebar, terminal,
//! browser toolbar) lives in the `ui` webview; the browser panel is a second,
//! genuinely separate `browser` webview. An `<iframe>` cannot do this job —
//! `X-Frame-Options` and CSP `frame-ancestors` mean most real sites simply
//! refuse to load in one.
//!
//! The cost of that choice is that the browser webview is a native child
//! surface: it does not flow with the DOM, so its rectangle has to be pushed
//! over from JavaScript whenever the layout moves.

mod sessions;

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    webview::WebviewBuilder, window::WindowBuilder, Emitter, LogicalPosition, LogicalSize, Manager,
    WebviewUrl,
};

use sessions::{SessionId, Sessions};

/// How often the process table is walked to refresh idle/busy badges. Fast
/// enough to feel live, slow enough that it's invisible on a CPU graph.
const ACTIVITY_POLL: Duration = Duration::from_millis(400);

const HOME_PAGE: &str = "https://duckduckgo.com";

#[derive(Clone, Serialize)]
pub struct TerminalInfo {
    pub id: SessionId,
    pub title: String,
    /// "idle", "exited", or the name of the running command.
    pub status: String,
    pub busy: bool,
    pub alive: bool,
}

// ---- terminal commands ---------------------------------------------------

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, Mutex<Sessions>>,
    app: tauri::AppHandle,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SessionId, String> {
    let shell = shell.unwrap_or_else(|| "cmd.exe".to_string());
    let mut sessions = state.lock().map_err(|e| e.to_string())?;
    sessions
        .create(&app, &shell, cols, rows)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, Mutex<Sessions>>,
    id: SessionId,
    data: String,
) -> Result<(), String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .write(id, data.as_bytes());
    Ok(())
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, Mutex<Sessions>>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.resize(id, cols, rows);
    Ok(())
}

#[tauri::command]
fn close_terminal(state: tauri::State<'_, Mutex<Sessions>>, id: SessionId) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.close(id);
    Ok(())
}

/// Everything a terminal has produced so far, plus the sequence number that
/// replay reaches — the caller uses it to drop live chunks already included.
#[tauri::command]
fn terminal_backlog(
    state: tauri::State<'_, Mutex<Sessions>>,
    id: SessionId,
) -> Result<sessions::Backlog, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.backlog(id))
}

#[tauri::command]
fn list_terminals(state: tauri::State<'_, Mutex<Sessions>>) -> Result<Vec<TerminalInfo>, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.info())
}

// ---- browser panel commands ----------------------------------------------

/// Position the browser webview over the region the DOM has reserved for it.
///
/// Called by the UI on every layout change: startup, window resize, and while
/// the splitter is being dragged.
#[tauri::command]
fn browser_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(browser) = app.get_webview("browser") else {
        return Ok(());
    };
    // A zero or negative size is a collapsed panel; parking it off-screen is
    // how you hide a native child surface, since it has no CSS to obey.
    if width < 1.0 || height < 1.0 {
        let _ = browser.set_position(LogicalPosition::new(-10_000.0, 0.0));
        return Ok(());
    }
    browser
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    browser
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let Some(browser) = app.get_webview("browser") else {
        return Err("browser webview is not available".into());
    };
    let full = normalise_url(&url);
    let parsed: tauri::Url = full.parse().map_err(|_| format!("not a URL: {url}"))?;
    browser.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(full)
}

/// Back / forward / reload go through the page's own history API. Tauri does
/// not expose webview history directly, and `history.go` is what the buttons
/// mean anyway.
#[tauri::command]
fn browser_history(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let Some(browser) = app.get_webview("browser") else {
        return Ok(());
    };
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown history action: {other}")),
    };
    browser.eval(script).map_err(|e| e.to_string())
}

#[tauri::command]
fn browser_url(app: tauri::AppHandle) -> Result<String, String> {
    let Some(browser) = app.get_webview("browser") else {
        return Ok(String::new());
    };
    Ok(browser.url().map(|u| u.to_string()).unwrap_or_default())
}

/// Accept what people actually type: bare hosts become https, anything with
/// spaces or no dot becomes a search.
fn normalise_url(input: &str) -> String {
    let t = input.trim();
    if t.is_empty() {
        return HOME_PAGE.to_string();
    }
    if t.starts_with("http://") || t.starts_with("https://") || t.starts_with("about:") {
        return t.to_string();
    }
    let looks_like_host = !t.contains(' ') && t.contains('.');
    if looks_like_host {
        format!("https://{t}")
    } else {
        format!(
            "https://duckduckgo.com/?q={}",
            urlencode(t)
        )
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(Sessions::default()))
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            terminal_backlog,
            list_terminals,
            browser_bounds,
            browser_navigate,
            browser_history,
            browser_url,
        ])
        .setup(|app| {
            let window = WindowBuilder::new(app, "main")
                .title("mux")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 520.0)
                .build()?;

            let size = window.inner_size()?;
            let scale = window.scale_factor()?;
            let logical = size.to_logical::<f64>(scale);

            // The chrome fills the window; the browser is layered over the
            // region the chrome leaves empty for it.
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(logical.width, logical.height),
            )?;

            window.add_child(
                WebviewBuilder::new(
                    "browser",
                    WebviewUrl::External(HOME_PAGE.parse().expect("valid home page")),
                ),
                // Parked off-screen until the UI reports where it belongs.
                LogicalPosition::new(-10_000.0, 0.0),
                LogicalSize::new(600.0, 600.0),
            )?;

            // Keep the chrome webview matched to the window. The browser panel
            // is repositioned by the UI, which recomputes its own layout.
            let resize_handle = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(new_size) = event {
                    let Ok(scale) = resize_handle.scale_factor() else {
                        return;
                    };
                    let logical = new_size.to_logical::<f64>(scale);
                    if let Some(ui) = resize_handle.get_webview("ui") {
                        let _ = ui.set_size(LogicalSize::new(logical.width, logical.height));
                    }
                }
            });

            // Poll the process table centrally and push badge updates rather
            // than having the UI ask. One walk covers every terminal.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("activity-poll".into())
                .spawn(move || {
                    let mut previous: Vec<TerminalInfo> = Vec::new();
                    loop {
                        std::thread::sleep(ACTIVITY_POLL);

                        let Some(state) = handle.try_state::<Mutex<Sessions>>() else {
                            continue;
                        };
                        let current = match state.lock() {
                            Ok(s) => s.info(),
                            Err(_) => continue,
                        };

                        // Only wake the UI when something actually changed.
                        let changed = current.len() != previous.len()
                            || current.iter().zip(&previous).any(|(a, b)| {
                                a.id != b.id
                                    || a.status != b.status
                                    || a.title != b.title
                                    || a.alive != b.alive
                            });

                        if changed {
                            let _ = handle.emit("terminals", &current);
                            previous = current;
                        }
                    }
                })
                .expect("failed to start the activity poller");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running mux");
}

#[cfg(test)]
mod tests {
    use super::normalise_url;

    #[test]
    fn bare_hosts_get_https() {
        assert_eq!(normalise_url("example.com"), "https://example.com");
        assert_eq!(normalise_url("  news.ycombinator.com "), "https://news.ycombinator.com");
    }

    #[test]
    fn explicit_schemes_are_left_alone() {
        assert_eq!(normalise_url("http://a.test/x"), "http://a.test/x");
        assert_eq!(normalise_url("https://a.test"), "https://a.test");
    }

    #[test]
    fn prose_becomes_a_search() {
        assert_eq!(
            normalise_url("rust conpty"),
            "https://duckduckgo.com/?q=rust+conpty"
        );
        // No dot, so it cannot be a host.
        assert!(normalise_url("localhost").starts_with("https://duckduckgo.com/?q="));
    }
}
