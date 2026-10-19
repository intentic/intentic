//! A transcript row turned into what a text view draws: one string and its styles as flat `[start, end, kind, arg]`
//! quads, offsets in UTF-16 code units (what a Kotlin `String` indexes by). Markdown is parsed with pulldown-cmark,
//! fenced code is highlighted with syntect, tables become aligned monospace text and tool calls a line each.

use crate::transcript::{Row, ToolStatus};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;

// The span kinds. `Spans.kt` in the app holds the same numbers; change both together.
pub const SPAN_BOLD: i32 = 1;
pub const SPAN_ITALIC: i32 = 2;
/// Inline code; `arg` is its background, ARGB.
pub const SPAN_CODE: i32 = 3;
/// A fenced code block's lines; `arg` is its background, ARGB.
pub const SPAN_BLOCK: i32 = 4;
/// A foreground colour, ARGB in `arg`: what highlighting produces.
pub const SPAN_COLOR: i32 = 5;
pub const SPAN_LINK: i32 = 6;
/// `arg` is the heading level, 1 to 6.
pub const SPAN_HEADING: i32 = 7;
/// A table, drawn monospace so its padded columns line up.
pub const SPAN_TABLE: i32 = 8;
/// A tool call's line; `arg` is 0 while it runs, 1 once done.
pub const SPAN_TOOL: i32 = 9;
pub const SPAN_STRIKE: i32 = 10;
pub const SPAN_QUOTE: i32 = 11;

const INLINE_CODE_BACKGROUND: i32 = 0x33_80_80_80_u32 as i32;

pub struct Rendered {
    pub text: String,
    pub spans: Vec<i32>,
}

struct Highlighting {
    syntaxes: SyntaxSet,
    theme: Theme,
}

static HIGHLIGHTING: OnceLock<Highlighting> = OnceLock::new();

fn highlighting() -> &'static Highlighting {
    HIGHLIGHTING.get_or_init(|| {
        let mut themes = ThemeSet::load_defaults();
        let theme = themes
            .themes
            .remove("base16-ocean.dark")
            .unwrap_or_default();
        Highlighting {
            syntaxes: SyntaxSet::load_defaults_newlines(),
            theme,
        }
    })
}

/// Loads the grammars and the theme, tens of milliseconds the first row with code would otherwise pay. The app calls
/// it on a background thread as it starts.
pub fn warm() {
    let _ = highlighting();
}

fn argb(color: syntect::highlighting::Color) -> i32 {
    ((u32::from(color.a) << 24)
        | (u32::from(color.r) << 16)
        | (u32::from(color.g) << 8)
        | u32::from(color.b)) as i32
}

struct Builder {
    text: String,
    utf16: usize,
    spans: Vec<i32>,
    open: Vec<(i32, usize, i32)>,
}

impl Builder {
    fn push(&mut self, piece: &str) {
        self.text.push_str(piece);
        self.utf16 += piece.encode_utf16().count();
    }

    fn span(&mut self, start: usize, end: usize, kind: i32, arg: i32) {
        if end > start {
            self.spans
                .extend_from_slice(&[start as i32, end as i32, kind, arg]);
        }
    }

    fn open(&mut self, kind: i32, arg: i32) {
        self.open.push((kind, self.utf16, arg));
    }

    fn close(&mut self, kind: i32) {
        if let Some(at) = self.open.iter().rposition(|(open, _, _)| *open == kind) {
            let (kind, start, arg) = self.open.remove(at);
            self.span(start, self.utf16, kind, arg);
        }
    }

    /// Starts a block on a line of its own, with a blank line before it unless it is a list item.
    fn block(&mut self, tight: bool) {
        if self.text.is_empty() {
            return;
        }
        let wanted = if tight { "\n" } else { "\n\n" };
        while !self.text.ends_with(wanted) {
            if tight && self.text.ends_with('\n') {
                break;
            }
            self.push("\n");
        }
    }
}

