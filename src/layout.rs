//! Screen geometry.
//!
//! The shape is a fixed-width button rail down the left, the active terminal
//! filling the rest, and a status line along the bottom:
//!
//! ```text
//! ┌────────────┬──────────────────────────────┐
//! │ ▸ 1 cmd    │                              │
//! │   2 cmd    │   active terminal            │
//! │   3 cmd    │                              │
//! │            │                              │
//! │ + new      │                              │
//! ├────────────┴──────────────────────────────┤
//! │ status                                    │
//! └───────────────────────────────────────────┘
//! ```

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Rect {
    pub fn contains(&self, x: u16, y: u16) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

pub const SIDEBAR_MIN: u16 = 12;
pub const SIDEBAR_MAX: u16 = 40;
/// Row 0 of the rail is a heading; buttons start below it.
pub const RAIL_HEADER_ROWS: u16 = 1;

pub struct Layout {
    /// The button rail, including its heading row.
    pub sidebar: Rect,
    /// Column holding the vertical rule between rail and terminal.
    pub divider_x: u16,
    /// Where the active terminal is drawn — this is also the pty's size.
    pub content: Rect,
    pub status: Rect,
}

pub fn compute(cols: u16, rows: u16, sidebar_w: u16) -> Layout {
    let cols = cols.max(20);
    let rows = rows.max(3);

    let sidebar_w = sidebar_w.clamp(SIDEBAR_MIN, SIDEBAR_MAX).min(cols / 2);
    let body_h = rows - 1; // last row is the status line

    Layout {
        sidebar: Rect {
            x: 0,
            y: 0,
            w: sidebar_w,
            h: body_h,
        },
        divider_x: sidebar_w,
        content: Rect {
            x: sidebar_w + 1,
            y: 0,
            w: cols - sidebar_w - 1,
            h: body_h,
        },
        status: Rect {
            x: 0,
            y: body_h,
            w: cols,
            h: 1,
        },
    }
}

impl Layout {
    /// Screen row for the nth button.
    pub fn button_row(&self, index: usize) -> u16 {
        self.sidebar.y + RAIL_HEADER_ROWS + index as u16
    }

    /// Which button (if any) is under a click. Returns `None` for the heading
    /// row and for empty space below the last button.
    pub fn button_at(&self, x: u16, y: u16, count: usize) -> Option<usize> {
        if !self.sidebar.contains(x, y) || y < self.sidebar.y + RAIL_HEADER_ROWS {
            return None;
        }
        let idx = (y - self.sidebar.y - RAIL_HEADER_ROWS) as usize;
        (idx < count).then_some(idx)
    }

    /// The "+ new" button sits on the last row of the rail.
    pub fn new_button_row(&self) -> u16 {
        self.sidebar.y + self.sidebar.h - 1
    }

    pub fn is_new_button(&self, x: u16, y: u16) -> bool {
        self.sidebar.contains(x, y) && y == self.new_button_row()
    }

    /// How many buttons fit before colliding with the "+ new" row.
    pub fn max_buttons(&self) -> usize {
        self.sidebar.h.saturating_sub(RAIL_HEADER_ROWS + 1) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_and_sidebar_tile_without_overlap() {
        let l = compute(100, 30, 20);
        assert_eq!(l.sidebar.w, 20);
        assert_eq!(l.divider_x, 20);
        assert_eq!(l.content.x, 21);
        assert_eq!(l.content.x + l.content.w, 100);
        assert_eq!(l.status.y, 29);
        assert_eq!(l.sidebar.h, 29);
    }

    #[test]
    fn sidebar_never_eats_more_than_half_the_screen() {
        let l = compute(40, 20, SIDEBAR_MAX);
        assert!(l.sidebar.w <= 20);
        assert!(l.content.w >= 1);
    }

    #[test]
    fn clicks_map_to_buttons() {
        let l = compute(100, 30, 20);
        assert_eq!(l.button_at(5, 0, 3), None); // heading row
        assert_eq!(l.button_at(5, 1, 3), Some(0));
        assert_eq!(l.button_at(5, 3, 3), Some(2));
        assert_eq!(l.button_at(5, 4, 3), None); // past the last button
        assert_eq!(l.button_at(50, 1, 3), None); // in the terminal, not the rail
    }

    #[test]
    fn new_button_is_on_the_last_rail_row() {
        let l = compute(100, 30, 20);
        assert!(l.is_new_button(3, 28));
        assert!(!l.is_new_button(3, 27));
    }
}
