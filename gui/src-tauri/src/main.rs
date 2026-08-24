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
mod update;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    webview::WebviewBuilder, window::WindowBuilder, LogicalPosition, LogicalSize, Manager,
    WebviewUrl,
};

use hmux::proto::SessionInfo;
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
    std::env::temp_dir().join("hmux.log")
}

pub fn log_error(message: &str) {
    use std::io::Write;
    eprintln!("hmux: {message}");
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

/// Open a link in the machine's own browser, outside this window.
///
/// Almost nothing here should do this — a link clicked in a terminal belongs in
/// that terminal's own panel, which is the whole argument for having a browser
/// per terminal. The exceptions are the ones that are not about what you are
/// working on: the project's own pages, reached from the menu. Those are not
/// something you want taking over the panel beside a shell you are in the
/// middle of using.
///
/// `rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`, which
/// treats a quoted first argument as a window title and mangles URLs
/// containing `&`.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // Only the web. This hands a string to the shell's protocol handlers, and
    // the set of schemes Windows will act on includes several that run things.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http and https links open outside the app".into());
    }

    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// Who is running this, for the foot of the profile menu.
///
/// The Windows account, because that is the only identity hmux has. There is
/// nothing to sign in to and nothing kept on a server, so a menu of the usual
/// shape would be offering to log out of somewhere you were never logged in.
/// The account name is the honest version of the same row.
#[tauri::command]
fn account_name() -> String {
    std::env::var("USERNAME")
        .ok()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "this machine".to_string())
}

// ---- window frame --------------------------------------------------------
//
// The window has no OS decorations, so moving it and the three buttons at the
// top right are the app's job. These are commands rather than the webview
// calling the window API directly because the chrome is a *child* webview:
// a command reaches the window it belongs to without depending on what the
// multiwebview build injects into it.

/// Match the chrome webview to the window it is inside.
///
/// The window is asked how big it is rather than the event being believed:
/// maximising fires several resize events in a burst and they do not all carry
/// the size the window ended up at.
fn sync_ui_size(window: &tauri::Window) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    if let Some(ui) = window.get_webview("ui") {
        let _ = ui.set_size(LogicalSize::new(logical.width, logical.height));
    }
}

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

/// F11. Returns the state it ended up in.
///
/// Fullscreen is not a bigger maximise: it takes the taskbar as well, and this
/// window has no OS caption to lose, so what it actually buys is the strip at
/// the bottom of the screen and nothing else being able to sit on top. Worth a
/// key because the alternative is dragging the window and hiding the taskbar
/// by hand.
///
/// The app's own title bar stays. It carries the only close button there is,
/// and a fullscreen window with no way out but a keystroke you might not know
/// is a window people force-quit.
/// Whether the window was maximised when fullscreen was entered, so leaving
/// fullscreen puts it back rather than dropping it to some restored size the
/// user last saw an hour ago.
static WAS_MAXIMIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    use std::sync::atomic::Ordering;

    let window = main_window(&app)?;
    let full = window.is_fullscreen().map_err(|e| e.to_string())?;

    if full {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        if WAS_MAXIMIZED.swap(false, Ordering::Relaxed) {
            window.maximize().map_err(|e| e.to_string())?;
        }
        return Ok(false);
    }

    // Drop out of maximised before going fullscreen.
    //
    // Fullscreen from a maximised window is the case that did not work. The
    // window is already the size of the work area, and Windows keeps the
    // maximised state while making it the size of the screen, which does not
    // reliably produce the resize the webview follows. So the page stayed at
    // the work area's height and left the taskbar's worth of black along the
    // bottom, but only when you were maximised first, which is why it looked
    // fixed and then did not.
    //
    // Restoring first makes it an ordinary window growing to fullscreen, which
    // is the path that works. What it costs is one frame at the restored size.
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    WAS_MAXIMIZED.store(maximized, Ordering::Relaxed);
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    }
    window.set_fullscreen(true).map_err(|e| e.to_string())?;

    Ok(true)
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
    let window = main_window(&app)?;

    // A fullscreen window does not move, and Windows agrees only about half the
    // time: `start_dragging` on one either does nothing or tears it off the
    // screen into a floating window the size of the display, which is not a
    // state anybody asked for and takes a second F11 to get out of. Refusing is
    // the whole fix, and it is done here rather than in the UI because the
    // window can enter fullscreen without the page being the one that asked.
    if window.is_fullscreen().map_err(|e| e.to_string())? {
        return Ok(());
    }

    window.start_dragging().map_err(|e| e.to_string())
}

