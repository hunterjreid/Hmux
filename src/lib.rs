//! mux — a terminal multiplexer for Windows.
//!
//! Layers, bottom up:
//!   [`term`]   — the host console: raw mode, VT in/out, alternate screen
//!   [`pane`]   — a ConPTY child plus the thread that drains it
//!   [`grid`]   — the terminal emulator that turns its bytes into a screen
//!   [`layout`] — where the rail, the terminal, and the status line live
//!   [`render`] — compose a frame, diff it, emit the difference
//!   [`input`]  — prefix chords and mouse clicks vs. everything else

pub mod grid;
pub mod input;
pub mod layout;
pub mod pane;
pub mod render;
pub mod term;

/// Everything the main loop wakes up for.
pub enum Ev {
    Input(Vec<u8>),
    /// A pane produced output; its grid has already been updated.
    Output,
    Exited(usize),
}
