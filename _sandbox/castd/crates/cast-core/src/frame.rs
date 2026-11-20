//! The picture between capture and encoder. The capture thread fills a frame (only the rows that changed), the encode
//! thread reads it; two frames take turns. A frame is CPU I420, CPU BGRA, or a platform's own surface the core never
//! looks into ([`NativeFrame`]: a D3D11 texture the screen was copied into on the GPU, which an encoder on the same
//! device reads in place). Which one is the first of the encoder's [`VideoEncoder::formats`] the capture can fill
//! ([`Capture::formats`]), so a zero-copy GPU path plugs in as a capture and an encoder that agree on `Native`, and the
//! rest of the pipeline is the same.
//!
//! [`VideoEncoder::formats`]: crate::encoder::VideoEncoder::formats
//! [`Capture::formats`]: crate::capture::Capture::formats

use crate::convert::{Bgra, I420};
use crate::encoder::Planes;
use std::any::Any;

/// The kinds of frame there are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameFormat {
    /// CPU planes, BT.601 limited range: what x264 and castd's NVENC take.
    I420,
    /// CPU packed BGRA, `width * 4` bytes a row.
    Bgra,
    /// The platform's own surface ([`NativeFrame`]).
    Native,
}

/// A picture in the platform's own memory: a GPU texture (a D3D11 `ID3D11Texture2D` in BGRA or NV12, a CUDA
/// surface). The capture that made it and the encoder that reads it know its type and downcast through `as_any`; the
/// core only passes it along. Created by `Capture::new_frame`, filled by `Capture::fill`, read by
/// `VideoEncoder::encode` as `Picture::Native` on the encode thread, so it must be `Send` (a COM pointer is wrapped in
/// a type that says so, which holds when one thread uses it at a time, as here).
pub trait NativeFrame: Send + 'static {
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

/// One of the two pictures the capture fills and the encoder reads.
pub enum Frame {
    I420(I420),
    Bgra(Bgra),
    Native(Box<dyn NativeFrame>),
}

impl Frame {
    /// A blank frame in a CPU format; None for `Native`, which only the capture can make.
    pub fn cpu(format: FrameFormat, width: usize, height: usize) -> Option<Frame> {
        match format {
            FrameFormat::I420 => Some(Frame::I420(I420::new(width, height))),
            FrameFormat::Bgra => Some(Frame::Bgra(Bgra::new(width, height))),
            FrameFormat::Native => None,
        }
    }

    pub fn format(&self) -> FrameFormat {
        match self {
            Frame::I420(_) => FrameFormat::I420,
            Frame::Bgra(_) => FrameFormat::Bgra,
            Frame::Native(_) => FrameFormat::Native,
        }
    }

    pub fn width(&self) -> usize {
        match self {
            Frame::I420(f) => f.width,
            Frame::Bgra(f) => f.width,
            Frame::Native(f) => f.width() as usize,
        }
    }

    /// Rows [y, y + h) of the frame as an encoder reads them: one stripe of a CPU picture, or the whole native one
    /// (a picture on the GPU is never cut into stripes).
    pub fn picture(&self, y: usize, h: usize) -> Picture<'_> {
        match self {
            Frame::I420(buf) => {
                let suv = buf.stride_uv();
                Picture::I420(Planes {
                    y: &buf.y[y * buf.width..],
                    u: &buf.u[(y / 2) * suv..],
                    v: &buf.v[(y / 2) * suv..],
                    stride_y: buf.width,
                    stride_uv: suv,
                })
            }
            Frame::Bgra(buf) => {
                let stride = buf.stride();
                let end = ((y + h) * stride).min(buf.data.len());
                Picture::Bgra {
                    data: &buf.data[y * stride..end],
                    stride,
                }
            }
            Frame::Native(f) => Picture::Native(f.as_ref()),
        }
    }
}

/// What an encoder is handed for one picture (or one stripe of it).
pub enum Picture<'a> {
    I420(Planes<'a>),
    /// Packed BGRA from the stripe's first row, `stride` bytes a row.
    Bgra {
        data: &'a [u8],
        stride: usize,
    },
    Native(&'a dyn NativeFrame),
}

impl<'a> Picture<'a> {
    /// The I420 planes, or the error an I420-only encoder answers anything else with.
    pub fn i420(&self) -> Result<&Planes<'a>, String> {
        match self {
            Picture::I420(p) => Ok(p),
            Picture::Bgra { .. } => Err("this encoder takes I420, not BGRA".into()),
            Picture::Native(_) => Err("this encoder takes I420, not a native frame".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Texture {
        w: u32,
        h: u32,
        filled: u32,
    }

    impl NativeFrame for Texture {
        fn width(&self) -> u32 {
            self.w
        }
        fn height(&self) -> u32 {
            self.h
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn as_any_mut(&mut self) -> &mut dyn Any {
            self
        }
    }

    #[test]
    fn a_stripe_of_a_cpu_frame_starts_at_its_rows() {
        let mut f = I420::new(32, 32);
        f.y[16 * 32] = 7;
        f.u[8 * 16] = 9;
        let frame = Frame::I420(f);
        let Picture::I420(p) = frame.picture(16, 16) else {
            panic!("not I420");
        };
        assert_eq!((p.y[0], p.u[0], p.stride_y, p.stride_uv), (7, 9, 32, 16));
        let mut b = Bgra::new(4, 4);
        b.data[2 * 16] = 5;
        let frame = Frame::Bgra(b);
        let Picture::Bgra { data, stride } = frame.picture(2, 2) else {
            panic!("not BGRA");
        };
        assert_eq!((data[0], data.len(), stride), (5, 32, 16));
    }

    #[test]
    fn a_native_frame_is_handed_through_and_downcast_by_its_owner() {
        let mut frame = Frame::Native(Box::new(Texture {
            w: 64,
            h: 48,
            filled: 0,
        }));
        if let Frame::Native(t) = &mut frame {
            t.as_any_mut().downcast_mut::<Texture>().unwrap().filled = 3;
        }
        assert_eq!((frame.format(), frame.width()), (FrameFormat::Native, 64));
        let Picture::Native(t) = frame.picture(0, 48) else {
            panic!("not native");
        };
        assert_eq!(t.as_any().downcast_ref::<Texture>().unwrap().filled, 3);
        assert!(frame.picture(0, 48).i420().is_err());
        assert!(Frame::cpu(FrameFormat::Native, 1, 1).is_none());
    }
}