// ---- session persistence -------------------------------------------------

/// Write the session out.
///
/// The UI supplies what only it knows — which terminals exist, their order,
/// what they were renamed to, what each had beside it, and the text each one
/// was showing. Everything that needs the OS is filled in here.
///
/// The text has to come from the UI: what this side holds is the pty stream,
/// and that is a set of drawing instructions rather than a picture. Only the
/// terminal that drew it knows what it ended up looking like.
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
            // The raw stream only stands in when the UI could not serialize —
            // a garbled restore still beats an empty one.
            if terminal.scrollback.is_empty() {
                terminal.scrollback = snapshot.scrollback;
            }
            terminal.scrollback = persist::trim_scrollback(&terminal.scrollback);
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

/// The picture behind the terminal, if one has been chosen.
#[tauri::command]
fn get_background() -> Option<String> {
    persist::load_background()
}

/// Set it, or clear it by passing nothing.
#[tauri::command]
fn set_background(data: Option<String>) -> Result<(), String> {
    persist::save_background(data.as_deref()).map_err(|e| format!("{e:#}"))
}

/// Start a terminal from a saved one: same shell, same directory, with the old
/// session's output replayed above a rule.
#[tauri::command]
fn restore_terminal(
    state: tauri::State<'_, Mutex<sessions::Sessions>>,
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

    let pending = {
        let mut sessions = state.lock().map_err(|e| e.to_string())?;
        sessions
            .restore(&app, &shell, cwd, replay, cols, rows)
            .map_err(|e| format!("{e:#}"))?
    };
    Sessions::await_created(pending).map_err(|e| format!("{e:#}"))
}

// Browsers are claimed by tabs, not by terminals. A terminal starting is no
// longer a reason to take one: it might end up with four pages open beside it
// or none at all, and which of those it is is the UI's to decide. See
// `browser_claim`.

// What the rail shows about a terminal is the daemon's own `SessionInfo`,
// passed through untouched. There was a type here that restated it; the rail
// reads four of its fields and the daemon already sends all four, so the
// translation was a place for the two to disagree and nothing else.

// ---- terminal commands ---------------------------------------------------

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, Mutex<Sessions>>,
    app: tauri::AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SessionId, String> {
    // Defaults to the most colourful shell present, not cmd.exe.
    let shell = shell.unwrap_or_else(shells::default_program);

    // None means the shell's own default. Deliberately not checked for
    // existence here: the daemon is the one that has to start a process in it
    // and is the only side that can fail honestly, and a directory that exists
    // now can be gone by the time it is used anyway.
    let cwd = cwd.filter(|c| !c.is_empty()).map(PathBuf::from);

    // The lock is held only long enough to send the request. Waiting for the
    // answer with it still held is what made the window stop responding.
    let pending = {
        let mut sessions = state.lock().map_err(|e| e.to_string())?;
        sessions
            .create(&app, &shell, cwd, cols, rows)
            .map_err(|e| format!("{e:#}"))?
    };
    Sessions::await_created(pending)
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
    state
        .lock()
        .map_err(|e| e.to_string())?
        .resize(id, cols, rows);
    Ok(())
}

#[tauri::command]
fn close_terminal(
    state: tauri::State<'_, Mutex<Sessions>>,
    id: SessionId,
) -> Result<(), String> {
    // The browsers this terminal's tabs were holding are released by the UI,
    // which is the only side that knows which tabs those were.
    state.lock().map_err(|e| e.to_string())?.close(id);
    Ok(())
}

