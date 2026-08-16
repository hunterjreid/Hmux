//! Turning the raw stdin byte stream into either an action or pass-through.
//!
//! Almost every byte belongs to the active child, so the router's job is to
//! recognise the small set that doesn't and forward the rest untouched. Two
//! things get intercepted:
//!
//!   * a prefix chord — `Ctrl-B` then a command key, exactly like tmux
//!   * SGR mouse reports — so the rail is made of real clickable buttons
//!
//! Byte-at-a-time is safe here: 0x02 never appears inside a VT escape sequence,
//! so scanning for the prefix can't false-positive mid-sequence.

pub const PREFIX: u8 = 0x02; // Ctrl-B

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Send these bytes to the active terminal.
    Forward(Vec<u8>),
    NewPane,
    ClosePane,
    NextPane,
    PrevPane,
    SelectPane(usize),
    /// A raw click. Only the main loop knows where the buttons currently are,
    /// so resolving it to a target happens there, against the live layout.
    Mouse(MouseEvent),
    GrowSidebar,
    ShrinkSidebar,
    Redraw,
    Quit,
}

/// Give up on a candidate mouse report after this many bytes and hand them
/// back as ordinary input.
const MAX_MOUSE_LEN: usize = 32;

#[derive(Default)]
pub struct Router {
    prefix_armed: bool,
    /// A partial escape sequence carried across read boundaries.
    ///
    /// Reads split wherever the OS feels like it, so `\x1b`, `[`, and `<` are
    /// not guaranteed to arrive together — matching only within one chunk lets
    /// mouse reports leak through as literal text. Anything held here is either
    /// completed by the next read or flushed by [`Router::flush_pending`].
    pending: Vec<u8>,
}

impl Router {
    pub fn new() -> Self {
        Router::default()
    }

    pub fn prefix_armed(&self) -> bool {
        self.prefix_armed
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Release a held partial sequence as ordinary input.
    ///
    /// The main loop calls this once a short timeout has passed with no further
    /// input, which is how a bare Escape keypress eventually reaches the shell
    /// instead of waiting forever to become a mouse report.
    pub fn flush_pending(&mut self) -> Option<Action> {
        (!self.pending.is_empty()).then(|| Action::Forward(std::mem::take(&mut self.pending)))
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        let mut forward: Vec<u8> = Vec::new();

        for &b in bytes {
            if !self.pending.is_empty() {
                self.continue_pending(b, &mut forward, &mut actions);
                continue;
            }

            // An ESC is always held, even with the prefix armed. A stray mouse
            // report arriving between `C-b` and its command key must not be
            // mistaken for the command key — that silently eats the chord.
            if b == 0x1b {
                self.pending.push(b);
                continue;
            }

            self.plain(b, &mut forward, &mut actions);
        }

        flush(&mut forward, &mut actions);
        actions
    }

    /// Advance a held sequence by one byte, bailing out to ordinary input the
    /// moment it stops looking like `\x1b[<…M`.
    fn continue_pending(&mut self, b: u8, forward: &mut Vec<u8>, actions: &mut Vec<Action>) {
        match self.pending.len() {
            1 if b == b'[' => self.pending.push(b),
            2 if b == b'<' => self.pending.push(b),
            1 | 2 => {
                // Some other escape sequence — an arrow key, say. Pass it through.
                let held = std::mem::take(&mut self.pending);
                forward.extend_from_slice(&held);
                self.plain(b, forward, actions);
            }
            _ => {
                self.pending.push(b);
                if b == b'M' || b == b'm' {
                    let held = std::mem::take(&mut self.pending);
                    match parse_sgr_mouse(&held) {
                        Some(ev) => {
                            flush(forward, actions);
                            actions.push(Action::Mouse(ev));
                        }
                        None => forward.extend_from_slice(&held),
                    }
                } else if self.pending.len() > MAX_MOUSE_LEN {
                    let held = std::mem::take(&mut self.pending);
                    forward.extend_from_slice(&held);
                }
            }
        }
    }

    /// A byte that is not part of an escape sequence: a chord key, the prefix
    /// itself, or something for the shell.
    fn plain(&mut self, b: u8, forward: &mut Vec<u8>, actions: &mut Vec<Action>) {
        if self.prefix_armed {
            self.prefix_armed = false;
            flush(forward, actions);
            match b {
                b'c' => actions.push(Action::NewPane),
                b'x' => actions.push(Action::ClosePane),
                b'n' | b'o' => actions.push(Action::NextPane),
                b'p' => actions.push(Action::PrevPane),
                b'q' => actions.push(Action::Quit),
                b'r' => actions.push(Action::Redraw),
                b'>' | b'.' => actions.push(Action::GrowSidebar),
                b'<' | b',' => actions.push(Action::ShrinkSidebar),
                b'1'..=b'9' => actions.push(Action::SelectPane((b - b'1') as usize)),
                PREFIX => forward.push(PREFIX), // C-b C-b sends a literal C-b
                _ => {}                          // unbound key: swallow it
            }
            return;
        }

        if b == PREFIX {
            self.prefix_armed = true;
            return;
        }

        forward.push(b);
    }
}

fn flush(forward: &mut Vec<u8>, actions: &mut Vec<Action>) {
    if !forward.is_empty() {
        actions.push(Action::Forward(std::mem::take(forward)));
    }
}

/// A decoded SGR-encoded mouse report.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct MouseEvent {
    pub button: u16,
    /// Zero-based, already converted from the wire's 1-based columns/rows.
    pub x: u16,
    pub y: u16,
    pub pressed: bool,
}

