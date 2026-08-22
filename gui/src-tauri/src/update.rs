//! Updating in place, without dropping what is running.
//!
//! The pitch for this app is terminals that outlive the window looking at them,
//! so an update that killed them to install itself would be the one moment the
//! promise did not hold — and it is the moment people notice, because it is the
//! moment they did not choose. So the update is arranged around the daemon
//! rather than around the window.
//!
//! Windows will not let you overwrite the image of a running process. It will
//! quite happily let you *rename* one: the file moves, the process carries on
//! executing from it, and the name is free for the new build. That single
//! asymmetry is what makes all of this possible.
//!
//! | Binary           | Running? | What happens |
//! | ---------------- | -------- | ------------ |
//! | `mux-gui.exe`    | yes      | moved aside, replaced, relaunched — you lose a window and get it straight back |
//! | `mux.exe`        | no       | replaced |
//! | `mux-daemon.exe` | yes      | moved aside, replaced, **not restarted** |
//!
//! The daemon is the one that must not be disturbed, and it is the one this
//! deliberately does the least to. The new binary is put in place and the old
//! one keeps running your shells from the file it was moved to. It is picked up
//! whenever the daemon next starts, which is after it has been idle with
//! nothing to hold — see `IDLE_EXIT` in `mux::daemon`. An update therefore
//! reaches the daemon late, and that is the right trade: a daemon restarted on
//! time is a daemon that killed a build half way through.
//!
//! The `.old` files cannot be deleted while anything is executing them, so
//! sweeping them up is done at startup rather than here, and a failure to
//! remove one is expected rather than exceptional.

use std::path::{Path, PathBuf};

/// The binaries an update may replace.
///
/// A fixed list rather than "whatever the release has in it": this writes
/// executables into the directory the app runs from, and the name comes over
/// the IPC boundary from a webview that has just been talking to the network.
/// Nothing outside this list is written, whatever it is called.
const UPDATABLE: [&str; 3] = ["mux-gui.exe", "mux.exe", "mux-daemon.exe"];

/// Where a downloaded binary waits until every one of them has arrived.
///
/// Staged first, applied together. Replacing them one at a time as they land
/// would leave a half-updated install behind any failure part way through —
/// a new window talking to an old daemon, which is exactly the mismatch the
/// protocol between them is not versioned against.
const STAGING: &str = "staged";

fn install_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("could not find our own path: {e}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "our own path has no directory".to_string())
}

fn staging_dir() -> Result<PathBuf, String> {
    Ok(install_dir()?.join(STAGING))
}

/// Reject anything that is not one of the three binaries, by exact name.
fn checked_name(name: &str) -> Result<&str, String> {
    UPDATABLE
        .iter()
        .find(|n| **n == name)
        .copied()
        .ok_or_else(|| format!("{name} is not one of this app's binaries"))
}

/// Put a downloaded binary in the staging directory.
///
/// The bytes come from the webview, which did the download: it already has an
/// HTTP stack with progress reporting in it, and adding one here to avoid a
/// single IPC hop would be a dependency for its own sake.
#[tauri::command]
pub fn update_stage(name: String, bytes: Vec<u8>) -> Result<(), String> {
    let name = checked_name(&name)?;

    // An empty or absurdly small file is a failed download that returned 200 —
    // a proxy's error page, most often. Applying it would replace a working
    // binary with something that cannot start, and the app would be gone
    // rather than merely un-updated.
    if bytes.len() < 64 * 1024 {
        return Err(format!(
            "{name} came back as {} bytes, which is not a program",
            bytes.len()
        ));
    }
    // Every one of these is a PE image. Checking the magic costs nothing and
    // catches the case above when the error page happens to be large.
    if !bytes.starts_with(b"MZ") {
        return Err(format!("{name} is not a Windows executable"));
    }

    let dir = staging_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let target = dir.join(name);
    std::fs::write(&target, &bytes)
        .map_err(|e| format!("could not write {}: {e}", target.display()))?;
    Ok(())
}

/// Whether anything is staged and ready to be applied.
#[tauri::command]
pub fn update_staged() -> Vec<String> {
    let Ok(dir) = staging_dir() else {
        return Vec::new();
    };
    UPDATABLE
        .iter()
        .filter(|n| dir.join(n).is_file())
        .map(|n| (*n).to_string())
        .collect()
}

