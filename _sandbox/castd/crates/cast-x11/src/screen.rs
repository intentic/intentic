//! Dynamic resolution (voxl's): resizes the X screen with RandR so the window's screen is the driving viewer's box
//! times its device pixel ratio, pixel for pixel, instead of a picture scaled into it.
//!
//! Xvfb only offers the mode it started with, and that size is its maximum, so start it at the largest size to allow
//! (castd's `--max-size` can only lower it). Each new size gets a mode of its own. RandR modes belong to the client that
//! created them and the server reverts when it disconnects, so this keeps its connection for castd's lifetime. Xvfb
//! keeps the same `-shmem` framebuffer (and stride) across sizes; the screen is its top-left.

use cast_core::geometry::{MIN, ResizeLimits, fit};
use x11rb::connection::Connection;
use x11rb::protocol::randr::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt as _, MapState};
use x11rb::rust_connection::RustConnection;

pub struct Screen {
    conn: RustConnection,
    root: u32,
    output: randr::Output,
    crtc: randr::Crtc,
    min: (u32, u32),
    max: (u32, u32),
    current: (u32, u32),
    /// The mode the server started with; never destroyed.
    initial_mode: randr::Mode,
    initial_size: (u32, u32),
    /// Mode we created for the current size, destroyed when the size changes again.
    custom_mode: Option<randr::Mode>,
    /// Millimetres per pixel, kept constant so the DPI doesn't change with the size.
    mm_per_px: (f64, f64),
}

fn err(e: impl std::fmt::Display) -> String {
    format!("RandR: {e}")
}

impl Screen {
    /// Opens the screen for resizing, never larger than `cap` (`--max-size`).
    pub fn open(display: Option<&str>, cap: Option<(u32, u32)>) -> Result<Self, String> {
        let (conn, n) = RustConnection::connect(display).map_err(err)?;
        let s = &conn.setup().roots[n];
        let (root, w, h) = (s.root, s.width_in_pixels as u32, s.height_in_pixels as u32);
        let mm_per_px = (
            s.width_in_millimeters as f64 / w as f64,
            s.height_in_millimeters as f64 / h as f64,
        );
        conn.randr_query_version(1, 3)
            .map_err(err)?
            .reply()
            .map_err(err)?;
        let res = conn
            .randr_get_screen_resources(root)
            .map_err(err)?
            .reply()
            .map_err(err)?;
        let (&output, &crtc) = res
            .outputs
            .first()
            .zip(res.crtcs.first())
            .ok_or("RandR: no output")?;
        let crtc_info = conn
            .randr_get_crtc_info(crtc, res.config_timestamp)
            .map_err(err)?
            .reply()
            .map_err(err)?;
        let range = conn
            .randr_get_screen_size_range(root)
            .map_err(err)?
            .reply()
            .map_err(err)?;
        Ok(Screen {
            conn,
            root,
            output,
            crtc,
            min: (
                (range.min_width as u32).max(MIN.0),
                (range.min_height as u32).max(MIN.1),
            ),
            max: {
                let (mw, mh) = (range.max_width as u32, range.max_height as u32);
                cap.map_or((mw, mh), |(cw, ch)| (mw.min(cw), mh.min(ch)))
            },
            current: (w, h),
            initial_mode: crtc_info.mode,
            initial_size: (u32::from(crtc_info.width), u32::from(crtc_info.height)),
            custom_mode: None,
            mm_per_px,
        })
    }

    pub fn limits(&self) -> ResizeLimits {
        (self.min, self.max)
    }

    pub fn fit(&self, w: u32, h: u32) -> (u32, u32) {
        fit(w, h, self.min, self.max)
    }

