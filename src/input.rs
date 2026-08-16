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

#[derive(Default)]
pub struct Router {
    prefix_armed: bool,
    /// Partial mouse report carried across read boundaries. A single read can
    /// split `\x1b[<0;12;3M` anywhere.
    mouse_buf: Vec<u8>,
}

impl Router {
    pub fn new() -> Self {
        Router::default()
    }

    pub fn prefix_armed(&self) -> bool {
        self.prefix_armed
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        let mut forward: Vec<u8> = Vec::new();

        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];

            // Mid-sequence mouse report: keep consuming until the terminator.
            if !self.mouse_buf.is_empty() {
                self.mouse_buf.push(b);
                if b == b'M' || b == b'm' {
                    if let Some(ev) = parse_sgr_mouse(&self.mouse_buf) {
                        actions.push(Action::Mouse(ev));
                    }
                    self.mouse_buf.clear();
                } else if self.mouse_buf.len() > 32 {
                    // Not a mouse report after all — give the bytes back.
                    forward.extend_from_slice(&self.mouse_buf);
                    self.mouse_buf.clear();
                }
                i += 1;
                continue;
            }

            if self.prefix_armed {
                self.prefix_armed = false;
                flush(&mut forward, &mut actions);
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
                i += 1;
                continue;
            }

            // Start of an SGR mouse report?
            if b == 0x1b && bytes[i..].starts_with(b"\x1b[<") {
                self.mouse_buf.push(b);
                i += 1;
                continue;
            }
            // ESC at the very end of a read might be the start of one; but it
            // is far more likely to be a real Escape keypress, and delaying it
            // would make Esc feel broken. Forward it.

            if b == PREFIX {
                self.prefix_armed = true;
                i += 1;
                continue;
            }

            forward.push(b);
            i += 1;
        }

        flush(&mut forward, &mut actions);
        actions
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
}