/// Swap every staged binary into place and start the new window.
///
/// The running daemon is not touched beyond having its file renamed, so the
/// terminals it owns are still there when the new window attaches to them.
/// That is the whole point, and it is why this does not simply ask the daemon
/// to quit and start again.
#[tauri::command]
pub fn update_apply(app: tauri::AppHandle) -> Result<(), String> {
    let dir = install_dir()?;
    let staged = staging_dir()?;

    let ready: Vec<&str> = UPDATABLE
        .iter()
        .copied()
        .filter(|n| staged.join(n).is_file())
        .collect();
    if ready.is_empty() {
        return Err("there is nothing staged to install".into());
    }

    // Distinct per run, so a binary moved aside can never land on one that is
    // still there from last time.
    //
    // The fixed name `<binary>.old` looked fine and failed on the second
    // update: the sweep cannot delete a file the previous daemon is still
    // executing, and a rename cannot overwrite one either, so the update fell
    // over on its own leftovers rather than on anything to do with the new
    // build. Nothing else can be holding a name with this in it.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    for name in &ready {
        let live = dir.join(name);
        let new = staged.join(name);
        let aside = dir.join(format!("{name}.{stamp}.old"));

        // Move the current one aside if it is there. This succeeds whether or
        // not it is running, which is the property the whole design rests on.
        if live.exists() {
            std::fs::rename(&live, &aside).map_err(|e| {
                format!("could not move {} aside: {e}", live.display())
            })?;
        }

        // Rename rather than copy: both are on the same volume, so this is
        // atomic, and a copy could be interrupted leaving a partial binary
        // under the real name.
        if let Err(e) = std::fs::rename(&new, &live) {
            // Put back what was moved, or the app has no executable at all.
            let _ = std::fs::rename(&aside, &live);
            return Err(format!("could not install {}: {e}", live.display()));
        }
    }

    let _ = std::fs::remove_dir_all(&staged);

    // Start the replacement before this one goes away, so there is never a
    // moment with no window. It attaches to the same daemon and finds the same
    // terminals, mid-command, which is what makes this feel like a restart of
    // the chrome rather than of the session.
    let gui = dir.join("mux-gui.exe");
    std::process::Command::new(&gui)
        .spawn()
        .map_err(|e| format!("installed the update but could not start {}: {e}", gui.display()))?;

    app.exit(0);
    Ok(())
}

/// Delete the binaries a previous update moved aside.
///
/// At startup, because that is the first moment the processes using them are
/// likely to have exited — this window is the new one, and the old daemon may
/// still be going. A file that will not delete is one still in use, which is
/// normal and not worth reporting.
pub fn sweep_old() {
    let Ok(dir) = install_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "old") {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_apps_binaries_may_be_written() {
        // The name arrives over IPC from a webview that has been talking to the
        // network, and this function writes executables next to the running
        // one. Anything not on the list is refused by name.
        assert!(checked_name("mux-gui.exe").is_ok());
        assert!(checked_name("mux-daemon.exe").is_ok());
        assert!(checked_name("mux.exe").is_ok());

        assert!(checked_name("mux-gui.exe.old").is_err());
        assert!(checked_name("MUX-GUI.EXE").is_err());
        assert!(checked_name("payload.dll").is_err());
    }

    #[test]
    fn a_path_cannot_be_smuggled_through_the_name() {
        // Exact matching means separators never have to be reasoned about:
        // there is no name containing one that is also on the list.
        assert!(checked_name("..\\..\\mux-gui.exe").is_err());
        assert!(checked_name("../../mux-gui.exe").is_err());
        assert!(checked_name("C:\\Windows\\System32\\mux.exe").is_err());
        assert!(checked_name("sub/mux.exe").is_err());
    }

    #[test]
    fn something_that_is_not_a_program_is_not_staged() {
        // A proxy or captive portal answering 200 with an HTML error page is
        // the realistic version of this, and installing it would leave the
        // machine with no working mux rather than an out of date one.
        let html = b"<!DOCTYPE html><html>error</html>".to_vec();
        let err = update_stage("mux.exe".into(), html).unwrap_err();
        assert!(err.contains("not a program"), "{err}");

        let big_but_wrong = vec![b'<'; 128 * 1024];
        let err = update_stage("mux.exe".into(), big_but_wrong).unwrap_err();
        assert!(err.contains("not a Windows executable"), "{err}");
    }

    #[test]
    fn nothing_is_staged_under_a_name_that_was_refused() {
        let err = update_stage("evil.exe".into(), vec![b'M', b'Z']).unwrap_err();
        assert!(err.contains("not one of this app's binaries"), "{err}");
    }
}