/// `\x1b[<button;col;rowM` (press) or `...m` (release).
fn parse_sgr_mouse(buf: &[u8]) -> Option<MouseEvent> {
    let s = std::str::from_utf8(buf).ok()?;
    let body = s.strip_prefix("\x1b[<")?;
    let pressed = body.ends_with('M');
    let body = &body[..body.len() - 1];

    let mut parts = body.split(';');
    let button: u16 = parts.next()?.parse().ok()?;
    let col: u16 = parts.next()?.parse().ok()?;
    let row: u16 = parts.next()?.parse().ok()?;

    Some(MouseEvent {
        button,
        x: col.saturating_sub(1),
        y: row.saturating_sub(1),
        pressed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_bytes_pass_straight_through() {
        let mut r = Router::new();
        assert_eq!(r.feed(b"ls -la\r"), vec![Action::Forward(b"ls -la\r".to_vec())]);
    }

    #[test]
    fn escape_sequences_are_not_mangled() {
        let mut r = Router::new();
        // Up arrow — must arrive at the shell intact for history to work.
        assert_eq!(r.feed(b"\x1b[A"), vec![Action::Forward(b"\x1b[A".to_vec())]);
    }

    #[test]
    fn prefix_chord_is_intercepted() {
        let mut r = Router::new();
        assert_eq!(r.feed(&[PREFIX, b'c']), vec![Action::NewPane]);
        assert_eq!(r.feed(&[PREFIX, b'3']), vec![Action::SelectPane(2)]);
    }

    #[test]
    fn doubled_prefix_sends_a_literal_ctrl_b() {
        let mut r = Router::new();
        assert_eq!(
            r.feed(&[PREFIX, PREFIX]),
            vec![Action::Forward(vec![PREFIX])]
        );
    }

    #[test]
    fn prefix_survives_a_read_boundary() {
        let mut r = Router::new();
        assert_eq!(r.feed(&[PREFIX]), vec![]);
        assert!(r.prefix_armed());
        assert_eq!(r.feed(b"q"), vec![Action::Quit]);
    }

    #[test]
    fn text_around_a_chord_keeps_its_order() {
        let mut r = Router::new();
        assert_eq!(
            r.feed(&[b'a', PREFIX, b'c', b'b']),
            vec![
                Action::Forward(b"a".to_vec()),
                Action::NewPane,
                Action::Forward(b"b".to_vec()),
            ]
        );
    }

    #[test]
    fn mouse_press_is_decoded() {
        let mut r = Router::new();
        let acts = r.feed(b"\x1b[<0;13;4M");
        assert_eq!(
            acts,
            vec![Action::Mouse(MouseEvent {
                button: 0,
                x: 12,
                y: 3,
                pressed: true
            })]
        );
    }

    #[test]
    fn mouse_report_split_across_reads() {
        let mut r = Router::new();
        assert_eq!(r.feed(b"\x1b[<0;13"), vec![]);
        assert_eq!(
            r.feed(b";4M"),
            vec![Action::Mouse(MouseEvent {
                button: 0,
                x: 12,
                y: 3,
                pressed: true
            })]
        );
    }

    #[test]
    fn mouse_report_split_inside_its_own_prefix() {
        // The read can break between ESC, '[' and '<'. Matching only within a
        // single chunk let the whole report through as literal text.
        for split in 1..=3 {
            let seq = b"\x1b[<0;13;4M";
            let mut r = Router::new();
            let first = r.feed(&seq[..split]);
            assert!(first.is_empty(), "leaked at split {split}: {first:?}");
            assert_eq!(
                r.feed(&seq[split..]),
                vec![Action::Mouse(MouseEvent {
                    button: 0,
                    x: 12,
                    y: 3,
                    pressed: true
                })],
                "split {split}"
            );
        }
    }

    #[test]
    fn a_stray_mouse_report_does_not_eat_a_chord() {
        // Focusing the window emits a mouse report. If it lands between C-b and
        // its command key, the ESC must not be consumed as the command key.
        let mut r = Router::new();
        assert_eq!(r.feed(&[PREFIX]), vec![]);
        assert!(r.prefix_armed());

        let acts = r.feed(b"\x1b[<0;37;5m");
        assert_eq!(acts.len(), 1);
        assert!(matches!(acts[0], Action::Mouse(_)));
        assert!(r.prefix_armed(), "the chord was eaten by a mouse report");

        assert_eq!(r.feed(b"c"), vec![Action::NewPane]);
    }

    #[test]
    fn a_lone_escape_is_held_then_released() {
        let mut r = Router::new();
        assert_eq!(r.feed(b"\x1b"), vec![]);
        assert!(r.has_pending());
        assert_eq!(r.flush_pending(), Some(Action::Forward(vec![0x1b])));
        assert!(!r.has_pending());
        assert_eq!(r.flush_pending(), None);
    }

    #[test]
    fn a_non_mouse_escape_sequence_survives_a_split() {
        let mut r = Router::new();
        assert_eq!(r.feed(b"\x1b"), vec![]);
        // Up arrow, split right after the ESC.
        assert_eq!(r.feed(b"[A"), vec![Action::Forward(b"\x1b[A".to_vec())]);
    }
}
