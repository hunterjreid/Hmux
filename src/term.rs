//! The *host* terminal — the real console that mux draws itself on.
//!
//! This is the Windows-specific edge of the program. We need three things from
//! the console host:
//!
//!   * raw input — no line buffering, no echo, no Ctrl-C handling, because every
//!     keystroke belongs to a child shell, not to us.
//!   * VT input translation — with `ENABLE_VIRTUAL_TERMINAL_INPUT` the console
//!     hands us arrow keys etc. as real escape sequences, so we can forward the
//!     bytes to a pty verbatim instead of re-encoding key events by hand.
//!   * VT output processing — so the escape sequences our renderer emits are
//!     interpreted rather than printed.
//!
//! `HostTerm` restores every mode it touched on drop, including on panic.

use std::io::{self, Write};

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::Console::{
    GetConsoleCP, GetConsoleMode, GetConsoleOutputCP, GetConsoleScreenBufferInfo, GetStdHandle,
    SetConsoleCP, SetConsoleMode, SetConsoleOutputCP, CONSOLE_SCREEN_BUFFER_INFO,
    DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, ENABLE_EXTENDED_FLAGS, ENABLE_LINE_INPUT,
    ENABLE_MOUSE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_QUICK_EDIT_MODE,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WRAP_AT_EOL_OUTPUT,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};

const CP_UTF8: u32 = 65001;

pub fn stdin_handle() -> HANDLE {
    unsafe { GetStdHandle(STD_INPUT_HANDLE) }
}

pub fn stdout_handle() -> HANDLE {
    unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }
}

/// Current size of the console *window* (not the scrollback buffer).
pub fn size() -> (u16, u16) {
    let h = stdout_handle();
    if h == INVALID_HANDLE_VALUE {
        return (80, 24);
    }
    unsafe {
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        if GetConsoleScreenBufferInfo(h, &mut info) == 0 {
            return (80, 24);
        }
        let w = (info.srWindow.Right - info.srWindow.Left + 1).max(1) as u16;
        let h = (info.srWindow.Bottom - info.srWindow.Top + 1).max(1) as u16;
        (w, h)
    }
}

/// Blocking read of raw bytes from the console.
///
/// We deliberately bypass `std::io::Stdin`, which special-cases console handles
/// and routes through `ReadConsoleW` with its own UTF-16 buffering. `ReadFile`
/// on a console handle with VT input enabled gives us exactly the byte stream
/// the child pty wants, and nothing else.
pub fn read_stdin(buf: &mut [u8]) -> io::Result<usize> {
    let h = stdin_handle();
    let mut read: u32 = 0;
    let ok = unsafe {
        ReadFile(
            h,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(read as usize)
}

pub struct HostTerm {
    stdin: HANDLE,
    stdout: HANDLE,
    orig_in_mode: u32,
    orig_out_mode: u32,
    orig_in_cp: u32,
    orig_out_cp: u32,
    restored: bool,
}

impl HostTerm {
    pub fn enter() -> io::Result<Self> {
        let stdin = stdin_handle();
        let stdout = stdout_handle();
        if stdin == INVALID_HANDLE_VALUE || stdout == INVALID_HANDLE_VALUE {
            return Err(io::Error::other("no console attached"));
        }

        let mut orig_in_mode: u32 = 0;
        let mut orig_out_mode: u32 = 0;
        unsafe {
            if GetConsoleMode(stdin, &mut orig_in_mode) == 0
                || GetConsoleMode(stdout, &mut orig_out_mode) == 0
            {
                return Err(io::Error::other(
                    "stdin/stdout is not a console — run mux from a real terminal",
                ));
            }
        }

        let (orig_in_cp, orig_out_cp) = unsafe { (GetConsoleCP(), GetConsoleOutputCP()) };

        // Raw input. ENABLE_EXTENDED_FLAGS is required for the QUICK_EDIT bit to
        // take effect; leaving quick-edit on both freezes output on a stray
        // click and eats the mouse events the sidebar buttons need.
        let in_mode = (orig_in_mode
            & !(ENABLE_ECHO_INPUT
                | ENABLE_LINE_INPUT
                | ENABLE_PROCESSED_INPUT
                | ENABLE_QUICK_EDIT_MODE))
            | ENABLE_MOUSE_INPUT
            | ENABLE_VIRTUAL_TERMINAL_INPUT
            | ENABLE_EXTENDED_FLAGS;

        // DISABLE_NEWLINE_AUTO_RETURN + no auto-wrap: we position every cell
        // explicitly, and an implicit wrap at the last column would scroll the
        // screen out from under the renderer.
        let out_mode = (orig_out_mode & !ENABLE_WRAP_AT_EOL_OUTPUT)
            | ENABLE_PROCESSED_OUTPUT
            | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            | DISABLE_NEWLINE_AUTO_RETURN;

        unsafe {
            SetConsoleMode(stdin, in_mode);
            SetConsoleMode(stdout, out_mode);
            SetConsoleCP(CP_UTF8);
            SetConsoleOutputCP(CP_UTF8);
        }

        let mut out = io::stdout();
        // Alternate screen, cursor hidden, cleared, and mouse reporting in SGR
        // mode (1006) so clicks aren't capped at column 223 like the legacy
        // encoding. 1000 = report presses/releases only, not motion.
        out.write_all(b"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h")?;
        out.flush()?;

        Ok(HostTerm {
            stdin,
            stdout,
            orig_in_mode,
            orig_out_mode,
            orig_in_cp,
            orig_out_cp,
            restored: false,
        })
    }

    pub fn restore(&mut self) {
        if self.restored {
            return;
        }
        self.restored = true;

        let mut out = io::stdout();
        // Mouse off, reset SGR, show cursor, leave the alternate screen.
        let _ = out.write_all(b"\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
        let _ = out.flush();

        unsafe {
            SetConsoleMode(self.stdin, self.orig_in_mode);
            SetConsoleMode(self.stdout, self.orig_out_mode);
            SetConsoleCP(self.orig_in_cp);
            SetConsoleOutputCP(self.orig_out_cp);
        }
    }
}

impl Drop for HostTerm {
    fn drop(&mut self) {
        self.restore();
    }
}
