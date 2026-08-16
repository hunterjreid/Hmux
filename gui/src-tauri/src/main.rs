// Release builds must not pop a console window behind the GUI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! GUI front end: terminals down the left, the active one in the middle, and
//! that terminal's own browser on the right.
//!
//! The division of labour is deliberate. Rust owns the pseudoconsoles and the
//! process table — the things only the OS can answer. The webview owns the
//! pixels. Raw pty bytes are streamed to xterm.js rather than being interpreted
//! here, because xterm.js is already a better terminal emulator than the one
//! this project would maintain.
//!
//! The window holds several webviews: one for the chrome, and one browser per
//! terminal. An `<iframe>` cannot do the browser's job — `X-Frame-Options` and
//! CSP `frame-ancestors` mean most real sites refuse to load in one. See
//! [`browser`] for what that costs.

mod browser;
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

/// Where problems go.
///
/// A GUI has nowhere to print. Release builds have no console and no devtools,
/// so without this a failure is simply invisible — which is exactly how a
/// terminal that never appeared went undiagnosed.
pub fn log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("mux.log")
}

pub fn log_error(message: &str) {
    use std::io::Write;
    eprintln!("mux: {message}");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "{message}");
    }
}

/// Lets the webview put its own failures in the same log.
#[tauri::command]
fn ui_log(message: String) {
    log_error(&format!("ui: {message}"));
}

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
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    app: tauri::AppHandle,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SessionId, String> {
    let shell = shell.unwrap_or_else(|| "cmd.exe".to_string());

    let id = {
        let mut sessions = state.lock().map_err(|e| e.to_string())?;
        sessions
            .create(&app, &shell, cols, rows)
            .map_err(|e| format!("{e:#}"))?
    };

    // Claim one of the browsers built at startup. Nothing is created here:
    // making a webview once the event loop is running wedges the main thread,
    // and this command would never return.
    if let Ok(mut pool) = pool.lock() {
        if pool.assign(id).is_none() {
            log_error(&format!(
                "terminal {id} gets no browser: all {} are in use",
                browser::POOL_SIZE
            ));
        }
    }

    Ok(id)
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
    state
        .lock()
        .map_err(|e| e.to_string())?
        .resize(id, cols, rows);
    Ok(())
}

#[tauri::command]
fn close_terminal(
    state: tauri::State<'_, Mutex<Sessions>>,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    app: tauri::AppHandle,
    id: SessionId,
) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.close(id);

    // Hand the browser back to the pool, and send it home first so the next
    // terminal to claim this slot does not inherit the last one's page.
    if let Ok(mut pool) = pool.lock() {
        if let Some(slot) = pool.release(id) {
            if let (Some(webview), Some(home)) =
                (app.get_webview(&browser::slot_label(slot)), pool.home())
            {
                if let Ok(url) = home.parse::<tauri::Url>() {
                    let _ = webview.navigate(url);
                }
            }
        }
    }
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

/// Show `active`'s browser over the region the DOM reserved, and park the rest.
///
/// Called by the UI on every layout change: startup, terminal switch, window
/// resize, and while the splitter is dragged.
/// Reports whether the active terminal actually has a browser, so the UI can
/// say so rather than showing a dead panel.
#[tauri::command]
fn browser_layout(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    active: Option<SessionId>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    let slot = active.and_then(|id| pool.lock().ok().and_then(|p| p.slot_of(id)));
    browser::layout(&app, slot, x, y, width, height);
    Ok(slot.is_some())
}

/// Look up a terminal's browser, or explain why it hasn't got one.
fn webview_for(
    app: &tauri::AppHandle,
    pool: &tauri::State<'_, Mutex<browser::Pool>>,
    id: SessionId,
) -> Result<tauri::Webview, String> {
    let slot = pool
        .lock()
        .map_err(|e| e.to_string())?
        .slot_of(id)
        .ok_or_else(|| {
            format!(
                "terminal {id} has no browser (all {} are in use)",
                browser::POOL_SIZE
            )
        })?;
    app.get_webview(&browser::slot_label(slot))
        .ok_or_else(|| format!("browser {slot} is missing"))
}

#[tauri::command]
fn browser_navigate(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    id: SessionId,
    url: String,
) -> Result<String, String> {
    // An empty bar is not a request to go anywhere.
    let Some(full) = browser::normalise_url(&url) else {
        return Ok(String::new());
    };
    let webview = webview_for(&app, &pool, id)?;
    let parsed: tauri::Url = full.parse().map_err(|_| format!("not a URL: {url}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(full)
}

/// Back / forward / reload go through the page's own history API. Tauri does
/// not expose webview history directly, and `history.go` is what the buttons
/// mean anyway.
#[tauri::command]
fn browser_history(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    id: SessionId,
    action: String,
) -> Result<(), String> {
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown history action: {other}")),
    };
    let Ok(webview) = webview_for(&app, &pool, id) else {
        return Ok(());
    };
    webview.eval(script).map_err(|e| e.to_string())
}

/// The address to show in the bar. Empty for the new-tab page, whose real
/// address is an internal asset path nobody wants to look at.
#[tauri::command]
fn browser_url(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    id: SessionId,
) -> Result<String, String> {
    let Ok(webview) = webview_for(&app, &pool, id) else {
        return Ok(String::new());
    };
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let is_home = pool.lock().map(|p| p.is_home(&url)).unwrap_or(false);
    Ok(if is_home { String::new() } else { url })
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(Sessions::default()))
        .manage(Mutex::new(browser::Pool::default()))
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            terminal_backlog,
            list_terminals,
            browser_layout,
            browser_navigate,
            browser_history,
            browser_url,
            ui_log,
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

            // The chrome fills the window; browsers are layered over the region
            // it leaves empty for them.
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(logical.width, logical.height),
            )?;

            // Every browser is built here, before the event loop starts.
            // Creating one later blocks the main thread permanently, which
            // presents as commands silently never returning.
            browser::create_pool(&window)?;

            // Ask a browser what it actually loaded, so the new-tab page's
            // address is known rather than assumed.
            if let Some(first) = app.get_webview(&browser::slot_label(0)) {
                if let Ok(url) = first.url() {
                    if let Some(pool) = app.try_state::<Mutex<browser::Pool>>() {
                        if let Ok(mut pool) = pool.lock() {
                            pool.set_home(url.to_string());
                        }
                    }
                }
            }

            // Keep the chrome webview matched to the window. Browsers are
            // repositioned by the UI, which recomputes its own layout.
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
