//! End-to-end checks against a real ConPTY and a real `cmd.exe`.
//!
//! The unit tests cover the emulator by feeding it bytes directly, which proves
//! nothing about whether we can actually talk to Windows. These spawn the shell
//! for real: they are the tests that fail when ConPTY, the reader thread, or
//! the input path is wired up wrong.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use hmux::activity::{Activity, ProcessTable};
use hmux::grid::Color;
use hmux::pane::Pane;

/// Poll the pane's grid until `needle` shows up, or give up.
fn wait_for(pane: &Pane, needle: &str, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        let screen = {
            let g = pane.grid.lock().unwrap();
            (0..g.rows)
                .map(|r| g.row(r).iter().map(|c| c.ch).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        };
        if screen.contains(needle) {
            return Some(screen);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn spawns_a_shell_and_runs_a_command() {
    let (tx, _rx) = mpsc::channel();
    let pane = Pane::spawn(1, "cmd", "cmd.exe", 80, 24, tx).expect("failed to open a ConPTY");

    assert!(pane.is_alive());

    // Wait for the shell to be ready before typing at it.
    assert!(
        wait_for(&pane, ">", Duration::from_secs(15)).is_some(),
        "cmd.exe never produced a prompt"
    );

    // `21*2` proves the child actually executed: the echoed command line
    // contains "21*2", but only real output contains "42".
    pane.write_input(b"set /a 21*2\r\n");

    let screen = wait_for(&pane, "42", Duration::from_secs(15))
        .expect("command output never appeared in the grid");

    assert!(screen.contains("42"), "screen was:\n{screen}");
}

#[test]
fn a_hidden_pane_keeps_running() {
    // The whole point of the sidebar: panes are not ephemeral. Nothing here
    // ever "focuses" the pane — it is never rendered, never read from by a UI —
    // and it still has to make progress.
    let (tx, _rx) = mpsc::channel();
    let pane = Pane::spawn(1, "cmd", "cmd.exe", 80, 24, tx).expect("failed to open a ConPTY");

    assert!(wait_for(&pane, ">", Duration::from_secs(15)).is_some());

    pane.write_input(b"echo still-alive-marker\r\n");
    assert!(
        wait_for(&pane, "still-alive-marker", Duration::from_secs(15)).is_some(),
        "an unattended pane stopped making progress"
    );
}

#[test]
fn resize_reaches_the_child() {
    let (tx, _rx) = mpsc::channel();
    let pane = Pane::spawn(1, "cmd", "cmd.exe", 80, 24, tx).expect("failed to open a ConPTY");
    assert!(wait_for(&pane, ">", Duration::from_secs(15)).is_some());

    pane.resize(100, 30);

    let g = pane.grid.lock().unwrap();
    assert_eq!(g.cols, 100);
    assert_eq!(g.rows, 30);
}

#[test]
fn the_composed_frame_has_a_rail_a_divider_and_live_output() {
    let (tx, _rx) = mpsc::channel();
    let a = Pane::spawn(1, "cmd", "cmd.exe", 60, 20, tx.clone()).expect("pane 1");
    let b = Pane::spawn(2, "cmd", "cmd.exe", 60, 20, tx).expect("pane 2");

    assert!(wait_for(&a, ">", Duration::from_secs(15)).is_some());
    a.write_input(b"set /a 21*2\r\n");
    assert!(wait_for(&a, "42", Duration::from_secs(15)).is_some());

    let (cols, rows) = (80u16, 24u16);
    let l = hmux::layout::compute(cols, rows, 20);
    let panes = vec![a, b];
    let frame = hmux::render::compose(&panes, 0, &l, cols, rows, false);

    let row = |y: u16| -> String {
        (0..cols)
            .map(|x| frame.cells[y as usize * cols as usize + x as usize].ch)
            .collect()
    };

    assert!(row(0).starts_with(" TERMINALS"), "rail heading missing: {:?}", row(0));

    // Pane 1 is active and marked; pane 2 is listed but unmarked.
    let first = row(l.button_row(0));
    let second = row(l.button_row(1));
    assert!(first.contains('▸'), "active marker missing: {first:?}");
    assert!(first.contains("1:"), "first button missing: {first:?}");
    assert!(second.contains("2:"), "second button missing: {second:?}");
    assert!(!second.trim_start().starts_with('▸'), "inactive pane marked: {second:?}");

    // The vertical rule separates rail from terminal on every body row.
    for y in 0..l.sidebar.h {
        let c = frame.cells[y as usize * cols as usize + l.divider_x as usize].ch;
        assert_eq!(c, '│', "divider broken at row {y}");
    }

    // The active pane's output is actually painted into the content area.
    let content: String = (0..l.content.h).map(row).collect::<Vec<_>>().join("\n");
    assert!(content.contains("42"), "live output not composed:\n{content}");

    // And the status line reports both panes.
    assert!(row(l.status.y).contains("2/2 live"), "status wrong: {:?}", row(l.status.y));
}

/// Poll the process table until a pane reaches the wanted state.
fn wait_for_activity(pane: &Pane, want_busy: bool, timeout: Duration) -> Option<Activity> {
    let deadline = Instant::now() + timeout;
    loop {
        let activity = pane.activity(&ProcessTable::capture());
        if activity.is_busy() == want_busy {
            return Some(activity);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[test]
fn a_running_command_flips_the_terminal_to_busy_and_back() {
    // This is exactly what drives the sidebar's idle/busy badge, tested without
    // a window: spawn a shell, run something slow, watch the state change.
    // Via `Pane` rather than a bare `PtyProcess`, because a raw reader is not
    // a terminal: cmd.exe opens by asking `\x1b[6n` (report cursor position)
    // and blocks until something answers. Pane's Grid answers; a plain byte
    // sink deadlocks after exactly four bytes.
    let (tx, _rx) = mpsc::channel();
    let pane = Pane::spawn(1, "cmd", "cmd.exe", 80, 24, tx).expect("failed to open a ConPTY");

    assert!(
        wait_for(&pane, ">", Duration::from_secs(15)).is_some(),
        "cmd.exe never produced a prompt"
    );

    // A shell sitting at its prompt has no children.
    assert!(
        wait_for_activity(&pane, false, Duration::from_secs(10)).is_some(),
        "a fresh shell never settled to idle"
    );

    pane.write_input(b"ping -n 6 127.0.0.1\r\n");

    let busy = wait_for_activity(&pane, true, Duration::from_secs(15))
        .expect("a running command never registered as busy");
    match &busy {
        Activity::Running { command, .. } => {
            assert_eq!(command, "ping", "busy, but reported `{command}`");
        }
        other => panic!("expected Busy, got {other:?}"),
    }

    // And back again once it finishes — a badge that latches on is useless.
    assert!(
        wait_for_activity(&pane, false, Duration::from_secs(30)).is_some(),
        "the terminal stayed busy after its command finished"
    );
}

#[test]
fn colour_survives_the_whole_pipeline() {
    // "The terminal has no colours" needs an answer that isn't a screenshot.
    // This drives a real shell, asks it for red text, and checks the cell that
    // came out the far end is actually red — proving ConPTY advertises colour
    // support, the program emits SGR, and the emulator keeps it.
    let (tx, _rx) = mpsc::channel();
    let pane = Pane::spawn(1, "ps", "powershell.exe", 100, 30, tx)
        .expect("failed to open a ConPTY");

    assert!(
        wait_for(&pane, ">", Duration::from_secs(30)).is_some(),
        "powershell never produced a prompt"
    );

    pane.write_input(b"Write-Host -ForegroundColor Red 'REDTEXT'\r\n");
    assert!(
        wait_for(&pane, "REDTEXT", Duration::from_secs(30)).is_some(),
        "the command never produced output"
    );

    // The echoed command line contains REDTEXT too, in the default colour, so
    // look for any occurrence that carries a colour.
    let grid = pane.grid.lock().unwrap();
    let mut coloured = None;
    for r in 0..grid.rows {
        let row = grid.row(r);
        for c in 0..grid.cols.saturating_sub(3) {
            let is_marker = row[c].ch == 'R' && row[c + 1].ch == 'E' && row[c + 2].ch == 'D';
            if is_marker && row[c].fg != Color::Default {
                coloured = Some(row[c].fg);
            }
        }
    }

    assert!(
        coloured.is_some(),
        "REDTEXT reached the grid with no colour at all — the pipeline is dropping SGR"
    );
}

#[test]
fn programs_are_told_this_terminal_does_truecolor() {
    // Node reports what it thinks the terminal supports: 24 = truecolor,
    // 8 = 256 colours, 4 = 16 colours, 1 = none.
    //
    // This is the difference between Claude Code drawing its whole UI in one
    // ANSI colour and drawing it properly, so it is worth pinning: a terminal
    // that under-reports here looks broken while being perfectly capable.
    let (tx, _rx) = mpsc::channel();
    let pane = Pane::spawn(1, "ps", "powershell.exe", 100, 30, tx)
        .expect("failed to open a ConPTY");

    assert!(
        wait_for(&pane, ">", Duration::from_secs(30)).is_some(),
        "powershell never produced a prompt"
    );

    // The marker is assembled at runtime so it cannot appear in the echoed
    // command line — otherwise the wait matches the echo and reads the screen
    // before node has answered.
    pane.write_input(
        b"node -p \"['dep','th'].join('')+'='+process.stdout.getColorDepth()\"\r\n",
    );

    let screen = wait_for(&pane, "depth=", Duration::from_secs(40))
        .expect("node never reported a colour depth");

    assert!(
        screen.contains("depth=24"),
        "node sees a degraded terminal, so colourful programs will flatten \
         their palette. Wanted depth=24, screen was:\n{screen}"
    );
}

#[test]
fn pane_reports_death_after_exit() {
    let (tx, rx) = mpsc::channel();
    let pane = Pane::spawn(7, "cmd", "cmd.exe", 80, 24, tx).expect("failed to open a ConPTY");
    assert!(wait_for(&pane, ">", Duration::from_secs(15)).is_some());

    pane.write_input(b"exit\r\n");

    // Drain events until the exit notice arrives; output events precede it.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut saw_exit = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(hmux::Ev::Exited(id)) => {
                assert_eq!(id, 7);
                saw_exit = true;
                break;
            }
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    assert!(saw_exit, "pane never reported that its shell exited");
    assert!(!pane.is_alive());
}
