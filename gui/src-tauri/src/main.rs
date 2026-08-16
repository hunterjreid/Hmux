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
mod persist;
mod sessions;
mod shells;

use std::path::PathBuf;
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

/// What build this is, for comparing against the newest published release.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

// ---- window frame --------------------------------------------------------
//
// The window has no OS decorations, so moving it and the three buttons at the
// top right are the app's job. These are commands rather than the webview
// calling the window API directly because the chrome is a *child* webview:
// a command reaches the window it belongs to without depending on what the
// multiwebview build injects into it.

fn main_window(app: &tauri::AppHandle) -> Result<tauri::Window, String> {
    app.get_window("main")
        .ok_or_else(|| "the main window is gone".to_string())
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.minimize().map_err(|e| e.to_string())
}

/// Returns the state it ended up in, so the button can show the right icon
/// without asking a second time.
#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<bool, String> {
    let window = main_window(&app)?;
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!maximized)
}

#[tauri::command]
fn window_is_maximized(app: tauri::AppHandle) -> Result<bool, String> {
    main_window(&app)?.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_start_drag(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.start_dragging().map_err(|e| e.to_string())
}

// ---- session persistence -------------------------------------------------

/// Write the session out.
///
/// The UI supplies what only it knows — which terminals exist, their order,
/// what they were renamed to, and what each had beside it. Everything that
/// needs the OS is filled in here.
#[tauri::command]
fn save_layout(
    state: tauri::State<'_, Mutex<sessions::Sessions>>,
    mut layout: persist::Layout,
) -> Result<(), String> {
    {
        let sessions = state.lock().map_err(|e| e.to_string())?;
        for terminal in &mut layout.terminals {
            let Some(snapshot) = sessions.snapshot_of(terminal.id) else {
                continue;
            };
            terminal.shell = snapshot.shell;
            terminal.scrollback = persist::trim_scrollback(&snapshot.scrollback);
            // What the prompt says beats what the OS says: see
            // `persist::cwd_from_prompt` for why they disagree.
            terminal.cwd = persist::cwd_from_prompt(&terminal.scrollback)
                .map(|p| p.to_string_lossy().into_owned())
                .or(snapshot.cwd);
        }
    }

    // Terminals the UI listed but that are already gone would come back as a
    // shell with no history and no directory, which is worse than not coming
    // back at all.
    layout.terminals.retain(|t| !t.shell.is_empty());

    persist::save(&layout).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn load_layout() -> persist::Layout {
    persist::load()
}

/// Start a terminal from a saved one: same shell, same directory, with the old
/// session's output replayed above a rule.
#[tauri::command]
fn restore_terminal(
    state: tauri::State<'_, Mutex<sessions::Sessions>>,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    app: tauri::AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    scrollback: String,
    cols: u16,
    rows: u16,
) -> Result<SessionId, String> {
    let shell = shell
        .filter(|s| !s.is_empty())
        .unwrap_or_else(shells::default_program);
    let cwd = cwd.filter(|c| !c.is_empty()).map(PathBuf::from);

    let replay = if scrollback.is_empty() {
        String::new()
    } else {
        format!(
            "{scrollback}{}",
            persist::restored_marker(cwd.as_deref())
        )
    };

    let id = {
        let mut sessions = state.lock().map_err(|e| e.to_string())?;
        sessions
            .restore(&app, &shell, cwd, replay, cols, rows)
            .map_err(|e| format!("{e:#}"))?
    };

    assign_browser(&pool, id);
    Ok(id)
}

/// Claim one of the browsers built at startup.
///
/// Nothing is created here: making a webview once the event loop is running
/// wedges the main thread, and the command that did it would never return.
fn assign_browser(pool: &tauri::State<'_, Mutex<browser::Pool>>, id: SessionId) {
    if let Ok(mut pool) = pool.lock() {
        if pool.assign(id).is_none() {
            log_error(&format!(
                "terminal {id} gets no browser: all {} are in use",
                browser::POOL_SIZE
            ));
        }
    }
}

#[derive(Clone, Serialize)]
pub struct TerminalInfo {
    pub id: SessionId,
    pub title: String,
    /// "idle", "exited", the running command, or "<command> · waiting".
    pub status: String,
    /// Actively producing output right now.
    pub busy: bool,
    /// A command is open, whether or not it is doing anything.
    pub running: bool,
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
    // Defaults to the most colourful shell present, not cmd.exe.
    let shell = shell.unwrap_or_else(shells::default_program);

    let id = {
        let mut sessions = state.lock().map_err(|e| e.to_string())?;
        sessions
            .create(&app, &shell, cols, rows)
            .map_err(|e| format!("{e:#}"))?
    };

    assign_browser(&pool, id);
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

#[tauri::command]
fn list_shells() -> Vec<shells::Shell> {
    shells::available()
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
            list_shells,
            browser_layout,
            browser_navigate,
            browser_history,
            browser_url,
            ui_log,
            app_version,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            window_start_drag,
            save_layout,
            load_layout,
            restore_terminal,
        ])
        .setup(|app| {
            // No OS title bar: the app draws its own, which is what puts the
            // active terminal's name and the browser toggle up there instead
            // of a strip that only holds the window buttons. Resizing from the
            // edges still works — an undecorated window keeps its frame, it
            // just stops painting a caption.
            let window = WindowBuilder::new(app, "main")
                .title("mux")
                .decorations(false)
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
                                    || a.busy != b.busy
                                    || a.running != b.running
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
