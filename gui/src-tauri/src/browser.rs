//! One browser per terminal, from a pool created at startup.
//!
//! A terminal and the page you were reading beside it belong together, so each
//! session gets its own webview rather than sharing one that re-navigates on
//! every switch. Re-navigating would throw away scroll position, form state and
//! anything behind a login — the same ephemerality the terminals themselves
//! exist to avoid.
//!
//! Why a fixed pool rather than one made on demand: creating a WebView2 after
//! the event loop is running blocks the main thread. Not slowly — permanently.
//! Every subsequent command stops being answered, which presents as the whole
//! app going quiet. Creation is only safe during `setup`, before the loop
//! starts, so all of them are made there and handed out afterwards.
//!
//! The cost of a pool is a ceiling on how many terminals can have a browser.
//! Terminals past that still work; they just show a note instead of a page,
//! which is a better failure than a hang.
//!
//! These are native child surfaces, not DOM elements: they obey no CSS, cannot
//! be clipped by the chrome, and sit above it. "Hiding" one means moving it
//! off-screen, and exactly one is ever over the visible slot.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, Window};


/// The start page every browser opens on, served from the app's own assets.
pub const NEW_TAB: &str = "newtab.html";

/// Where a bare search goes.
const SEARCH: &str = "https://duckduckgo.com/?q=";

/// How many pages can be open at once, across every terminal.
///
/// Each slot is a live WebView2 built before the window opens, so this is paid
/// for at startup whether or not the tabs are ever used — memory and a slower
/// cold start, traded for pages that stay warm. It cannot be raised at runtime
/// no matter how much anyone wants it to; see the module note.
pub const POOL_SIZE: usize = 12;

/// Somewhere far to the left of any real monitor.
const PARKED_X: f64 = -20_000.0;

pub fn slot_label(slot: usize) -> String {
    format!("browser-{slot}")
}

/// Build every browser webview. Must be called from `setup`, before the event
/// loop starts — see the module note.
pub fn create_pool(window: &Window) -> tauri::Result<()> {
    for slot in 0..POOL_SIZE {
        window.add_child(
            WebviewBuilder::new(slot_label(slot), WebviewUrl::App(NEW_TAB.into()))
                // Ctrl+scroll and Ctrl+plus/minus, handled by the engine itself.
                // Doing it here rather than in the chrome is not a shortcut: a
                // native webview sits above everything and takes its own input,
                // so the chrome never sees a scroll that happened over a page
                // and could not zoom it even if it wanted to.
                .zoom_hotkeys_enabled(true)
                // Whether a page is loading is something only the webview
                // knows. Reported against the terminal it belongs to rather
                // than the slot it happens to occupy, because a slot is an
                // implementation detail the chrome has no name for.
                .on_page_load(move |webview, payload| {
                    let loading = matches!(payload.event(), PageLoadEvent::Started);
                    let app = webview.app_handle().clone();
                    let Some(pool) = app.try_state::<Mutex<Pool>>() else {
                        return;
                    };
                    let owner = pool.lock().ok().and_then(|p| p.tab_of(slot));
                    if let Some(tab) = owner {
                        let _ = app.emit("browser-loading", Loading { tab, loading });
                    }
                }),
            LogicalPosition::new(PARKED_X, 0.0),
            LogicalSize::new(1024.0, 768.0),
        )?;
    }
    Ok(())
}

/// One open page. The number is the UI's to invent: it is the only side that
/// knows how tabs are grouped into terminals, and this half only has to hand
/// out browsers.
pub type TabId = u32;

/// A page starting or finishing, named by the tab it is in.
#[derive(Clone, serde::Serialize)]
pub struct Loading {
    pub tab: TabId,
    pub loading: bool,
}

