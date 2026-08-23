//! The terminals, without a window.
//!
//! Started by whichever front end finds no daemon running, and then left
//! alone: it holds the pseudoconsoles so that closing a window is a change of
//! what you are looking at rather than the end of what you were doing.
//!
//! Nothing to configure and nothing to say. If it prints, something is wrong.

#![windows_subsystem = "windows"]

fn main() {
    if let Err(e) = hmux::daemon::run() {
        // Only reachable when the pipe itself could not be served, which is
        // almost always a second daemon losing the race for the name. Exiting
        // quietly is correct: the one that won is already doing the job.
        eprintln!("hmux-daemon: {e:#}");
        std::process::exit(1);
    }
}
