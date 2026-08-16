//! Compositing and painting.
//!
//! Two steps, deliberately separate:
//!
//!   1. `compose` builds a `Frame` — the whole screen as flat cells — from the
//!      chrome plus whichever pane's grid is active.
//!   2. `Renderer::draw` diffs that frame against the last one and emits only
//!      the escape sequences needed to close the gap.
//!
//! The diff is not an optimisation you add later. Repainting every cell each
//! tick makes the screen shimmer and floods a slow connection, and once the
//! renderer is written to blast full frames it's awkward to retrofit.

use std::io::{self, Write};

use unicode_width::UnicodeWidthChar;

use crate::grid::{Cell, Color, A_BOLD, A_DIM, A_ITALIC, A_REVERSE, A_STRIKE, A_UNDERLINE, WIDE_CONT};
use crate::layout::Layout;
use crate::pane::Pane;

// Chrome palette. 256-colour indices rather than truecolor so this still looks
// right in a console that hasn't been told about 24-bit sequences.
const RAIL_BG: Color = Color::Indexed(235);
const RAIL_FG: Color = Color::Indexed(245);
const RAIL_HEAD_FG: Color = Color::Indexed(109);
const ACTIVE_BG: Color = Color::Indexed(24);
const ACTIVE_FG: Color = Color::Indexed(255);
const DEAD_FG: Color = Color::Indexed(240);
const NEW_FG: Color = Color::Indexed(114);
const DIVIDER_FG: Color = Color::Indexed(238);
const STATUS_BG: Color = Color::Indexed(236);
const STATUS_FG: Color = Color::Indexed(247);
const STATUS_KEY_FG: Color = Color::Indexed(180);

pub struct Frame {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Cell>,
    /// Absolute (row, col) of the hardware cursor, or `None` to hide it.
    pub cursor: Option<(u16, u16)>,
}

impl Frame {
    fn new(cols: u16, rows: u16) -> Self {
        Frame {
            cols,
            rows,
            cells: vec![Cell::default(); cols as usize * rows as usize],
            cursor: None,
        }
    }

    fn put(&mut self, x: u16, y: u16, cell: Cell) {
        if x < self.cols && y < self.rows {
            self.cells[y as usize * self.cols as usize + x as usize] = cell;
        }
    }

    /// Write `text` at (x, y), clipped to `max_w`. Returns the column after the
    /// last glyph written.
    fn text(&mut self, x: u16, y: u16, max_w: u16, s: &str, fg: Color, bg: Color, attrs: u8) -> u16 {
        let mut cx = x;
        let limit = x.saturating_add(max_w).min(self.cols);
        for ch in s.chars() {
            let w = ch.width().unwrap_or(0) as u16;
            if w == 0 {
                continue;
            }
            if cx + w > limit {
                break;
            }
            self.put(cx, y, Cell::styled(ch, fg, bg, attrs));
            if w == 2 {
                self.put(cx + 1, y, Cell::styled(WIDE_CONT, fg, bg, attrs));
            }
            cx += w;
        }
        cx
    }

    fn fill_row(&mut self, x: u16, y: u16, w: u16, bg: Color) {
        for cx in x..(x + w).min(self.cols) {
            self.put(cx, y, Cell::styled(' ', Color::Default, bg, 0));
        }
    }
}

pub fn compose(
    panes: &[Pane],
    active: usize,
    layout: &Layout,
    cols: u16,
    rows: u16,
    pending_prefix: bool,
) -> Frame {
    let mut f = Frame::new(cols, rows);

    draw_rail(&mut f, panes, active, layout);
    draw_divider(&mut f, layout);
    draw_content(&mut f, panes, active, layout);
    draw_status(&mut f, panes, active, layout, pending_prefix);

    f
}

fn draw_rail(f: &mut Frame, panes: &[Pane], active: usize, layout: &Layout) {
    let r = layout.sidebar;

    for y in r.y..r.y + r.h {
        f.fill_row(r.x, y, r.w, RAIL_BG);
    }

    f.text(r.x + 1, r.y, r.w - 1, "TERMINALS", RAIL_HEAD_FG, RAIL_BG, A_BOLD);

    let visible = panes.len().min(layout.max_buttons());
    for (i, pane) in panes.iter().take(visible).enumerate() {
        let y = layout.button_row(i);
        let is_active = i == active;
        let alive = pane.is_alive();

        let (fg, bg, attrs) = match (is_active, alive) {
            (true, _) => (ACTIVE_FG, ACTIVE_BG, A_BOLD),
            (false, true) => (RAIL_FG, RAIL_BG, 0),
            (false, false) => (DEAD_FG, RAIL_BG, 0),
        };

        // Paint the full width first so the active button reads as a solid
        // block rather than a coloured word.
        f.fill_row(r.x, y, r.w, bg);

        let marker = if is_active { "▸" } else { " " };
        let name = pane.display_name();
        let suffix = if alive { "" } else { " (exited)" };
        let label = format!("{marker} {}{}{}", i + 1, format!(": {name}"), suffix);
        f.text(r.x, y, r.w, &label, fg, bg, attrs);
    }

    if panes.len() > visible {
        let y = layout.button_row(visible.saturating_sub(1));
        f.text(r.x, y, r.w, " …more", DEAD_FG, RAIL_BG, 0);
    }

    let ny = layout.new_button_row();
    f.fill_row(r.x, ny, r.w, RAIL_BG);
    f.text(r.x, ny, r.w, "  + new", NEW_FG, RAIL_BG, 0);
}

