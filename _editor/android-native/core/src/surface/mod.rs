//! Arm C of the spike: the transcript drawn by the GPU onto an Android `SurfaceView`, from the same conversation and
//! the same `render` output arm A draws with `StaticLayout`s. Kotlin keeps the activity, the composer, touch and the
//! frame clock and calls [`Renderer::frame`] once a frame with its scroll offset; this module lays rows out lazily up
//! from the bottom ([`layout`]), shapes the ones it reaches with cosmic-text ([`text`]), keeps those near the
//! viewport, and draws them with wgpu and glyphon ([`gpu`]). Built only with the `surface` feature; off Android
//! nothing calls in, and only the tests run it.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

#[cfg(target_os = "android")]
mod android;
mod gpu;
mod layout;
mod style;
mod text;

use crate::Shared;
use glyphon::cosmic_text::{Color, FontSystem};
use glyphon::{SwashCache, TextArea, TextBounds};
use std::collections::HashMap;
use std::sync::Mutex;
use text::{Quad, Shaped};

/// Rows kept shaped on either side of those on screen, so scrolling back does not shape them again.
const KEEP: usize = 12;

/// Runs `work` inside a named trace section, which Perfetto shows under the Kotlin `spike.surface.frame`.
fn traced<T>(name: &str, work: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "android")]
    let _section = ndk::trace::Section::new(name).ok();
    #[cfg(not(target_os = "android"))]
    let _ = name;
    work()
}

/// What can be made before there is a window: the fonts, and a Vulkan device.
struct Prepared {
    fonts: FontSystem,
    vulkan: Result<gpu::Device, String>,
}

static PREPARED: Mutex<Option<Prepared>> = Mutex::new(None);

/// Loads the fonts and opens a Vulkan device, on a background thread while the conversation opens; `Renderer::new`
/// takes what this made, or makes it itself if it was not called.
pub(crate) fn prepare() {
    let mut fonts = text::fonts();
    text::warm(&mut fonts);
    let prepared = Prepared {
        fonts,
        vulkan: gpu::Device::new(wgpu::Backends::VULKAN),
    };
    if let Ok(mut slot) = PREPARED.lock() {
        *slot = Some(prepared);
    }
}

/// What a frame did, for Kotlin's scroller.
pub(crate) struct Frame {
    pub scroll: f32,
    pub max_scroll: f32,
    pub clamped: bool,
    /// Rows on the frame presented; 0 when nothing was presented.
    pub drawn: usize,
    /// Nothing was presented: draw again next frame.
    pub again: bool,
}

pub(crate) struct Renderer {
    conversation: *const Shared,
    gpu: gpu::Gpu,
    fonts: FontSystem,
    swash: SwashCache,
    look: text::Look,
    width: u32,
    height: u32,
    layout: layout::Layout,
    shaped: HashMap<usize, Shaped>,
}

/// Shapes row `index` of the conversation and keeps it; returns its height.
fn shape_into(
    conversation: &Shared,
    fonts: &mut FontSystem,
    look: &text::Look,
    width: f32,
    shaped: &mut HashMap<usize, Shaped>,
    index: usize,
) -> f32 {
    // Cloned under the lock and shaped outside it, as `Core.render` does.
    let row = conversation
        .0
        .lock()
        .ok()
        .and_then(|conversation| conversation.rows().get(index).cloned());
    let Some(row) = row else {
        return 0.0;
    };
    let row = traced("spike.surface.shape", || {
        text::shape(fonts, look, width, &row)
    });
    let height = row.height;
    shaped.insert(index, row);
    height
}

impl Renderer {
    /// # Safety
    ///
    /// `conversation` points to a live `Shared` that outlives the renderer: Kotlin detaches before it closes.
    pub unsafe fn new<W: wgpu::WindowHandle + wgpu::rwh::HasDisplayHandle + 'static>(
        conversation: *const Shared,
        window: impl Fn() -> W,
        width: u32,
        height: u32,
        density: f32,
        font_scale: f32,
    ) -> Result<Renderer, String> {
        let prepared = PREPARED.lock().ok().and_then(|mut slot| slot.take());
        let (fonts, vulkan) = match prepared {
            Some(prepared) => (prepared.fonts, Some(prepared.vulkan)),
            None => (text::fonts(), None),
        };
        let gpu = gpu::Gpu::connect(vulkan, window, width, height)?;
        Ok(Renderer {
            conversation,
            gpu,
            fonts,
            swash: SwashCache::new(),
            look: text::Look::new(density, font_scale),
            width,
            height,
            layout: layout::Layout::default(),
            shaped: HashMap::new(),
        })
    }

    pub fn describe(&self) -> &str {
        self.gpu.describe()
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width != self.width {
            self.layout.reset();
            self.shaped.clear();
        }
        self.width = width;
        self.height = height;
        self.gpu.resize(width, height);
    }

    /// Row `index` changed: it is shaped again before it is next placed.
    pub fn changed(&mut self, index: usize) {
        self.layout.changed(index);
        self.shaped.remove(&index);
    }

    pub fn frame(&mut self, scroll: f32) -> Frame {
        let Renderer {
            conversation,
            gpu,
            fonts,
            swash,
            look,
            width,
            height,
            layout,
            shaped,
        } = self;
        // SAFETY: see `new`.
        let conversation = unsafe { &**conversation };
        let count = conversation
            .0
            .lock()
            .map_or(0, |conversation| conversation.rows().len());
        let wide = *width as f32;
        let placement = traced("spike.surface.layout", || {
            let placement = layout.place(count, scroll, *height as f32, &mut |index| {
                shape_into(conversation, fonts, look, wide, shaped, index)
            });
            // A row measured before but since dropped from the cache is shaped again to be drawn, at the same height.
            for placed in &placement.rows {
                if !shaped.contains_key(&placed.index) {
                    shape_into(conversation, fonts, look, wide, shaped, placed.index);
                }
            }
            placement
        });
        let (lowest, highest) = placement
            .rows
            .iter()
            .fold((usize::MAX, 0), |(lowest, highest), row| {
                (lowest.min(row.index), highest.max(row.index))
            });
        shaped.retain(|index, _| {
            index.saturating_add(KEEP) >= lowest && *index <= highest.saturating_add(KEEP)
        });

        let bounds = TextBounds {
            left: 0,
            top: 0,
            right: *width as i32,
            bottom: *height as i32,
        };
        let mut quads = Vec::new();
        let mut areas = Vec::with_capacity(placement.rows.len());
        for placed in &placement.rows {
            let Some(row) = shaped.get(&placed.index) else {
                continue;
            };
            // Whole pixels: text stays crisp and abutting backgrounds leave no seam.
            let top = placed.top.round();
            quads.extend(row.quads.iter().map(|quad| Quad {
                y: quad.y + top,
                ..*quad
            }));
            areas.push(TextArea {
                buffer: &row.buffer,
                left: row.text_x,
                top: top + row.text_y,
                scale: 1.0,
                bounds,
                default_color: Color(row.color),
                custom_glyphs: &[],
            });
        }
        let presented = traced("spike.surface.draw", || {
            gpu.draw(fonts, swash, areas, &quads)
        });
        Frame {
            scroll: placement.scroll,
            max_scroll: placement.max_scroll,
            clamped: placement.clamped,
            drawn: if presented { placement.rows.len() } else { 0 },
            again: !presented,
        }
    }
}