/// Which tab currently owns which slot.
///
/// Keyed by tab rather than by terminal, which is the whole of what makes tabs
/// possible. A browser cannot be created once the app is running — see the
/// module note, and it was measured rather than assumed — so there is a fixed
/// number of them and the only question is who gets one. Keyed by terminal,
/// every terminal was capped at a single page and the budget was spread evenly
/// whether or not anyone wanted it that way. Keyed by tab, the same browsers go
/// wherever they are actually being used: all of them on one terminal, or one
/// each across many.
#[derive(Default)]
pub struct Pool {
    by_tab: HashMap<TabId, usize>,
    /// The new-tab page's real address, learned at startup by asking a webview
    /// what it loaded. The asset protocol's host differs by platform, so
    /// hard-coding it would be guessing.
    home: Option<String>,
    /// Which slot is currently over the panel, and the rectangle it was put at.
    /// Kept so a layout that changes nothing costs nothing; see [`Pool::layout`].
    placed: Option<usize>,
    placed_at: Option<(i64, i64, i64, i64)>,
}

impl Pool {
    pub fn set_home(&mut self, url: String) {
        self.home = Some(url);
    }

    pub fn home(&self) -> Option<&str> {
        self.home.as_deref()
    }

    /// Whether a URL is the new-tab page, so the address bar can stay empty
    /// instead of showing an internal asset path.
    pub fn is_home(&self, url: &str) -> bool {
        url.contains(NEW_TAB) || self.home.as_deref() == Some(url)
    }

    /// Give `tab` a slot, or `None` when every browser is taken.
    pub fn assign(&mut self, tab: TabId) -> Option<usize> {
        if let Some(&slot) = self.by_tab.get(&tab) {
            return Some(slot);
        }
        let taken: Vec<usize> = self.by_tab.values().copied().collect();
        let slot = (0..POOL_SIZE).find(|s| !taken.contains(s))?;
        self.by_tab.insert(tab, slot);
        Some(slot)
    }

    pub fn slot_of(&self, tab: TabId) -> Option<usize> {
        self.by_tab.get(&tab).copied()
    }

    /// Which tab a slot belongs to. The reverse lookup, for the times something
    /// happens to a webview and the answer has to be reported against the tab
    /// it is showing — a page starting to load, say.
    pub fn tab_of(&self, slot: usize) -> Option<TabId> {
        self.by_tab
            .iter()
            .find(|(_, &s)| s == slot)
            .map(|(&tab, _)| tab)
    }

    /// Hand a tab's slot back when the tab is closed.
    pub fn release(&mut self, tab: TabId) -> Option<usize> {
        self.by_tab.remove(&tab)
    }

    /// Whether every browser is spoken for. Only worth saying out loud when it
    /// is true: a tab without one has usually simply never claimed one.
    pub fn is_full(&self) -> bool {
        self.by_tab.len() >= POOL_SIZE
    }

}

/// Put `active`'s browser over the given rectangle, and move nothing else.
///
/// This used to walk the whole pool on every call, parking eleven webviews to
/// place one. That is a native window move each, and this is called on every
/// layout change — including every frame of the panel sliding, which made one
/// animation about a hundred and eighty of them, and every tab switch twelve.
/// Doubling the pool for tabs doubled the cost of it.
///
/// So the pool remembers what it put where. A call that changes nothing does
/// nothing, and a call that changes the tab moves exactly two: the one leaving
/// and the one arriving.
impl Pool {
    pub fn layout(
        &mut self,
        app: &AppHandle,
        active_slot: Option<usize>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) {
        // A collapsed panel hides every browser; there is no CSS to do it.
        let visible = width >= 1.0 && height >= 1.0;
        let wanted = if visible { active_slot } else { None };

        // Rounded before comparing. The rectangle comes from the DOM as
        // floats that wobble in the last decimal between identical layouts,
        // and a sub-pixel difference is not a reason to move a window.
        let rect = (
            x.round() as i64,
            y.round() as i64,
            width.round() as i64,
            height.round() as i64,
        );

        if self.placed == wanted && self.placed_at == Some(rect) {
            return;
        }

        // Park whatever was there, unless it is staying.
        if let Some(old) = self.placed {
            if Some(old) != wanted {
                if let Some(webview) = app.get_webview(&slot_label(old)) {
                    let _ = webview.set_position(LogicalPosition::new(PARKED_X, 0.0));
                }
            }
        }

        match wanted {
            Some(slot) => {
                if let Some(webview) = app.get_webview(&slot_label(slot)) {
                    let _ = webview.set_position(LogicalPosition::new(x, y));
                    let _ = webview.set_size(LogicalSize::new(width, height));
                }
                self.placed = Some(slot);
                self.placed_at = Some(rect);
            }
            None => {
                self.placed = None;
                self.placed_at = None;
            }
        }
    }

