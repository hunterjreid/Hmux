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

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, Window};

use crate::sessions::SessionId;

/// The start page every browser opens on, served from the app's own assets.
pub const NEW_TAB: &str = "newtab.html";

/// Where a bare search goes.
const SEARCH: &str = "https://duckduckgo.com/?q=";

/// How many terminals can have their own browser at once. Each slot is a live
/// WebView2, so this trades memory for how many pages stay warm.
pub const POOL_SIZE: usize = 6;

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
            WebviewBuilder::new(slot_label(slot), WebviewUrl::App(NEW_TAB.into())),
            LogicalPosition::new(PARKED_X, 0.0),
            LogicalSize::new(1024.0, 768.0),
        )?;
    }
    Ok(())
}

/// Which session currently owns which slot.
#[derive(Default)]
pub struct Pool {
    by_session: HashMap<SessionId, usize>,
    /// The new-tab page's real address, learned at startup by asking a webview
    /// what it loaded. The asset protocol's host differs by platform, so
    /// hard-coding it would be guessing.
    home: Option<String>,
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

    /// Give `id` a slot, or `None` when every browser is taken.
    pub fn assign(&mut self, id: SessionId) -> Option<usize> {
        if let Some(&slot) = self.by_session.get(&id) {
            return Some(slot);
        }
        let taken: Vec<usize> = self.by_session.values().copied().collect();
        let slot = (0..POOL_SIZE).find(|s| !taken.contains(s))?;
        self.by_session.insert(id, slot);
        Some(slot)
    }

    pub fn slot_of(&self, id: SessionId) -> Option<usize> {
        self.by_session.get(&id).copied()
    }

    /// Hand the slot back. The caller is expected to send it home so the next
    /// terminal does not inherit the last one's page.
    pub fn release(&mut self, id: SessionId) -> Option<usize> {
        self.by_session.remove(&id)
    }
}

/// Put `active`'s browser over the given rectangle and park every other one.
pub fn layout(
    app: &AppHandle,
    active_slot: Option<usize>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    // A collapsed panel hides every browser; there is no CSS to do it for us.
    let visible = width >= 1.0 && height >= 1.0;

    for slot in 0..POOL_SIZE {
        let Some(webview) = app.get_webview(&slot_label(slot)) else {
            continue;
        };
        if visible && Some(slot) == active_slot {
            let _ = webview.set_position(LogicalPosition::new(x, y));
            let _ = webview.set_size(LogicalSize::new(width, height));
        } else {
            let _ = webview.set_position(LogicalPosition::new(PARKED_X, 0.0));
        }
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
    if t.starts_with("http://") || t.starts_with("https://") || t.starts_with("about:") {
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
