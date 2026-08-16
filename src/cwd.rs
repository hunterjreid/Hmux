//! Where a running process thinks it is.
//!
//! Restoring a terminal to "where I left off" means knowing the directory its
//! shell was working in, and a process does not advertise that. Windows keeps
//! it in the process's own address space — `PEB → RTL_USER_PROCESS_PARAMETERS
//! → CurrentDirectory` — so the only way to read it is to ask for the PEB
//! address and then read that memory across the process boundary.
//!
//! Two things to know before relying on this:
//!
//! - The struct offsets below are the 64-bit layout. They are stable in
//!   practice (every debugger and process explorer depends on them) but they
//!   are not a documented API, so every step is checked and any surprise
//!   returns `None` rather than guessing.
//! - It reports the directory the *process* is in, which is not always the one
//!   the shell shows you. Windows PowerShell's `Set-Location` moves its own
//!   provider location and never calls `SetCurrentDirectory`, so a 5.1 session
//!   still reports wherever it started. Callers that have the terminal's text
//!   should prefer what the prompt says and keep this as the fallback.

use std::mem::size_of;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

/// `NtQueryInformationProcess`, resolved at runtime.
///
/// It lives in ntdll and is not part of the documented Win32 surface, so it is
/// looked up by name rather than linked against.
type NtQueryInformationProcess =
    unsafe extern "system" fn(HANDLE, u32, *mut std::ffi::c_void, u32, *mut u32) -> i32;

/// `ProcessBasicInformation`.
const PROCESS_BASIC_INFORMATION: u32 = 0;

/// Size of `PROCESS_BASIC_INFORMATION` on 64-bit, and the offset of the
/// `PebBaseAddress` field within it.
const PBI_SIZE: usize = 48;
const PBI_PEB_ADDRESS: usize = 8;

/// `PEB.ProcessParameters`.
const PEB_PROCESS_PARAMETERS: usize = 0x20;

/// `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath`, a `UNICODE_STRING`.
const PARAMS_CURRENT_DIRECTORY: usize = 0x38;

/// `UNICODE_STRING.Buffer`. `Length` is at offset 0.
const UNICODE_STRING_BUFFER: usize = 0x08;

/// A directory path longer than this is a sign we are reading the wrong bytes.
const MAX_PATH_BYTES: usize = 8192;

/// The working directory of `pid`, if it can be read.
///
/// Returns `None` for anything unexpected: a process that has exited, one this
/// user may not open, a 32-bit build where the offsets do not apply, or a path
/// that does not resolve to a directory that exists.
pub fn of_process(pid: u32) -> Option<PathBuf> {
    // The offsets above describe the 64-bit structures only.
    if cfg!(not(target_pointer_width = "64")) || pid == 0 {
        return None;
    }

    unsafe {
        let query = nt_query_information_process()?;

        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if process.is_null() {
            return None;
        }

        let found = read_current_directory(query, process);
        CloseHandle(process);
        found
    }
}

unsafe fn nt_query_information_process() -> Option<NtQueryInformationProcess> {
    unsafe {
        // ntdll is mapped into every process, so this is a lookup rather than a
        // load and cannot fail for the usual "missing DLL" reasons.
        let ntdll = GetModuleHandleA(c"ntdll.dll".as_ptr().cast());
        if ntdll.is_null() {
            return None;
        }
        let symbol = GetProcAddress(ntdll, c"NtQueryInformationProcess".as_ptr().cast())?;
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            NtQueryInformationProcess,
        >(symbol))
    }
}

unsafe fn read_current_directory(
    query: NtQueryInformationProcess,
    process: HANDLE,
) -> Option<PathBuf> {
    let mut info = [0u8; PBI_SIZE];
    let mut written = 0u32;
    // NTSTATUS: anything but zero means it did not answer.
    let status = unsafe {
        query(
            process,
            PROCESS_BASIC_INFORMATION,
            info.as_mut_ptr().cast(),
            PBI_SIZE as u32,
            &mut written,
        )
    };
    if status != 0 {
        return None;
    }

    let peb = usize::from_ne_bytes(
        info[PBI_PEB_ADDRESS..PBI_PEB_ADDRESS + size_of::<usize>()]
            .try_into()
            .ok()?,
    );
    if peb == 0 {
        return None;
    }

    let parameters: usize = unsafe { read_value(process, peb + PEB_PROCESS_PARAMETERS) }?;
    if parameters == 0 {
        return None;
    }

    let directory = parameters + PARAMS_CURRENT_DIRECTORY;
    let length: u16 = unsafe { read_value(process, directory) }?;
    let buffer: usize = unsafe { read_value(process, directory + UNICODE_STRING_BUFFER) }?;

    let length = length as usize;
    if length == 0 || length % 2 != 0 || length > MAX_PATH_BYTES || buffer == 0 {
        return None;
    }

    let mut bytes = vec![0u8; length];
    if !unsafe { read_bytes(process, buffer, &mut bytes) } {
        return None;
    }

    let wide: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
        .collect();
    let path = String::from_utf16(&wide).ok()?;

    // Windows stores it with a trailing separator; `C:\` needs to keep one.
    let trimmed = if path.len() > 3 {
        path.trim_end_matches('\\')
    } else {
        path.as_str()
    };

    let path = PathBuf::from(trimmed);
    path.is_dir().then_some(path)
}

unsafe fn read_value<T: Copy>(process: HANDLE, address: usize) -> Option<T> {
    unsafe {
        let mut value: T = std::mem::zeroed();
        let slot =
            std::slice::from_raw_parts_mut((&mut value as *mut T).cast::<u8>(), size_of::<T>());
        read_bytes(process, address, slot).then_some(value)
    }
}

unsafe fn read_bytes(process: HANDLE, address: usize, into: &mut [u8]) -> bool {
    let mut read = 0usize;
    let ok = unsafe {
        ReadProcessMemory(
            process,
            address as *const std::ffi::c_void,
            into.as_mut_ptr().cast(),
            into.len(),
            &mut read,
        )
    };
    ok != 0 && read == into.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_reports_the_directory_it_is_running_in() {
        // The one process whose working directory we already know.
        let expected = std::env::current_dir().expect("no current directory");
        let found = of_process(std::process::id())
            .expect("could not read this process's own working directory");
        assert_eq!(
            found.canonicalize().ok(),
            expected.canonicalize().ok(),
            "read {found:?}, expected {expected:?}"
        );
    }

    #[test]
    fn a_pid_that_cannot_exist_is_not_guessed_at() {
        assert!(of_process(0).is_none());
        assert!(of_process(u32::MAX).is_none());
    }
}
