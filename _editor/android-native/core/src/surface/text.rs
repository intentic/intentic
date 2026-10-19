//! A transcript row shaped for drawing: its text broken into lines by cosmic-text at the column's width, and the
//! rectangles drawn under it (a prompt's bubble, a fenced block's lines, inline code, link underlines), placed the
//! way arm A's `RowView` and `Rows.kt` place them.

use super::style::{self, CARD, CONTENT, LineMarks, MUTED, Style};
use crate::render::render;
use crate::transcript::{Role, Row};
use glyphon::cosmic_text::{
    Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, Style as Slant, UnderlineStyle,
    Weight, fontdb,
};

/// Android's line spacing in arm A: Roboto's ascent and descent (1900 + 500 of 2048 units) times 1.25.
const LINE_HEIGHT: f32 = (2400.0 / 2048.0) * 1.25;
/// Marks a glyph's `metadata` as inline code; the low 32 bits are its background.
const CODE_BACKGROUND: usize = 1 << 32;
/// A prompt's bubble is at most this share of the column, as in arm A.
const USER_SHARE: f32 = 0.82;

/// The fonts the transcript draws with. On Android only the three files it needs are read from `/system/fonts`:
/// Roboto (the body; on Android 12 one variable file), Droid Sans Mono (`monospace`) and the subsetted Noto Sans
/// Symbols that holds the box drawing and the tool marks. Loading the whole directory costs every face's tables.
pub(crate) fn fonts() -> FontSystem {
    let mut db = fontdb::Database::new();
    #[cfg(target_os = "android")]
    {
        if let Ok(entries) = std::fs::read_dir("/system/fonts") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("Roboto-")
                    || name == "DroidSansMono.ttf"
                    || name.starts_with("NotoSansSymbols-Regular-Subsetted")
                {
                    let _ = db.load_font_file(entry.path());
                }
            }
        }
        db.set_sans_serif_family("Roboto");
        db.set_monospace_family("Droid Sans Mono");
    }
    #[cfg(not(target_os = "android"))]
    db.load_system_fonts();
    FontSystem::new_with_locale_and_db("en-US".into(), db)
}

/// Shapes a line in every face the transcript uses, so the first frame does not pay for parsing the fonts and
/// building their shaping plans.
pub(crate) fn warm(fonts: &mut FontSystem) {
    let mut buffer = Buffer::new(fonts, Metrics::new(16.0, 20.0));
    let plain = Style::PLAIN;
    let bold = Style {
        bold: true,
        ..plain
    };
    let italic = Style {
        italic: true,
        ..plain
    };
    let mono = Style {
        mono: true,
        ..plain
    };
    let runs = [
        ("Warm — up ", plain),
        ("bold ", bold),
        ("italic ", italic),
        ("code │─┼ ", mono),
        ("◌ ▸ •", plain),
    ];
    buffer.set_rich_text(
        runs.iter().map(|(text, style)| (*text, attrs(style, 16.0))),
        &attrs(&plain, 16.0),
        Shaping::Advanced,
        None,
    );
    buffer.shape_until_scroll(fonts, false);
}

/// An axis-aligned rectangle, rounded at `radius`, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Quad {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub radius: f32,
    /// ARGB.
    pub color: u32,
}

/// Sizes in pixels, from the display's density and the user's font scale.
pub(crate) struct Look {
    body: f32,
    note: f32,
    side: f32,
    gap: f32,
    padding: f32,
    radius: f32,
    stripe: f32,
}

impl Look {
    pub fn new(density: f32, font_scale: f32) -> Self {
        // As arm A's `Look.dp`: a dimension truncated to whole pixels.
        let dp = |value: f32| (value * density).trunc();
        let sp = |value: f32| value * density * font_scale;
        Look {
            body: sp(15.0),
            note: sp(13.0),
            side: dp(16.0),
            gap: dp(8.0),
            padding: dp(12.0),
            radius: dp(14.0),
            stripe: dp(2.0).max(1.0),
        }
    }

    /// The width rows wrap at in a viewport `width` pixels wide.
    pub fn column(&self, width: f32) -> f32 {
        (width - 2.0 * self.side).max(1.0)
    }
}

pub(crate) struct Shaped {
    pub buffer: Buffer,
    /// The whole row, gaps and bubble included.
    pub height: f32,
    /// Where the text's top-left corner sits, from the viewport's left and the row's top.
    pub text_x: f32,
    pub text_y: f32,
    /// The colour of text no span colours.
    pub color: u32,
    /// Drawn under the text, in the row's coordinates.
    pub quads: Vec<Quad>,
}

fn attrs(style: &Style, size: f32) -> Attrs<'static> {
    let mut attrs = Attrs::new().family(if style.mono {
        Family::Monospace
    } else {
        Family::SansSerif
    });
    if style.bold {
        attrs = attrs.weight(Weight::BOLD);
    }
    if style.italic {
        attrs = attrs.style(Slant::Italic);
    }
    if let Some(color) = style.color {
        attrs = attrs.color(Color(color));
    }
    if style.scale != 1.0 {
        let size = size * style.scale;
        attrs = attrs.metrics(Metrics::new(size, (size * LINE_HEIGHT).round()));
    }
    if let Some(background) = style.background {
        attrs = attrs.metadata(CODE_BACKGROUND | background as usize);
    }
    if style.underline {
        attrs = attrs.underline(UnderlineStyle::Single);
    }
    if style.strike {
        attrs = attrs.strikethrough();
    }
    attrs
}