fn draw_divider(f: &mut Frame, layout: &Layout) {
    for y in layout.sidebar.y..layout.sidebar.y + layout.sidebar.h {
        f.put(
            layout.divider_x,
            y,
            Cell::styled('│', DIVIDER_FG, Color::Default, 0),
        );
    }
}

fn draw_content(f: &mut Frame, panes: &[Pane], active: usize, layout: &Layout) {
    let Some(pane) = panes.get(active) else {
        return;
    };
    let c = layout.content;
    let grid = pane.grid.lock().unwrap();

    let h = (grid.rows as u16).min(c.h);
    let w = (grid.cols as u16).min(c.w);

    for gy in 0..h {
        let row = grid.row(gy as usize);
        for gx in 0..w {
            f.put(c.x + gx, c.y + gy, row[gx as usize]);
        }
    }

    if grid.cursor_visible && pane.is_alive() {
        let (cr, cc) = grid.cursor();
        let (cr, cc) = (cr as u16, cc as u16);
        if cr < c.h && cc < c.w {
            f.cursor = Some((c.y + cr, c.x + cc));
        }
    }
}

fn draw_status(f: &mut Frame, panes: &[Pane], active: usize, layout: &Layout, pending: bool) {
    let s = layout.status;
    f.fill_row(s.x, s.y, s.w, STATUS_BG);

    let live = panes.iter().filter(|p| p.is_alive()).count();
    let left = format!(" mux · {}/{} live · pane {} ", live, panes.len(), active + 1);
    let x = f.text(s.x, s.y, s.w, &left, STATUS_FG, STATUS_BG, A_BOLD);

    if pending {
        // Visible feedback that the prefix was swallowed and we're waiting on
        // the second key — without it a mistyped chord feels like a freeze.
        f.text(x, s.y, s.w - x, "[C-b]", Color::Indexed(232), Color::Indexed(180), A_BOLD);
        return;
    }

    let hints: &[(&str, &str)] = &[
        ("C-b c", "new"),
        ("C-b n/p", "switch"),
        ("C-b x", "close"),
        ("C-b q", "quit"),
    ];
    let mut cx = x;
    for (key, what) in hints {
        if cx + 12 > s.x + s.w {
            break;
        }
        cx = f.text(cx, s.y, s.w.saturating_sub(cx), key, STATUS_KEY_FG, STATUS_BG, 0);
        cx = f.text(
            cx,
            s.y,
            s.w.saturating_sub(cx),
            &format!(" {what}  "),
            STATUS_FG,
            STATUS_BG,
            0,
        );
    }
}

pub struct Renderer {
    prev: Vec<Cell>,
    cols: u16,
    rows: u16,
    out: io::BufWriter<io::Stdout>,
}

impl Renderer {
    pub fn new() -> Self {
        Renderer {
            prev: Vec::new(),
            cols: 0,
            rows: 0,
            // One flush per frame; without the buffer every cell would be its
            // own write syscall.
            out: io::BufWriter::with_capacity(256 * 1024, io::stdout()),
        }
    }

    /// Discard the diff baseline, forcing a full repaint on the next draw.
    pub fn invalidate(&mut self) {
        self.prev.clear();
    }