    /// Forget where a slot was put, so the next layout places it again.
    ///
    /// Needed when a slot changes hands: the pool would otherwise see the same
    /// slot at the same rectangle and skip the call, leaving the previous tab's
    /// page on screen under the new tab's name.
    pub fn forget_placement(&mut self) {
        self.placed_at = None;
    }
}

/// Accept what people actually type: bare hosts become https, anything with
/// spaces or no dot becomes a search.
///
/// `None` for an empty bar — pressing Enter on nothing should do nothing,
/// rather than navigating away from whatever is open.
pub fn normalise_url(input: &str) -> Option<String> {
    let t = input.trim();
    if t.is_empty() {
        return None;
    }
    // `file://` is here because terminals print local paths as links, and a
    // webview shows an image or a text file perfectly well. Without it a
    // clicked file link fell through to the search-engine branch and searched
    // the web for the path.
    if t.starts_with("http://")
        || t.starts_with("https://")
        || t.starts_with("file://")
        || t.starts_with("about:")
    {
        return Some(t.to_string());
    }
    Some(if !t.contains(' ') && t.contains('.') {
        format!("https://{t}")
    } else {
        format!("{SEARCH}{}", urlencode(t))
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_handed_out_then_reused() {
        let mut pool = Pool::default();
        assert_eq!(pool.assign(1), Some(0));
        assert_eq!(pool.assign(2), Some(1));
        // Asking again is idempotent, not a second allocation.
        assert_eq!(pool.assign(1), Some(0));

        assert_eq!(pool.release(1), Some(0));
        assert_eq!(pool.slot_of(1), None);
        // The freed slot is the next one out.
        assert_eq!(pool.assign(3), Some(0));
    }

    #[test]
    fn running_out_of_slots_is_reported_not_hidden() {
        let mut pool = Pool::default();
        for i in 0..POOL_SIZE {
            assert!(pool.assign(i as u32 + 1).is_some());
        }
        // A terminal past the pool gets no browser rather than stealing one.
        assert_eq!(pool.assign(999), None);
        assert_eq!(pool.slot_of(1), Some(0));
    }

    #[test]
    fn labels_are_unique_per_slot() {
        assert_eq!(slot_label(0), "browser-0");
        assert_ne!(slot_label(0), slot_label(1));
    }

    #[test]
    fn bare_hosts_get_https() {
        assert_eq!(
            normalise_url("example.com").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            normalise_url("  news.ycombinator.com ").as_deref(),
            Some("https://news.ycombinator.com")
        );
    }

    #[test]
    fn explicit_schemes_are_left_alone() {
        assert_eq!(
            normalise_url("http://a.test/x").as_deref(),
            Some("http://a.test/x")
        );
    }

    #[test]
    fn a_file_url_opens_rather_than_being_searched_for() {
        // Terminals print these, and the old rule turned a clicked local path
        // into a web search for it.
        let url = "file:///C:/Users/me/Pictures/shot%202023.png";
        assert_eq!(normalise_url(url).as_deref(), Some(url));
    }

    #[test]
    fn prose_becomes_a_search() {
        assert_eq!(
            normalise_url("rust conpty").as_deref(),
            Some("https://duckduckgo.com/?q=rust+conpty")
        );
        assert!(normalise_url("localhost")
            .unwrap()
            .starts_with("https://duckduckgo.com/?q="));
    }

    #[test]
    fn an_empty_bar_does_nothing() {
        assert_eq!(normalise_url("   "), None);
        assert_eq!(normalise_url(""), None);
    }

    #[test]
    fn the_new_tab_page_is_recognised_so_the_bar_can_stay_empty() {
        let mut pool = Pool::default();
        pool.set_home("http://tauri.localhost/newtab.html".into());
        assert!(pool.is_home("http://tauri.localhost/newtab.html"));
        assert!(!pool.is_home("https://example.com"));
    }
}