    pub fn resize(&mut self, w: u32, h: u32) -> Result<(), String> {
        let (w, h) = self.fit(w, h);
        let geometry = self
            .conn
            .get_geometry(self.root)
            .map_err(err)?
            .reply()
            .map_err(err)?;
        self.current = (u32::from(geometry.width), u32::from(geometry.height));
        if (w, h) == self.current {
            return Ok(());
        }
        let c = &self.conn;
        let res = c
            .randr_get_screen_resources(self.root)
            .map_err(err)?
            .reply()
            .map_err(err)?;
        let mode = if (w, h) == self.initial_size {
            self.initial_mode
        } else {
            let name = format!("castd-{w}x{h}");
            let info = randr::ModeInfo {
                id: 0,
                width: w as u16,
                height: h as u16,
                dot_clock: w * h * 60,
                hsync_start: w as u16 + 1,
                hsync_end: w as u16 + 2,
                htotal: w as u16 + 3,
                hskew: 0,
                vsync_start: h as u16 + 1,
                vsync_end: h as u16 + 2,
                vtotal: h as u16 + 3,
                name_len: name.len() as u16,
                mode_flags: randr::ModeFlag::from(0u32),
            };
            let mode = c
                .randr_create_mode(self.root, info, name.as_bytes())
                .map_err(err)?
                .reply()
                .map_err(err)?
                .mode;
            c.randr_add_output_mode(self.output, mode)
                .map_err(err)?
                .check()
                .map_err(err)?;
            mode
        };
        let mm = |px: u32, per: f64| ((px as f64 * per).round() as u32).max(1);
        let set_size = |w: u32, h: u32| {
            c.randr_set_screen_size(
                self.root,
                w as u16,
                h as u16,
                mm(w, self.mm_per_px.0),
                mm(h, self.mm_per_px.1),
            )
            .map_err(err)?
            .check()
            .map_err(err)
        };
        // The screen must contain the CRTC at every step: grow it first, switch the
        // mode, then shrink it to the final size.
        let (cw, ch) = self.current;
        set_size(w.max(cw), h.max(ch))?;
        let reply = c
            .randr_set_crtc_config(
                self.crtc,
                x11rb::CURRENT_TIME,
                res.config_timestamp,
                0,
                0,
                mode,
                randr::Rotation::ROTATE0,
                &[self.output],
            )
            .map_err(err)?
            .reply()
            .map_err(err)?;
        if reply.status != randr::SetConfig::SUCCESS {
            return Err(format!("RandR: set mode {w}x{h}: {:?}", reply.status));
        }
        set_size(w, h)?;
        if let Some(old) = self.custom_mode.take() {
            let _ = c.randr_delete_output_mode(self.output, old);
            let _ = c.randr_destroy_mode(old);
        }
        if mode != self.initial_mode {
            self.custom_mode = Some(mode);
        }
        c.flush().map_err(err)?;
        let old = self.current;
        self.current = (w, h);
        self.fit_windows(old, (w, h));
        log::info!("screen resized to {w}x{h}");
        Ok(())
    }

    /// Resizes every mapped toplevel that (nearly) covered the old screen to cover the new one, as a window manager does for a
    /// fullscreen window: there is none on these displays, and Chromium does not follow a RandR change by itself.
    /// Menus and popups (override-redirect) are left alone.
    fn fit_windows(&self, old: (u32, u32), new: (u32, u32)) {
        let c = &self.conn;
        let Ok(Ok(tree)) = c.query_tree(self.root).map(|r| r.reply()) else {
            return;
        };
        for w in tree.children {
            let viewable = c
                .get_window_attributes(w)
                .ok()
                .and_then(|r| r.reply().ok())
                .is_some_and(|a| a.map_state == MapState::VIEWABLE && !a.override_redirect);
            if !viewable {
                continue;
            }
            let Some(g) = c.get_geometry(w).ok().and_then(|r| r.reply().ok()) else {
                continue;
            };
            // At the origin and nearly the whole old screen: Chromium sizes a kiosk window a pixel short of what it
            // was asked for (1599x999 on a 1600x1000 screen), so "covered" allows a tenth of slack.
            let right = i64::from(g.x) + i64::from(g.width);
            let bottom = i64::from(g.y) + i64::from(g.height);
            let covers = g.x <= 0
                && g.y <= 0
                && right * 10 >= i64::from(old.0) * 9
                && bottom * 10 >= i64::from(old.1) * 9;
            if covers {
                let _ = c.configure_window(
                    w,
                    &ConfigureWindowAux::new()
                        .x(0)
                        .y(0)
                        .width(new.0)
                        .height(new.1),
                );
            }
        }
        let _ = c.flush();
    }
}