fn level(heading: HeadingLevel) -> i32 {
    match heading {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn language(fence: &str) -> &str {
    // syntect's bundled grammars have no TypeScript; its JavaScript grammar reads the fixture's code the same way.
    match fence {
        "ts" | "tsx" | "typescript" => "js",
        "" => "txt",
        other => other,
    }
}

fn code_block(builder: &mut Builder, fence: &str, code: &str) {
    let highlighting = highlighting();
    let syntax = highlighting
        .syntaxes
        .find_syntax_by_token(language(fence))
        .unwrap_or_else(|| highlighting.syntaxes.find_syntax_plain_text());
    let background = highlighting
        .theme
        .settings
        .background
        .map_or(0xFF_2B_30_3B_u32 as i32, argb);
    let mut lines = HighlightLines::new(syntax, &highlighting.theme);
    let start = builder.utf16;
    for line in syntect::util::LinesWithEndings::from(code) {
        match lines.highlight_line(line, &highlighting.syntaxes) {
            Ok(ranges) => {
                for (style, piece) in ranges {
                    let from = builder.utf16;
                    builder.push(piece);
                    builder.span(from, builder.utf16, SPAN_COLOR, argb(style.foreground));
                }
            }
            Err(_) => builder.push(line),
        }
    }
    while builder.text.ends_with('\n') {
        builder.text.pop();
        builder.utf16 -= 1;
    }
    // The last line's colour ran over the newline just trimmed: end every span at the block's end.
    let end = builder.utf16 as i32;
    for quad in builder.spans.chunks_mut(4) {
        quad[1] = quad[1].min(end);
    }
    let mut kept = Vec::with_capacity(builder.spans.len());
    for quad in builder.spans.chunks(4).filter(|quad| quad[1] > quad[0]) {
        kept.extend_from_slice(quad);
    }
    builder.spans = kept;
    builder.span(start, builder.utf16, SPAN_BLOCK, background);
}

fn table(builder: &mut Builder, rows: &[Vec<String>]) {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![0usize; columns];
    for row in rows {
        for (column, cell) in row.iter().enumerate() {
            widths[column] = widths[column].max(cell.chars().count());
        }
    }
    let start = builder.utf16;
    for (index, row) in rows.iter().enumerate() {
        let line_start = builder.utf16;
        for (column, width) in widths.iter().enumerate() {
            if column > 0 {
                builder.push(" │ ");
            }
            let cell = row.get(column).map_or("", String::as_str);
            builder.push(cell);
            builder.push(&" ".repeat(width - cell.chars().count()));
        }
        if index == 0 {
            builder.span(line_start, builder.utf16, SPAN_BOLD, 0);
            builder.push("\n");
            let rule: Vec<String> = widths.iter().map(|width| "─".repeat(*width)).collect();
            builder.push(&rule.join("─┼─"));
        }
        if index + 1 < rows.len() {
            builder.push("\n");
        }
    }
    builder.span(start, builder.utf16, SPAN_TABLE, 0);
}

/// The row as one string and its spans. The row's role is not in it: the view draws a prompt's bubble itself.
pub fn render(row: &Row) -> Rendered {
    let mut builder = Builder {
        text: String::with_capacity(row.text.len() + 64),
        utf16: 0,
        spans: Vec::new(),
        open: Vec::new(),
    };
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut code: Option<(String, String)> = None;
    let mut cells: Option<Vec<Vec<String>>> = None;
    for event in Parser::new_ext(
        &row.text,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    ) {
        if let Some(rows) = cells.as_mut() {
            match event {
                Event::Start(Tag::TableHead | Tag::TableRow) => rows.push(Vec::new()),
                Event::Start(Tag::TableCell) => {
                    if let Some(row) = rows.last_mut() {
                        row.push(String::new());
                    }
                }
                Event::Text(text) | Event::Code(text) => {
                    if let Some(cell) = rows.last_mut().and_then(|row| row.last_mut()) {
                        cell.push_str(&text);
                    }
                }
                Event::End(TagEnd::Table) => {
                    let rows = cells.take().unwrap_or_default();
                    table(&mut builder, &rows);
                }
                _ => {}
            }
            continue;
        }
        if let Some((_, body)) = code.as_mut() {
            match event {
                Event::Text(text) => body.push_str(&text),
                Event::End(TagEnd::CodeBlock) => {
                    let (fence, body) = code.take().unwrap_or_default();
                    code_block(&mut builder, &fence, &body);
                }
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Paragraph) => builder.block(!lists.is_empty()),
            Event::Start(Tag::Heading { level: heading, .. }) => {
                builder.block(false);
                builder.open(SPAN_HEADING, level(heading));
            }
            Event::End(TagEnd::Heading(_)) => builder.close(SPAN_HEADING),
            Event::Start(Tag::BlockQuote(_)) => {
                builder.block(false);
                builder.open(SPAN_QUOTE, 0);
            }
            Event::End(TagEnd::BlockQuote(_)) => builder.close(SPAN_QUOTE),
            Event::Start(Tag::CodeBlock(kind)) => {
                builder.block(!lists.is_empty());
                let fence = match kind {
                    CodeBlockKind::Fenced(fence) => {
                        fence.split_whitespace().next().unwrap_or("").to_owned()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((fence, String::new()));
            }
            Event::Start(Tag::List(first)) => {
                if lists.is_empty() {
                    builder.block(false);
                }
                lists.push(first);
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                builder.block(true);
                let depth = lists.len().saturating_sub(1);
                builder.push(&"    ".repeat(depth));
                match lists.last_mut() {
                    Some(Some(number)) => {
                        builder.push(&format!("{number}. "));
                        *number += 1;
                    }
                    _ => builder.push("•  "),
                }
            }
            Event::Start(Tag::Table(_)) => {
                builder.block(false);
                cells = Some(Vec::new());
            }
            Event::Start(Tag::Emphasis) => builder.open(SPAN_ITALIC, 0),
            Event::End(TagEnd::Emphasis) => builder.close(SPAN_ITALIC),
            Event::Start(Tag::Strong) => builder.open(SPAN_BOLD, 0),
            Event::End(TagEnd::Strong) => builder.close(SPAN_BOLD),
            Event::Start(Tag::Strikethrough) => builder.open(SPAN_STRIKE, 0),
            Event::End(TagEnd::Strikethrough) => builder.close(SPAN_STRIKE),
            Event::Start(Tag::Link { .. }) => builder.open(SPAN_LINK, 0),
            Event::End(TagEnd::Link) => builder.close(SPAN_LINK),
            Event::Code(text) => {
                let start = builder.utf16;
                builder.push(&text);
                builder.span(start, builder.utf16, SPAN_CODE, INLINE_CODE_BACKGROUND);
            }
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => builder.push(&text),
            Event::SoftBreak => builder.push(" "),
            Event::HardBreak => builder.push("\n"),
            Event::Rule => {
                builder.block(false);
                builder.push("———");
            }
            _ => {}
        }
    }
    for tool in &row.tools {
        builder.block(true);
        let start = builder.utf16;
        let (mark, status) = match tool.status {
            ToolStatus::Running => ("◌ ", 0),
            ToolStatus::Done => ("▸ ", 1),
        };
        builder.push(mark);
        builder.push(&tool.name);
        if !tool.summary.is_empty() {
            builder.push("  ");
            let summary: String = tool.summary.chars().take(64).collect();
            builder.push(&summary);
        }
        builder.span(start, builder.utf16, SPAN_TOOL, status);
    }
    Rendered {
        text: builder.text,
        spans: builder.spans,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{Role, Tool};

    fn row(text: &str) -> Row {
        Row {
            role: Role::Assistant,
            text: text.into(),
            tools: Vec::new(),
        }
    }

    fn spans_of(rendered: &Rendered, kind: i32) -> Vec<String> {
        let units: Vec<u16> = rendered.text.encode_utf16().collect();
        rendered
            .spans
            .chunks(4)
            .filter(|quad| quad[2] == kind)
            .map(|quad| String::from_utf16_lossy(&units[quad[0] as usize..quad[1] as usize]))
            .collect()
    }

    #[test]
    fn styles_inline_markdown_by_utf16_offset() {
        // The em dash and the arrow are one UTF-16 unit each but three UTF-8 bytes: offsets must count the former.
        let rendered = render(&row("Done — **4 files** → `agent/soft-deletes`"));
        assert_eq!(rendered.text, "Done — 4 files → agent/soft-deletes");
        assert_eq!(spans_of(&rendered, SPAN_BOLD), ["4 files"]);
        assert_eq!(spans_of(&rendered, SPAN_CODE), ["agent/soft-deletes"]);
    }

    #[test]
    fn highlights_a_fenced_block_and_aligns_a_table() {
        let rendered = render(&row(
            "| file | change |\n| --- | --- |\n| schema.ts | +3 |\n\n```ts\nconst a = 1;\n```\n",
        ));
        assert_eq!(
            spans_of(&rendered, SPAN_TABLE),
            ["file      │ change\n──────────┼───────\nschema.ts │ +3    "]
        );
        assert_eq!(spans_of(&rendered, SPAN_BLOCK), ["const a = 1;"]);
        assert!(
            spans_of(&rendered, SPAN_COLOR).len() > 2,
            "the keyword, the name and the number are coloured apart"
        );
    }

    #[test]
    fn numbers_ordered_lists_and_draws_tools_on_lines_of_their_own() {
        let mut item = row("1. one\n2. two");
        item.tools.push(Tool {
            name: "Read".into(),
            summary: "{\"path\":\"a.ts\"}".into(),
            status: ToolStatus::Running,
        });
        let rendered = render(&item);
        assert_eq!(rendered.text, "1. one\n2. two\n◌ Read  {\"path\":\"a.ts\"}");
        assert_eq!(
            spans_of(&rendered, SPAN_TOOL),
            ["◌ Read  {\"path\":\"a.ts\"}"]
        );
    }
}
