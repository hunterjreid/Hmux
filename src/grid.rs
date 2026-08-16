//! The terminal emulator hiding inside every multiplexer.
//!
//! A pane cannot be a byte pipe. The moment a pane is hidden, resized, or
//! re-focused you have to *redraw* it, and the only way to do that is to have
//! kept the screen it would have drawn. So each pane owns a `Grid`: a rectangle
//! of styled cells plus a cursor, mutated by the escape sequences the child
//! shell emits.
//!
//! `vte` does the lexing (it's Alacritty's parser, and getting the VT state
//! machine byte-exact is a month you don't want to spend). Everything below is
//! the semantics: what each sequence actually does to the screen.

use unicode_width::UnicodeWidthChar;
use vte::{Params, Perform};

/// Occupies the second column of a double-width character. Never rendered —
/// the renderer skips it, because the wide char before it already covered the
/// space.
pub const WIDE_CONT: char = '\u{0}';

pub const A_BOLD: u8 = 1 << 0;
pub const A_DIM: u8 = 1 << 1;
pub const A_ITALIC: u8 = 1 << 2;
pub const A_UNDERLINE: u8 = 1 << 3;
pub const A_REVERSE: u8 = 1 << 4;
pub const A_STRIKE: u8 = 1 << 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Color {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Cell {
    pub ch: char,
    pub fg: Color,
    pub bg: Color,
    pub attrs: u8,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            ch: ' ',
            fg: Color::Default,
            bg: Color::Default,
            attrs: 0,
        }
    }
}

impl Cell {
    pub fn styled(ch: char, fg: Color, bg: Color, attrs: u8) -> Self {
        Cell { ch, fg, bg, attrs }
    }

    /// True when only the glyph differs from `other` — lets the renderer keep
    /// its current SGR state instead of re-emitting it.
    pub fn same_style(&self, other: &Cell) -> bool {
        self.fg == other.fg && self.bg == other.bg && self.attrs == other.attrs
    }
}

/// One screen buffer. A grid owns two of these: the normal screen and the
/// alternate screen that full-screen apps switch to.
#[derive(Clone)]
struct Screen {
    rows: Vec<Vec<Cell>>,
    cursor_row: usize,
    cursor_col: usize,
}

pub struct Grid {
    pub cols: usize,
    pub rows: usize,

    screen: Screen,
    alt: Option<Screen>,

    /// Current SGR state. The `ch` field is unused; only the styling matters.
    pen: Cell,
    saved_cursor: (usize, usize, Cell),

    scroll_top: usize,
    scroll_bot: usize,

    pub cursor_visible: bool,
    autowrap: bool,
    origin_mode: bool,
    /// DEC deferred wrap: after printing in the last column the cursor stays
    /// put and *the next* printable char wraps. Getting this wrong is why naive
    /// emulators scroll a line early on full-width output.
    wrap_pending: bool,

    tabs: Vec<bool>,
    pub title: String,

    /// Scrollback, oldest first. Not rendered yet — it exists so `scroll_up`
    /// has somewhere to put evicted lines, which is the part that's painful to
    /// retrofit later.
    pub scrollback: std::collections::VecDeque<Vec<Cell>>,
    scrollback_limit: usize,