/// Everything a terminal has produced so far, plus the sequence number that
/// replay reaches — the caller uses it to drop live chunks already included.
///
/// Also what subscribes this window to the terminal's live output, which is why
/// it is asked for even when the window already knows it has nothing.
#[tauri::command]
fn terminal_backlog(
    state: tauri::State<'_, Mutex<Sessions>>,
    id: SessionId,
) -> Result<sessions::Backlog, String> {
    // Send under the lock, wait without it. Holding the mutex across a
    // fifteen second wait blocked every other command that needs sessions,
    // which is most of them, and the window went Not Responding for as long as
    // one terminal took to answer.
    let pending = {
        let sessions = state.lock().map_err(|e| e.to_string())?;
        sessions.attach(id).map_err(|e| format!("{e:#}"))?
    };
    Sessions::await_backlog(id, pending).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn list_terminals(state: tauri::State<'_, Mutex<Sessions>>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.info())
}

#[tauri::command]
fn list_shells() -> Vec<shells::Shell> {
    shells::available()
}

// ---- clipboard -----------------------------------------------------------
//
// Not `navigator.clipboard`. That refuses whenever the calling document is not
// focused, and this window is several webviews — a right click lands on one of
// them and the refusal is asynchronous and silent, which reads as the paste
// doing nothing at all. See `hmux::clipboard`.

#[tauri::command]
fn clipboard_read() -> Result<String, String> {
    hmux::clipboard::read_text().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    hmux::clipboard::write_text(&text).map_err(|e| format!("{e:#}"))
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
    active: Option<browser::TabId>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    force: Option<bool>,
) -> Result<bool, String> {
    let mut pool = pool.lock().map_err(|e| e.to_string())?;
    // Set by the caller for the rare events — changing tab, changing terminal,
    // opening the panel — where being right matters more than being cheap.
    // The skip exists for the constant stream of identical layouts during a
    // slide or a resize; trusting it when the user has actually changed what
    // they are looking at is how a page ends up loaded but never placed, which
    // reads as a panel that simply never filled in.
    if force.unwrap_or(false) {
        pool.forget_placement();
    }
    let slot = active.and_then(|tab| pool.slot_of(tab));
    pool.layout(&app, slot, x, y, width, height);
    Ok(slot.is_some())
}

/// Claim a browser for a tab. Idempotent: asking twice gives the same one.
/// How many pages can be open at once. Asked for rather than repeated, because
/// the copy of this number that lived in the UI said twelve for a while after
/// the pool was doubled, and the only place it showed up was the message
/// telling you why you could not open another one.
#[tauri::command]
fn browser_pool_size() -> usize {
    browser::POOL_SIZE
}

/// Whether every browser in the pool has actually been created.
///
/// They are all asked for during `setup`, which returns before the last of
/// them exists: the webviews appear in the app's registry as they come up, and
/// with twenty-four of them the tail takes long enough that a session restore
/// beats it there. The symptom was `browser 12 is missing` and upwards, one
/// per page that had been given a slot at the far end of a pool that was not
/// finished being built. It could not happen when the pool was twelve, which
/// is why doubling it introduced it.
#[tauri::command]
fn browser_pool_ready(app: tauri::AppHandle) -> bool {
    (0..browser::POOL_SIZE).all(|slot| app.get_webview(&browser::slot_label(slot)).is_some())
}

#[tauri::command]
fn browser_claim(
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    tab: browser::TabId,
) -> Result<bool, String> {
    let mut pool = pool.lock().map_err(|e| e.to_string())?;
    let got = pool.assign(tab).is_some();
    // A slot changing hands means the next layout must actually place it, even
    // if the rectangle is identical to the one the previous tab was using.
    pool.forget_placement();
    Ok(got)
}

/// Hand a tab's browser back, and send it home so the next tab to claim that
/// slot does not open on the last one's page.
#[tauri::command]
fn browser_release(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    tab: browser::TabId,
) -> Result<(), String> {
    let mut pool = pool.lock().map_err(|e| e.to_string())?;
    pool.forget_placement();
    if let Some(slot) = pool.release(tab) {
        if let (Some(webview), Some(home)) =
            (app.get_webview(&browser::slot_label(slot)), pool.home())
        {
            if let Ok(url) = home.parse::<tauri::Url>() {
                let _ = webview.navigate(url);
            }
        }
    }
    Ok(())
}

/// Look up a tab's browser, or explain why it hasn't got one.
fn webview_for(
    app: &tauri::AppHandle,
    pool: &tauri::State<'_, Mutex<browser::Pool>>,
    tab: browser::TabId,
) -> Result<tauri::Webview, String> {
    let pool = pool.lock().map_err(|e| e.to_string())?;
    // Blaming the pool was wrong whenever it was not actually full, which was
    // most of the time: a tab with no slot has usually never asked for one.
    // Saying "all of them are in use" sends you looking for pages you do not
    // have open.
    let slot = pool.slot_of(tab).ok_or_else(|| {
        if pool.is_full() {
            format!(
                "no browser left for this tab: all {} are open",
                browser::POOL_SIZE
            )
        } else {
            format!("tab {tab} has not been given a browser")
        }
    })?;
    app.get_webview(&browser::slot_label(slot))
        .ok_or_else(|| format!("browser {slot} is missing"))
}

#[tauri::command]
fn browser_navigate(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Mutex<browser::Pool>>,
    tab: browser::TabId,
    url: String,
) -> Result<String, String> {
    // An empty bar is not a request to go anywhere.
    let Some(full) = browser::normalise_url(&url) else {
        return Ok(String::new());
    };
    let webview = webview_for(&app, &pool, tab)?;
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
    tab: browser::TabId,
    action: String,
) -> Result<(), String> {
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown history action: {other}")),
    };
    let Ok(webview) = webview_for(&app, &pool, tab) else {
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
    tab: browser::TabId,
) -> Result<String, String> {
    let Ok(webview) = webview_for(&app, &pool, tab) else {
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
            clipboard_read,
            clipboard_write,
            browser_layout,
            browser_pool_size,
            browser_pool_ready,
            browser_claim,
            browser_release,
            browser_navigate,
            browser_history,
            browser_url,
            ui_log,
            app_version,
            account_name,
            open_external,
            window_minimize,
            window_toggle_maximize,
            window_toggle_fullscreen,
            window_is_maximized,
            window_close,
            window_start_drag,
            save_layout,
            load_layout,
            get_background,
            set_background,
            restore_terminal,
            update::update_stage,
            update::update_staged,
            update::update_apply,
        ])
        .setup(|app| {
            // Everything the old name left behind, before anything reads it.
            persist::migrate_from_mux();

            // Anything a previous update moved aside. Done first and quietly:
            // the files are only removable once whatever was executing them has
            // exited, so the ones that stay are the ones still in use.
            update::sweep_old();

            // Find the terminals before building anything to show them in.
            //
            // They are not ours: they belong to the daemon, and it is either
            // already running with a session in it or needs starting. Failing
            // here is worth surfacing rather than swallowing, because every
            // terminal command below depends on it — but it is not worth
            // refusing to open the window over, since the window is the only
            // place the failure could be read.
            if let Some(state) = app.try_state::<Mutex<Sessions>>() {
                match state.lock() {
                    Ok(mut s) => {
                        if let Err(e) = s.connect(app.handle()) {
                            log_error(&format!("could not reach the daemon: {e:#}"));
                        }
                    }
                    Err(e) => log_error(&format!("session state was poisoned: {e}")),
                }
            }

            // No OS title bar: the app draws its own, which is what puts the
            // active terminal's name and the browser toggle up there instead
            // of a strip that only holds the window buttons. Resizing from the
            // edges still works — an undecorated window keeps its frame, it
            // just stops painting a caption.
            let window = WindowBuilder::new(app, "main")
                .title("hmux")
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
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                    // Without this, dragging a row in the rail does nothing.
                    //
                    // WebView2 registers an OS drop target for the whole
                    // surface so that dropping a file on the app can be
                    // handled natively, and that target consumes the drag
                    // before the page sees it: `dragstart` fires, then no
                    // `dragover` and no `drop` ever arrive, so the row is
                    // picked up and silently put back. Nothing here wants a
                    // file dropped on it, and reordering the rail is worth
                    // more than a capability the app does not use.
                    .disable_drag_drop_handler()
                    // Let Tauri keep this matched to the window.
                    //
                    // It was being resized by hand from the window's `Resized`
                    // event, and that is a race the app loses on a fullscreen
                    // transition: the last event arrives before Windows has
                    // released the taskbar, `inner_size` honestly answers the
                    // size from a moment ago, and nothing asks again. The
                    // window was the full height of the screen with a page
                    // inside it forty-eight pixels short.
                    //
                    // Auto-resize is the same job done from inside, where the
                    // new size is known rather than polled for.
                    .auto_resize(),
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
                if !matches!(event, tauri::WindowEvent::Resized(_)) {
                    return;
                }
                sync_ui_size(&resize_handle);
            });

            // Ask the daemon what everything is doing, on a timer.
            //
            // It walks the process table for all its sessions in one pass and
            // answers with the lot, and the answer reaches the UI through the
            // event reader like any other event. Nothing here waits for it.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("activity-poll".into())
                .spawn(move || loop {
                    std::thread::sleep(ACTIVITY_POLL);
                    if let Some(state) = handle.try_state::<Mutex<Sessions>>() {
                        if let Ok(s) = state.lock() {
                            s.poll();
                        }
                    }
                })
                .expect("failed to start the activity poller");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running hmux");
}
