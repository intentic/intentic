//! A rendered row (one string, span quads in UTF-16 offsets, nested) turned into what cosmic-text shapes: flat runs
//! of the text, each with one [`Style`], in byte offsets. Spans apply in order and the later one wins, as Android's
//! do in arm A's `Spans.kt`; relative sizes multiply. A fenced block's background covers whole lines, so the lines
//! it touches are listed apart, by line index (the text split at `\n`, as cosmic-text splits it).

use crate::render::{
    Rendered, SPAN_BLOCK, SPAN_BOLD, SPAN_CODE, SPAN_COLOR, SPAN_HEADING, SPAN_ITALIC, SPAN_LINK,
    SPAN_QUOTE, SPAN_STRIKE, SPAN_TABLE, SPAN_TOOL,
};
use std::ops::Range;

/// Colours of the editor's dark look: `res/values/colors.xml`, which arm A draws with.
pub(crate) const CANVAS: u32 = 0xFF_15_17_1C;
pub(crate) const CARD: u32 = 0xFF_22_26_2E;
pub(crate) const CONTENT: u32 = 0xFF_E6_E8_EC;
pub(crate) const MUTED: u32 = 0xFF_8B_93_A1;
pub(crate) const ACCENT: u32 = 0xFF_7A_A2_F7;

const HEADING_SIZES: [f32; 7] = [1.0, 1.5, 1.3, 1.15, 1.05, 1.0, 1.0];
const CODE_SIZE: f32 = 0.88;
const TOOL_SIZE: f32 = 0.9;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Style {
    pub bold: bool,
    pub italic: bool,
    pub mono: bool,
    /// ARGB; `None` draws in the row's own colour.
    pub color: Option<u32>,
    /// Relative to the row's text size.
    pub scale: f32,
    /// Inline code's background, ARGB.
    pub background: Option<u32>,
    pub underline: bool,
    pub strike: bool,
}

impl Style {
    pub const PLAIN: Style = Style {
        bold: false,
        italic: false,
        mono: false,
        color: None,
        scale: 1.0,
        background: None,
        underline: false,
        strike: false,
    };

    fn apply(&mut self, kind: i32, arg: i32) {
        match kind {
            SPAN_BOLD => self.bold = true,
            SPAN_ITALIC => self.italic = true,
            SPAN_CODE => {
                self.mono = true;
                self.background = Some(arg as u32);
            }
            SPAN_BLOCK | SPAN_TABLE => {
                self.mono = true;
                self.scale *= CODE_SIZE;
            }
            SPAN_COLOR => self.color = Some(arg as u32),
            SPAN_LINK => {
                self.color = Some(ACCENT);
                self.underline = true;
            }
            SPAN_HEADING => {
                self.bold = true;
                self.scale *= HEADING_SIZES[arg.clamp(1, 6) as usize];
            }
            SPAN_TOOL => {
                self.color = Some(if arg == 0 { ACCENT } else { MUTED });
                self.scale *= TOOL_SIZE;
            }
            SPAN_STRIKE => self.strike = true,
            _ => {}
        }
    }
}

/// What a line-wide span paints behind each line it touches.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct LineMarks {
    /// A fenced block's background, ARGB.
    pub block: Option<u32>,
    /// Inside a block quote: a stripe in the margin.
    pub quote: bool,
}

pub(crate) struct Styled {
    pub runs: Vec<(Range<usize>, Style)>,
    /// One entry per line of the text.
    pub lines: Vec<LineMarks>,
}

/// The byte offset of each UTF-16 unit of `text`, and one past the end.
fn utf16_to_bytes(text: &str) -> Vec<usize> {
    let mut bytes = Vec::with_capacity(text.len() + 1);
    for (at, ch) in text.char_indices() {
        for _ in 0..ch.len_utf16() {
            bytes.push(at);
        }
    }
    bytes.push(text.len());
    bytes
}