    /// Responses owed to the child (cursor position reports, device attributes).
    /// The pane drains this and writes it back to the pty. Programs that query
    /// and get no answer will hang, so this is not optional.
    reply: Vec<u8>,
}

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        Grid {
            cols,
            rows,
            screen: Screen {
                rows: vec![vec![Cell::default(); cols]; rows],
                cursor_row: 0,
                cursor_col: 0,
            },
            alt: None,
            pen: Cell::default(),
            saved_cursor: (0, 0, Cell::default()),
            scroll_top: 0,
            scroll_bot: rows - 1,
            cursor_visible: true,
            autowrap: true,
            origin_mode: false,
            wrap_pending: false,
            tabs: default_tabs(cols),
            title: String::new(),
            scrollback: std::collections::VecDeque::new(),
            scrollback_limit: 2000,
            reply: Vec::new(),
        }
    }

    pub fn cursor(&self) -> (usize, usize) {
        (self.screen.cursor_row, self.screen.cursor_col)
    }

    pub fn row(&self, r: usize) -> &[Cell] {
        &self.screen.rows[r]
    }

    pub fn take_reply(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.reply)
    }

    pub fn on_alt_screen(&self) -> bool {
        self.alt.is_some()
    }

    /// Resize the visible area. Lines are truncated/padded rather than reflowed
    /// — reflowing wrapped lines is a genuinely hard problem that even tmux
    /// mostly declines to solve.
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }

        resize_screen(&mut self.screen, cols, rows);
        if let Some(alt) = self.alt.as_mut() {
            resize_screen(alt, cols, rows);
        }

        self.cols = cols;
        self.rows = rows;
        self.scroll_top = 0;
        self.scroll_bot = rows - 1;
        self.tabs = default_tabs(cols);
        self.wrap_pending = false;
    }

    fn blank(&self) -> Cell {
        // Erasing paints the *current* background, which is how a program can
        // paint a coloured region by setting bg and clearing to end of line.
        Cell {
            ch: ' ',
            fg: Color::Default,
            bg: self.pen.bg,
            attrs: 0,
        }
    }

    // ---- cursor movement -------------------------------------------------

    fn set_cursor(&mut self, row: usize, col: usize) {
        self.screen.cursor_row = row.min(self.rows.saturating_sub(1));
        self.screen.cursor_col = col.min(self.cols.saturating_sub(1));
        self.wrap_pending = false;
    }

    fn move_rel(&mut self, dr: isize, dc: isize) {
        let r = (self.screen.cursor_row as isize + dr).clamp(0, self.rows as isize - 1) as usize;
        let c = (self.screen.cursor_col as isize + dc).clamp(0, self.cols as isize - 1) as usize;
        self.set_cursor(r, c);
    }

    fn cr(&mut self) {
        self.screen.cursor_col = 0;
        self.wrap_pending = false;
    }

    /// Line feed / index: down one, scrolling the region if we're at its bottom.
    fn lf(&mut self) {
        if self.screen.cursor_row == self.scroll_bot {
            self.scroll_up(1);
        } else if self.screen.cursor_row + 1 < self.rows {
            self.screen.cursor_row += 1;
        }
        self.wrap_pending = false;
    }

    /// Reverse index: up one, scrolling the region down at its top.
    fn ri(&mut self) {
        if self.screen.cursor_row == self.scroll_top {
            self.scroll_down(1);
        } else if self.screen.cursor_row > 0 {
            self.screen.cursor_row -= 1;
        }
        self.wrap_pending = false;
    }

    fn tab(&mut self) {
        let mut c = self.screen.cursor_col + 1;
        while c < self.cols && !self.tabs[c] {
            c += 1;
        }
        self.screen.cursor_col = c.min(self.cols - 1);
        self.wrap_pending = false;
    }

    // ---- scrolling -------------------------------------------------------

    fn scroll_up(&mut self, n: usize) {
        let blank = self.blank();
        let cols = self.cols;
        for _ in 0..n {
            let line = self.screen.rows.remove(self.scroll_top);
            // Only the normal screen accumulates history, and only when the
            // region starts at the top — a scroll region mid-screen is an app
            // animating, not output flowing past.
            if self.alt.is_none() && self.scroll_top == 0 {
                self.scrollback.push_back(line);
                while self.scrollback.len() > self.scrollback_limit {
                    self.scrollback.pop_front();
                }
            }
            self.screen.rows.insert(self.scroll_bot, vec![blank; cols]);
        }
    }

    fn scroll_down(&mut self, n: usize) {
        let blank = self.blank();
        let cols = self.cols;
        for _ in 0..n {
            self.screen.rows.remove(self.scroll_bot);
            self.screen.rows.insert(self.scroll_top, vec![blank; cols]);
        }
    }

    // ---- erasing / editing ----------------------------------------------

    fn erase_in_line(&mut self, mode: u16) {
        let blank = self.blank();
        let (r, c) = (self.screen.cursor_row, self.screen.cursor_col);
        let cols = self.cols;
        let row = &mut self.screen.rows[r];
        match mode {
            0 => row[c..cols].fill(blank),
            1 => row[..=c.min(cols - 1)].fill(blank),
            2 => row.fill(blank),
            _ => {}
        }
    }

    fn erase_in_display(&mut self, mode: u16) {
        let blank = self.blank();
        let (r, c) = (self.screen.cursor_row, self.screen.cursor_col);
        let (rows, cols) = (self.rows, self.cols);
        match mode {
            0 => {
                self.screen.rows[r][c..cols].fill(blank);
                for row in &mut self.screen.rows[r + 1..rows] {
                    row.fill(blank);
                }
            }
            1 => {
                for row in &mut self.screen.rows[..r] {
                    row.fill(blank);
                }
                self.screen.rows[r][..=c.min(cols - 1)].fill(blank);
            }
            2 | 3 => {
                for row in &mut self.screen.rows {
                    row.fill(blank);
                }
                if mode == 3 {
                    self.scrollback.clear();
                }
            }
            _ => {}
        }
    }

    fn insert_lines(&mut self, n: usize) {
        let r = self.screen.cursor_row;
        if r < self.scroll_top || r > self.scroll_bot {
            return;
        }
        let blank = self.blank();
        let cols = self.cols;
        for _ in 0..n.min(self.scroll_bot - r + 1) {
            self.screen.rows.remove(self.scroll_bot);
            self.screen.rows.insert(r, vec![blank; cols]);
        }
    }

    fn delete_lines(&mut self, n: usize) {
        let r = self.screen.cursor_row;
        if r < self.scroll_top || r > self.scroll_bot {
            return;
        }
        let blank = self.blank();
        let cols = self.cols;
        for _ in 0..n.min(self.scroll_bot - r + 1) {
            self.screen.rows.remove(r);
            self.screen.rows.insert(self.scroll_bot, vec![blank; cols]);
        }
    }

    fn insert_chars(&mut self, n: usize) {
        let blank = self.blank();
        let (r, c) = (self.screen.cursor_row, self.screen.cursor_col);
        let cols = self.cols;
        let row = &mut self.screen.rows[r];
        for _ in 0..n.min(cols - c) {
            row.pop();
            row.insert(c, blank);
        }
        debug_assert_eq!(row.len(), cols);
    }

    fn delete_chars(&mut self, n: usize) {
        let blank = self.blank();
        let (r, c) = (self.screen.cursor_row, self.screen.cursor_col);
        let cols = self.cols;
        let row = &mut self.screen.rows[r];
        for _ in 0..n.min(cols - c) {
            row.remove(c);
            row.push(blank);
        }
        debug_assert_eq!(row.len(), cols);
    }

    fn erase_chars(&mut self, n: usize) {
        let blank = self.blank();
        let (r, c) = (self.screen.cursor_row, self.screen.cursor_col);
        let end = (c + n).min(self.cols);
        self.screen.rows[r][c..end].fill(blank);
    }

    // ---- modes -----------------------------------------------------------

    fn enter_alt_screen(&mut self) {
        if self.alt.is_some() {
            return;
        }
        let fresh = Screen {
            rows: vec![vec![Cell::default(); self.cols]; self.rows],
            cursor_row: 0,
            cursor_col: 0,
        };
        self.alt = Some(std::mem::replace(&mut self.screen, fresh));
    }

    fn leave_alt_screen(&mut self) {
        if let Some(normal) = self.alt.take() {
            self.screen = normal;
        }
    }

    fn set_mode(&mut self, private: bool, mode: u16, on: bool) {
        if !private {
            return;
        }
        match mode {
            6 => {
                self.origin_mode = on;
                self.set_cursor(if on { self.scroll_top } else { 0 }, 0);
            }
            7 => self.autowrap = on,
            25 => self.cursor_visible = on,
            1047 | 1049 => {
                if on {
                    if mode == 1049 {
                        self.saved_cursor =
                            (self.screen.cursor_row, self.screen.cursor_col, self.pen);
                    }
                    self.enter_alt_screen();
                } else {
                    self.leave_alt_screen();
                    if mode == 1049 {
                        let (r, c, pen) = self.saved_cursor;
                        self.pen = pen;
                        self.set_cursor(r, c);
                    }
                }
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        *self = Grid::new(cols, rows);
    }

    // ---- SGR -------------------------------------------------------------

    fn sgr(&mut self, params: &Params) {
        let groups: Vec<&[u16]> = params.iter().collect();
        if groups.is_empty() {
            self.pen = Cell::default();
            return;
        }

        let mut i = 0;
        while i < groups.len() {
            let g = groups[i];
            let p = g.first().copied().unwrap_or(0);

            match p {
                0 => self.pen = Cell::default(),
                1 => self.pen.attrs |= A_BOLD,
                2 => self.pen.attrs |= A_DIM,
                3 => self.pen.attrs |= A_ITALIC,
                4 => self.pen.attrs |= A_UNDERLINE,
                7 => self.pen.attrs |= A_REVERSE,
                9 => self.pen.attrs |= A_STRIKE,
                22 => self.pen.attrs &= !(A_BOLD | A_DIM),
                23 => self.pen.attrs &= !A_ITALIC,
                24 => self.pen.attrs &= !A_UNDERLINE,
                27 => self.pen.attrs &= !A_REVERSE,
                29 => self.pen.attrs &= !A_STRIKE,
                30..=37 => self.pen.fg = Color::Indexed((p - 30) as u8),
                39 => self.pen.fg = Color::Default,
                40..=47 => self.pen.bg = Color::Indexed((p - 40) as u8),
                49 => self.pen.bg = Color::Default,
                90..=97 => self.pen.fg = Color::Indexed((p - 90 + 8) as u8),
                100..=107 => self.pen.bg = Color::Indexed((p - 100 + 8) as u8),
                38 | 48 => {
                    // Two spellings exist: `38;5;n` spreads over separate
                    // params, `38:5:n` arrives as one group of subparams.
                    let color = if g.len() > 1 {
                        parse_extended(&g[1..]).map(|c| c.0)
                    } else {
                        let rest: Vec<u16> =
                            groups[i + 1..].iter().filter_map(|s| s.first().copied()).collect();
                        match parse_extended(&rest) {
                            Some((c, used)) => {
                                i += used;
                                Some(c)
                            }
                            None => None,
                        }
                    };
                    if let Some(c) = color {
                        if p == 38 {
                            self.pen.fg = c;
                        } else {
                            self.pen.bg = c;
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }
}

/// `5;n` → indexed, `2;r;g;b` → truecolor. Returns the colour and how many
/// params it consumed after the leading 38/48.
fn parse_extended(rest: &[u16]) -> Option<(Color, usize)> {
    match rest.first().copied()? {
        5 => Some((Color::Indexed(*rest.get(1)? as u8), 2)),
        2 => {
            let r = *rest.get(1)? as u8;
            let g = *rest.get(2)? as u8;
            let b = *rest.get(3)? as u8;
            Some((Color::Rgb(r, g, b), 4))
        }
        _ => None,
    }
}

fn default_tabs(cols: usize) -> Vec<bool> {
    (0..cols).map(|c| c % 8 == 0 && c != 0).collect()
}

fn resize_screen(s: &mut Screen, cols: usize, rows: usize) {
    for row in s.rows.iter_mut() {
        row.resize(cols, Cell::default());
    }
    if rows < s.rows.len() {
        // Shrinking: drop from the top, so the most recent output — the prompt
        // the user is looking at — survives.
        let drop = s.rows.len() - rows;
        s.rows.drain(..drop);
        s.cursor_row = s.cursor_row.saturating_sub(drop);
    } else {
        s.rows
            .resize(rows, vec![Cell::default(); cols]);
    }
    s.cursor_row = s.cursor_row.min(rows - 1);
    s.cursor_col = s.cursor_col.min(cols - 1);
}

/// First param with an implicit default of 0 — for sequences like ED/EL where
/// "no parameter" and "0" mean the same thing.
fn mode_arg(params: &Params) -> u16 {
    params
        .iter()
        .next()
        .and_then(|g| g.first().copied())
        .unwrap_or(0)
}

/// Helper: first param or a default, since `CSI A` and `CSI 1 A` mean the same.
fn arg(params: &Params, idx: usize, default: u16) -> u16 {
    let v = params
        .iter()
        .nth(idx)
        .and_then(|g| g.first().copied())
        .unwrap_or(0);
    if v == 0 {
        default
    } else {
        v
    }
}

impl Perform for Grid {
    fn print(&mut self, c: char) {
        let w = c.width().unwrap_or(0);
        if w == 0 {
            // Combining marks would need to attach to the previous cell; v0
            // drops them rather than corrupting the grid.
            return;
        }

        if self.wrap_pending {
            self.cr();
            self.lf();
            self.wrap_pending = false;
        }

        if self.screen.cursor_col + w > self.cols {
            if self.autowrap {
                self.cr();
                self.lf();
            } else {
                self.screen.cursor_col = self.cols - w;
            }
        }

        let (r, c0) = (self.screen.cursor_row, self.screen.cursor_col);
        self.screen.rows[r][c0] = Cell::styled(c, self.pen.fg, self.pen.bg, self.pen.attrs);
        if w == 2 && c0 + 1 < self.cols {
            self.screen.rows[r][c0 + 1] =
                Cell::styled(WIDE_CONT, self.pen.fg, self.pen.bg, self.pen.attrs);
        }

        if c0 + w >= self.cols {
            self.screen.cursor_col = self.cols - 1;
            self.wrap_pending = self.autowrap;
        } else {
            self.screen.cursor_col = c0 + w;
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => {}         // BEL — swallowed; a bell per pane is a menace
            0x08 => {
                // Backspace only moves; the shell sends an explicit erase after.
                if self.screen.cursor_col > 0 {
                    self.screen.cursor_col -= 1;
                }
                self.wrap_pending = false;
            }
            0x09 => self.tab(),
            0x0A | 0x0B | 0x0C => self.lf(),
            0x0D => self.cr(),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        let private = intermediates.first() == Some(&b'?');

        match action {
            'A' => self.move_rel(-(arg(params, 0, 1) as isize), 0),
            'B' | 'e' => self.move_rel(arg(params, 0, 1) as isize, 0),
            'C' | 'a' => self.move_rel(0, arg(params, 0, 1) as isize),
            'D' => self.move_rel(0, -(arg(params, 0, 1) as isize)),
            'E' => {
                self.move_rel(arg(params, 0, 1) as isize, 0);
                self.cr();
            }
            'F' => {
                self.move_rel(-(arg(params, 0, 1) as isize), 0);
                self.cr();
            }
            'G' | '`' => {
                let c = arg(params, 0, 1).saturating_sub(1) as usize;
                let r = self.screen.cursor_row;
                self.set_cursor(r, c);
            }
            'd' => {
                let r = arg(params, 0, 1).saturating_sub(1) as usize;
                let c = self.screen.cursor_col;
                self.set_cursor(r, c);
            }
            'H' | 'f' => {
                let mut r = arg(params, 0, 1).saturating_sub(1) as usize;
                let c = arg(params, 1, 1).saturating_sub(1) as usize;
                if self.origin_mode {
                    r += self.scroll_top;
                }
                self.set_cursor(r, c);
            }
            // ED/EL default to 0, not 1, so they can't use `arg`.
            'J' => self.erase_in_display(mode_arg(params)),
            'K' => self.erase_in_line(mode_arg(params)),
            'L' => self.insert_lines(arg(params, 0, 1) as usize),
            'M' => self.delete_lines(arg(params, 0, 1) as usize),
            'P' => self.delete_chars(arg(params, 0, 1) as usize),
            '@' => self.insert_chars(arg(params, 0, 1) as usize),
            'X' => self.erase_chars(arg(params, 0, 1) as usize),
            'S' => self.scroll_up(arg(params, 0, 1) as usize),
            'T' => self.scroll_down(arg(params, 0, 1) as usize),
            'm' => self.sgr(params),
            'r' => {
                let top = arg(params, 0, 1).saturating_sub(1) as usize;
                let bot = arg(params, 1, self.rows as u16).saturating_sub(1) as usize;
                if top < bot && bot < self.rows {
                    self.scroll_top = top;
                    self.scroll_bot = bot;
                    self.set_cursor(if self.origin_mode { top } else { 0 }, 0);
                }
            }
            'h' => {
                for g in params.iter() {
                    if let Some(&m) = g.first() {
                        self.set_mode(private, m, true);
                    }
                }
            }
            'l' => {
                for g in params.iter() {
                    if let Some(&m) = g.first() {
                        self.set_mode(private, m, false);
                    }
                }
            }
            's' => self.saved_cursor = (self.screen.cursor_row, self.screen.cursor_col, self.pen),
            'u' => {
                let (r, c, pen) = self.saved_cursor;
                self.pen = pen;
                self.set_cursor(r, c);
            }
            'n' => {
                // Device Status Report. A program that asks and never hears
                // back will sit there forever, so we must answer.
                if arg(params, 0, 0) == 6 {
                    let (r, c) = (self.screen.cursor_row + 1, self.screen.cursor_col + 1);
                    self.reply
                        .extend_from_slice(format!("\x1b[{};{}R", r, c).as_bytes());
                }
            }
            'c' => {
                // Device Attributes: claim to be a VT102.
                self.reply.extend_from_slice(b"\x1b[?6c");
            }
            'g' => {
                match arg(params, 0, 0) {
                    3 => self.tabs.iter_mut().for_each(|t| *t = false),
                    _ => {
                        let c = self.screen.cursor_col;
                        self.tabs[c] = false;
                    }
                }
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        if !intermediates.is_empty() {
            return; // charset designators and friends — safely ignorable
        }
        match byte {
            b'D' => self.lf(),
            b'E' => {
                self.cr();
                self.lf();
            }
            b'M' => self.ri(),
            b'H' => {
                let c = self.screen.cursor_col;
                self.tabs[c] = true;
            }
            b'7' => self.saved_cursor = (self.screen.cursor_row, self.screen.cursor_col, self.pen),
            b'8' => {
                let (r, c, pen) = self.saved_cursor;
                self.pen = pen;
                self.set_cursor(r, c);
            }
            b'c' => self.reset(),
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        // OSC 0 / OSC 2 set the window title, which we show in the pane header.
        let Some(&kind) = params.first() else { return };
        if kind == b"0" || kind == b"2" {
            if let Some(&title) = params.get(1) {
                self.title = String::from_utf8_lossy(title).trim().to_string();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vte::Parser;

    fn feed(g: &mut Grid, s: &str) {
        let mut p = Parser::new();
        p.advance(g, s.as_bytes());
    }

    fn line(g: &Grid, r: usize) -> String {
        g.row(r).iter().map(|c| c.ch).collect::<String>().trim_end().to_string()
    }

    #[test]
    fn prints_and_wraps_at_the_right_moment() {
        let mut g = Grid::new(5, 3);
        feed(&mut g, "abcde");
        // Deferred wrap: the grid is full but we have NOT moved to row 1 yet.
        assert_eq!(line(&g, 0), "abcde");
        assert_eq!(g.cursor(), (0, 4));
        feed(&mut g, "f");
        assert_eq!(line(&g, 1), "f");
    }

    #[test]
    fn cursor_addressing_is_one_based() {
        let mut g = Grid::new(10, 5);
        feed(&mut g, "\x1b[3;4Hx");
        assert_eq!(g.row(2)[3].ch, 'x');
    }

    #[test]
    fn erase_in_line_paints_current_background() {
        let mut g = Grid::new(6, 2);
        feed(&mut g, "abcdef\x1b[1;3H\x1b[41m\x1b[K");
        assert_eq!(line(&g, 0), "ab");
        assert_eq!(g.row(0)[4].bg, Color::Indexed(1));
    }

    #[test]
    fn scrolling_pushes_lines_into_scrollback() {
        let mut g = Grid::new(6, 2);
        feed(&mut g, "one\r\ntwo\r\nthree");
        assert_eq!(line(&g, 0), "two");
        assert_eq!(line(&g, 1), "three");
        assert_eq!(g.scrollback.len(), 1);
        let evicted: String = g.scrollback[0].iter().map(|c| c.ch).collect();
        assert_eq!(evicted.trim_end(), "one");
    }

    #[test]
    fn a_wrapped_line_costs_a_second_scroll() {
        let mut g = Grid::new(4, 2);
        feed(&mut g, "one\r\ntwo\r\nthree");
        // "three" does not fit in 4 columns, so it wraps onto a new line and
        // scrolls a second time — "two" goes to history too.
        assert_eq!(line(&g, 0), "thre");
        assert_eq!(line(&g, 1), "e");
        assert_eq!(g.scrollback.len(), 2);
    }

    #[test]
    fn alt_screen_output_never_reaches_scrollback() {
        let mut g = Grid::new(6, 2);
        feed(&mut g, "\x1b[?1049h");
        feed(&mut g, "a\r\nb\r\nc\r\nd");
        assert!(g.scrollback.is_empty());
    }

    #[test]
    fn sgr_truecolor_both_spellings() {
        let mut g = Grid::new(4, 1);
        feed(&mut g, "\x1b[38;2;10;20;30ma");
        assert_eq!(g.row(0)[0].fg, Color::Rgb(10, 20, 30));
        feed(&mut g, "\x1b[38:5:200mb");
        assert_eq!(g.row(0)[1].fg, Color::Indexed(200));
    }

    #[test]
    fn cursor_position_report_is_answered() {
        let mut g = Grid::new(10, 10);
        feed(&mut g, "\x1b[2;5H\x1b[6n");
        assert_eq!(g.take_reply(), b"\x1b[2;5R");
    }

    #[test]
    fn alt_screen_round_trips() {
        let mut g = Grid::new(6, 2);
        feed(&mut g, "normal\x1b[?1049h");
        assert_eq!(line(&g, 0), "");
        feed(&mut g, "\x1b[?1049l");
        assert_eq!(line(&g, 0), "normal");
    }

    #[test]
    fn delete_and_insert_chars_keep_row_width() {
        let mut g = Grid::new(6, 1);
        feed(&mut g, "abcdef\x1b[1;2H\x1b[2P");
        assert_eq!(line(&g, 0), "adef");
        assert_eq!(g.row(0).len(), 6);
        feed(&mut g, "\x1b[2@");
        assert_eq!(g.row(0).len(), 6);
    }

    #[test]
    fn resize_keeps_recent_output() {
        let mut g = Grid::new(10, 4);
        feed(&mut g, "a\r\nb\r\nc\r\nd");
        g.resize(10, 2);
        assert_eq!(line(&g, 0), "c");
        assert_eq!(line(&g, 1), "d");
    }
}