    pub fn draw(&mut self, frame: &Frame) -> io::Result<()> {
        let full = self.prev.len() != frame.cells.len()
            || self.cols != frame.cols
            || self.rows != frame.rows;

        if full {
            self.prev = vec![
                Cell::styled('\u{1}', Color::Default, Color::Default, 0);
                frame.cells.len()
            ];
            self.cols = frame.cols;
            self.rows = frame.rows;
            self.out.write_all(b"\x1b[0m\x1b[2J")?;
        }

        // Hide the cursor for the duration of the repaint so it doesn't skitter
        // across the screen as cells are written.
        self.out.write_all(b"\x1b[?25l")?;

        let cols = frame.cols as usize;
        let mut pen: Option<Cell> = None;
        let mut at: Option<(u16, u16)> = None;

        for y in 0..frame.rows {
            let mut x: u16 = 0;
            while x < frame.cols {
                let i = y as usize * cols + x as usize;
                let cell = frame.cells[i];

                if cell.ch == WIDE_CONT {
                    x += 1;
                    continue;
                }

                let w = cell.ch.width().unwrap_or(1).max(1) as u16;
                // A wide glyph owns two cells; if either half moved, repaint it.
                let changed = self.prev[i] != cell
                    || (w == 2
                        && i + 1 < frame.cells.len()
                        && self.prev[i + 1] != frame.cells[i + 1]);

                if changed {
                    if at != Some((y, x)) {
                        write!(self.out, "\x1b[{};{}H", y + 1, x + 1)?;
                    }
                    if pen.map(|p| !p.same_style(&cell)).unwrap_or(true) {
                        self.out.write_all(sgr(&cell).as_bytes())?;
                        pen = Some(cell);
                    }

                    let mut b = [0u8; 4];
                    self.out.write_all(cell.ch.encode_utf8(&mut b).as_bytes())?;

                    self.prev[i] = cell;
                    if w == 2 && i + 1 < frame.cells.len() {
                        self.prev[i + 1] = frame.cells[i + 1];
                    }

                    // Auto-wrap is off, so at the right margin the cursor stops
                    // rather than moving — force an explicit reposition.
                    at = if x + w >= frame.cols {
                        None
                    } else {
                        Some((y, x + w))
                    };
                }

                x += w;
            }
        }

        match frame.cursor {
            Some((r, c)) => write!(self.out, "\x1b[{};{}H\x1b[?25h", r + 1, c + 1)?,
            None => self.out.write_all(b"\x1b[?25l")?,
        }

        self.out.flush()
    }
}

fn sgr(cell: &Cell) -> String {
    // Always reset first. Emitting only the delta is fewer bytes but means one
    // dropped sequence corrupts every cell after it.
    let mut s = String::from("\x1b[0");

    if cell.attrs & A_BOLD != 0 {
        s.push_str(";1");
    }
    if cell.attrs & A_DIM != 0 {
        s.push_str(";2");
    }
    if cell.attrs & A_ITALIC != 0 {
        s.push_str(";3");
    }
    if cell.attrs & A_UNDERLINE != 0 {
        s.push_str(";4");
    }
    if cell.attrs & A_REVERSE != 0 {
        s.push_str(";7");
    }
    if cell.attrs & A_STRIKE != 0 {
        s.push_str(";9");
    }

    push_color(&mut s, cell.fg, true);
    push_color(&mut s, cell.bg, false);

    s.push('m');
    s
}

fn push_color(s: &mut String, c: Color, fg: bool) {
    use std::fmt::Write as _;
    match c {
        Color::Default => {}
        Color::Indexed(n) if n < 8 => {
            let _ = write!(s, ";{}", if fg { 30 + n } else { 40 + n });
        }
        Color::Indexed(n) if n < 16 => {
            let _ = write!(s, ";{}", if fg { 90 + (n - 8) } else { 100 + (n - 8) });
        }
        Color::Indexed(n) => {
            let _ = write!(s, ";{};5;{}", if fg { 38 } else { 48 }, n);
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(s, ";{};2;{};{};{}", if fg { 38 } else { 48 }, r, g, b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sgr_round_trips_common_styles() {
        assert_eq!(sgr(&Cell::default()), "\x1b[0m");
        assert_eq!(
            sgr(&Cell::styled('x', Color::Indexed(1), Color::Indexed(2), A_BOLD)),
            "\x1b[0;1;31;42m"
        );
        assert_eq!(
            sgr(&Cell::styled('x', Color::Indexed(9), Color::Default, 0)),
            "\x1b[0;91m"
        );
        assert_eq!(
            sgr(&Cell::styled('x', Color::Indexed(200), Color::Default, 0)),
            "\x1b[0;38;5;200m"
        );
        assert_eq!(
            sgr(&Cell::styled('x', Color::Rgb(1, 2, 3), Color::Default, 0)),
            "\x1b[0;38;2;1;2;3m"
        );
    }

    #[test]
    fn text_clips_at_the_given_width() {
        let mut f = Frame::new(10, 1);
        let end = f.text(0, 0, 4, "abcdefgh", Color::Default, Color::Default, 0);
        assert_eq!(end, 4);
        let row: String = f.cells.iter().map(|c| c.ch).collect();
        assert_eq!(row, "abcd      ");
    }

    #[test]
    fn text_does_not_split_a_wide_glyph_at_the_boundary() {
        let mut f = Frame::new(10, 1);
        // Width 3 can hold one wide glyph but not two.
        let end = f.text(0, 0, 3, "日本", Color::Default, Color::Default, 0);
        assert_eq!(end, 2);
        assert_eq!(f.cells[0].ch, '日');
        assert_eq!(f.cells[1].ch, WIDE_CONT);
        assert_eq!(f.cells[2].ch, ' ');
    }
}