pub(crate) fn styled(rendered: &Rendered) -> Styled {
    let text = &rendered.text;
    let bytes = utf16_to_bytes(text);
    let units = bytes.len() - 1;
    let mut styles = vec![Style::PLAIN; units];
    // Line-wide spans as byte ranges: (start, end, block background or None for a quote).
    let mut wide: Vec<(usize, usize, Option<u32>)> = Vec::new();
    for quad in rendered.spans.as_chunks::<4>().0 {
        let start = (quad[0].max(0) as usize).min(units);
        let end = (quad[1].max(0) as usize).min(units);
        if start >= end {
            continue;
        }
        let (kind, arg) = (quad[2], quad[3]);
        match kind {
            SPAN_BLOCK => wide.push((bytes[start], bytes[end], Some(arg as u32))),
            SPAN_QUOTE => wide.push((bytes[start], bytes[end], None)),
            _ => {}
        }
        for style in &mut styles[start..end] {
            style.apply(kind, arg);
        }
    }

    let mut runs = Vec::new();
    let mut at = 0;
    while at < units {
        let style = styles[at];
        let mut end = at + 1;
        while end < units && styles[end] == style {
            end += 1;
        }
        runs.push((bytes[at]..bytes[end], style));
        at = end;
    }

    let mut lines = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        // The line and its newline, [start, end]: a span touches it if the two overlap.
        let end = start + line.len() + 1;
        let mut marks = LineMarks::default();
        for &(from, to, block) in &wide {
            if from < end && to > start {
                match block {
                    Some(color) => marks.block = Some(color),
                    None => marks.quote = true,
                }
            }
        }
        lines.push(marks);
        start = end;
    }
    Styled { runs, lines }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::render;
    use crate::transcript::{Role, Row};

    fn row(text: &str) -> Rendered {
        render(&Row {
            role: Role::Assistant,
            text: text.into(),
            tools: Vec::new(),
        })
    }

    fn run_texts<'a>(
        rendered: &'a Rendered,
        styled: &Styled,
        wanted: fn(&Style) -> bool,
    ) -> Vec<&'a str> {
        styled
            .runs
            .iter()
            .filter(|(_, style)| wanted(style))
            .map(|(range, _)| &rendered.text[range.clone()])
            .collect()
    }

    #[test]
    fn turns_utf16_spans_into_byte_runs() {
        // The em dash and the arrow are one UTF-16 unit and three bytes each: the runs must cut at bytes.
        let rendered = row("Done — **4 files** → `agent/soft-deletes`");
        let styled = styled(&rendered);
        assert_eq!(
            run_texts(&rendered, &styled, |style| style.bold),
            ["4 files"]
        );
        assert_eq!(
            run_texts(&rendered, &styled, |style| style.mono
                && style.background.is_some()),
            ["agent/soft-deletes"]
        );
        let joined: String = styled
            .runs
            .iter()
            .map(|(range, _)| &rendered.text[range.clone()])
            .collect();
        assert_eq!(
            joined, rendered.text,
            "the runs cover the text once, in order"
        );
    }

    #[test]
    fn marks_every_line_of_a_fenced_block_including_blank_ones() {
        let rendered = row("Before.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.");
        let styled = styled(&rendered);
        let lines: Vec<&str> = rendered.text.split('\n').collect();
        let marked: Vec<&str> = lines
            .iter()
            .zip(&styled.lines)
            .filter(|(_, marks)| marks.block.is_some())
            .map(|(line, _)| *line)
            .collect();
        assert_eq!(marked, ["const a = 1;", "", "const b = 2;"]);
        assert!(
            styled
                .runs
                .iter()
                .any(|(_, style)| style.color.is_some() && style.mono),
            "the block's highlighting colours its text"
        );
    }

    #[test]
    fn later_spans_win_and_sizes_multiply() {
        let mut style = Style::PLAIN;
        style.apply(SPAN_TOOL, 1);
        style.apply(SPAN_COLOR, 0x7F_01_02_03);
        assert_eq!(style.color, Some(0x7F_01_02_03));
        style.apply(SPAN_TABLE, 0);
        assert!((style.scale - TOOL_SIZE * CODE_SIZE).abs() < 1e-6);
    }
}
