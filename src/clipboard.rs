//! The Windows clipboard, as text.
//!
//! The webview has `navigator.clipboard`, and it is not usable for this. It
//! refuses unless the document is focused, and "focused" means the exact
//! webview the call came from — this window has several, and a right click
//! lands on whichever one it lands on. The failure is also asynchronous and
//! silent enough to look like the paste simply doing nothing.
//!
//! The clipboard is a per-desktop resource any process can hold, so opening it
//! is a thing that can legitimately fail and be worth retrying rather than an
//! error to report.

use std::iter::once;

use anyhow::{bail, Result};
use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

/// How many times to try taking the clipboard before giving up.
///
/// Only one process can hold it at a time, and something always is for a
/// moment — the thing you just copied from, an editor syncing, a password
/// manager. Failing the first time is normal; failing ten times apart is not.
const ATTEMPTS: u32 = 10;

/// Hold the clipboard open, and close it however the caller leaves.
///
/// Leaking it open is worse than any error that could happen while it is:
/// every other application on the desktop is locked out until this process
/// exits.
struct Clipboard;

impl Clipboard {
    fn open() -> Result<Self> {
        for attempt in 0..ATTEMPTS {
            if unsafe { OpenClipboard(std::ptr::null_mut::<std::ffi::c_void>() as HWND) } != 0 {
                return Ok(Clipboard);
            }
            std::thread::sleep(std::time::Duration::from_millis(10 * (attempt as u64 + 1)));
        }
        bail!("another application is holding the clipboard")
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe { CloseClipboard() };
    }
}

/// What is on the clipboard, or an empty string when it holds no text.
///
/// An image or a file list is not an error — it is simply nothing to paste
/// into a terminal.
pub fn read_text() -> Result<String> {
    let _clipboard = Clipboard::open()?;

    let handle = unsafe { GetClipboardData(CF_UNICODETEXT as u32) };
    if handle.is_null() {
        return Ok(String::new());
    }

    let ptr = unsafe { GlobalLock(handle as _) } as *const u16;
    if ptr.is_null() {
        bail!("the clipboard's text could not be read");
    }

    let mut len = 0usize;
    // Walked rather than taking the allocation's size: the block is rounded up
    // and the text ends at its terminator, not at the end of the block.
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) });
    unsafe { GlobalUnlock(handle as _) };

    Ok(text)
}

/// Put `text` on the clipboard, replacing whatever was there.
pub fn write_text(text: &str) -> Result<()> {
    let wide: Vec<u16> = text.encode_utf16().chain(once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();

    let _clipboard = Clipboard::open()?;
    unsafe { EmptyClipboard() };

    let block = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
    if block.is_null() {
        bail!("could not allocate for the clipboard");
    }

    let dst = unsafe { GlobalLock(block) } as *mut u16;
    if dst.is_null() {
        unsafe { GlobalFree(block) };
        bail!("could not write to the clipboard's memory");
    }
    unsafe {
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
        GlobalUnlock(block);
    }

    // Ownership of the block passes to the clipboard on success, so it must
    // only be freed here when it did not.
    if unsafe { SetClipboardData(CF_UNICODETEXT as u32, block as HANDLE) }.is_null() {
        unsafe { GlobalFree(block) };
        bail!("the clipboard refused the text");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round trip through the real clipboard.
    ///
    /// One test rather than several, because the clipboard is one shared
    /// desktop resource and cargo runs tests in parallel: two of these racing
    /// each other fail roughly half the time, and a test that fails on a coin
    /// toss teaches you to ignore it.
    ///
    /// It puts back something recognisably ours rather than something that
    /// could be mistaken for the user's own data.
    #[test]
    fn text_survives_a_round_trip() {
        let sample = "hmux clipboard test — ünïcödé ✓";
        if write_text(sample).is_err() {
            // A machine with no window station (some CI) has no clipboard at
            // all. That is not this code being wrong.
            return;
        }
        assert_eq!(read_text().unwrap(), sample);

        // Empty is a value, not a failure: clearing the clipboard and pasting
        // should type nothing, not report a problem.
        write_text("").unwrap();
        assert_eq!(read_text().unwrap(), "");
    }
}