/// Shapes `row` for a viewport `width` pixels wide.
pub(crate) fn shape(fonts: &mut FontSystem, look: &Look, width: f32, row: &Row) -> Shaped {
    let rendered = render(row);
    let styled = style::styled(&rendered);
    let (size, color) = match row.role {
        Role::Notice => (look.note, MUTED),
        _ => (look.body, CONTENT),
    };
    let column = look.column(width);
    let user = row.role == Role::User;
    let wrap = if user {
        ((width - 2.0 * look.side) * USER_SHARE).trunc() - 2.0 * look.padding
    } else {
        column
    };

    let mut buffer = Buffer::new(fonts, Metrics::new(size, (size * LINE_HEIGHT).round()));
    buffer.set_size(Some(wrap.max(1.0)), None);
    let base = attrs(&Style::PLAIN, size).color(Color(color));
    buffer.set_rich_text(
        styled
            .runs
            .iter()
            .map(|(range, style)| (&rendered.text[range.clone()], attrs(style, size))),
        &base,
        Shaping::Advanced,
        None,
    );
    buffer.shape_until_scroll(fonts, false);

    // Under the text, in the text's own coordinates until the row is placed below.
    let mut under: Vec<Quad> = Vec::new();
    let mut text_height: f32 = 0.0;
    let mut widest: f32 = 0.0;
    let mut last_block: Option<usize> = None;
    for run in buffer.layout_runs() {
        text_height = text_height.max(run.line_top + run.line_height);
        widest = widest.max(run.line_w);
        let marks = styled
            .lines
            .get(run.line_i)
            .copied()
            .unwrap_or(LineMarks::default());
        if let Some(block) = marks.block {
            // One rectangle for the block's consecutive lines: abutting ones would show their seams.
            match last_block.and_then(|at| under.get_mut(at)) {
                Some(quad)
                    if quad.color == block && (quad.y + quad.h - run.line_top).abs() < 0.5 =>
                {
                    quad.h = run.line_top + run.line_height - quad.y;
                }
                _ => {
                    last_block = Some(under.len());
                    under.push(Quad {
                        x: 0.0,
                        y: run.line_top,
                        w: wrap,
                        h: run.line_height,
                        radius: 0.0,
                        color: block,
                    });
                }
            }
        }
        if marks.quote {
            under.push(Quad {
                x: -look.side / 2.0,
                y: run.line_top,
                w: look.stripe,
                h: run.line_height,
                radius: 0.0,
                color: MUTED,
            });
        }
        // Inline code: one rectangle per stretch of glyphs with the same background.
        let mut stretches: Vec<(usize, f32, f32)> = Vec::new();
        for glyph in run.glyphs {
            if glyph.metadata & CODE_BACKGROUND == 0 {
                continue;
            }
            match stretches.last_mut() {
                Some((open, _, right))
                    if *open == glyph.metadata && (glyph.x - *right).abs() < 0.5 =>
                {
                    *right = glyph.x + glyph.w;
                }
                _ => stretches.push((glyph.metadata, glyph.x, glyph.x + glyph.w)),
            }
        }
        for (code, left, right) in stretches {
            under.push(Quad {
                x: left,
                y: run.line_top,
                w: right - left,
                h: run.line_height,
                radius: 0.0,
                color: (code & 0xFFFF_FFFF) as u32,
            });
        }
        for span in run.decorations {
            let glyphs = &run.glyphs[span.glyph_range.clone()];
            let left = glyphs
                .iter()
                .map(|glyph| glyph.x)
                .fold(f32::INFINITY, f32::min);
            let right = glyphs
                .iter()
                .map(|glyph| glyph.x + glyph.w)
                .fold(f32::NEG_INFINITY, f32::max);
            if right <= left {
                continue;
            }
            let decoration = &span.data;
            let line_color = span.color_opt.map_or(color, |color| color.0);
            let mut line = |metrics: glyphon::cosmic_text::DecorationMetrics| {
                under.push(Quad {
                    x: left,
                    y: run.line_y - metrics.offset * span.font_size,
                    w: right - left,
                    h: (metrics.thickness * span.font_size).max(1.0).ceil(),
                    radius: 0.0,
                    color: line_color,
                });
            };
            if decoration.text_decoration.underline != UnderlineStyle::None {
                line(decoration.underline_metrics);
            }
            if decoration.text_decoration.strikethrough {
                line(decoration.strikethrough_metrics);
            }
        }
    }

    let (text_x, text_y, height, mut quads) = if user {
        let bubble_width = widest.ceil() + 2.0 * look.padding;
        let left = width - look.side - bubble_width;
        let bubble = Quad {
            x: left,
            y: look.gap,
            w: bubble_width,
            h: text_height + 2.0 * look.padding,
            radius: look.radius,
            color: CARD,
        };
        (
            left + look.padding,
            look.gap + look.padding,
            text_height + 2.0 * look.padding + 2.0 * look.gap,
            vec![bubble],
        )
    } else {
        (
            look.side,
            look.gap,
            text_height + 2.0 * look.gap,
            Vec::new(),
        )
    };
    quads.extend(under.into_iter().map(|quad| Quad {
        x: quad.x + text_x,
        y: quad.y + text_y,
        ..quad
    }));
    Shaped {
        buffer,
        height,
        text_x,
        text_y,
        color,
        quads,
    }
}
