//! BGRX to I420 (BT.601, limited range), split across threads by row bands: libyuv with the `libyuv` feature, else a
//! portable converter in Rust with libyuv's own arithmetic (its C rows), for a build with no C library to link (Windows).

#[cfg(feature = "libyuv")]
unsafe extern "C" {
    fn ARGBToI420(
        src_argb: *const u8,
        src_stride_argb: i32,
        dst_y: *mut u8,
        dst_stride_y: i32,
        dst_u: *mut u8,
        dst_stride_u: i32,
        dst_v: *mut u8,
        dst_stride_v: i32,
        width: i32,
        height: i32,
    ) -> i32;
}

/// A picture as three planes: Y at full size, U and V at half each way (rounded up).
pub struct I420 {
    pub width: usize,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

impl I420 {
    pub fn new(width: usize, height: usize) -> Self {
        let cw = width.div_ceil(2);
        let ch = height.div_ceil(2);
        I420 {
            width,
            y: vec![16; width * height],
            u: vec![128; cw * ch],
            v: vec![128; cw * ch],
        }
    }

    pub fn stride_uv(&self) -> usize {
        self.width.div_ceil(2)
    }

    pub fn height(&self) -> usize {
        self.y.len() / self.width.max(1)
    }
}

/// A picture as packed BGRA (BGRX: the fourth byte unused), `width * 4` bytes a row: for an encoder that converts
/// itself, or takes RGB (NVENC's ARGB input, a Media Foundation colour converter).
pub struct Bgra {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Bgra {
    pub fn new(width: usize, height: usize) -> Self {
        Bgra {
            width,
            height,
            data: vec![0; width * height * 4],
        }
    }

    pub fn stride(&self) -> usize {
        self.width * 4
    }

    /// Copies rows [y0, y1) of `src` (BGRX from the picture's first pixel, `src_stride` bytes a row) in.
    pub fn copy_rows(&mut self, src: &[u8], src_stride: usize, y0: usize, y1: usize) {
        let row = self.stride();
        let y1 = y1.min(self.height);
        if y1 <= y0 || src.len() < src_stride * (y1 - 1) + row {
            return;
        }
        for y in y0..y1 {
            self.data[y * row..(y + 1) * row]
                .copy_from_slice(&src[y * src_stride..y * src_stride + row]);
        }
    }
}

struct SendPtr(*mut u8);
// Each thread writes its own rows of the planes; split_rows keeps the bands disjoint.
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}
impl SendPtr {
    fn get(&self) -> *mut u8 {
        self.0
    }
}

/// Runs `run(a, b)` over row chunks of [y0, y1) on up to `threads` threads; chunk edges stay even for 4:2:0.
fn split_rows(y0: usize, y1: usize, threads: usize, run: impl Fn(usize, usize) + Sync) {
    let rows = y1 - y0;
    if rows == 0 {
        return;
    }
    let n = threads.clamp(1, (rows / 64).max(1));
    if n == 1 {
        run(y0, y1);
        return;
    }
    let chunk = (rows.div_ceil(n) + 1) & !1;
    std::thread::scope(|s| {
        let mut a = y0;
        while a < y1 {
            let b = (a + chunk).min(y1);
            let run = &run;
            if b == y1 {
                run(a, b);
            } else {
                s.spawn(move || run(a, b));
            }
            a = b;
        }
    });
}

/// Converts rows [y0, y1) (even-aligned) of `src` into `dst`. `src` starts at the picture's first pixel and holds
/// `src_stride` bytes per row.
pub fn convert_band(
    src: &[u8],
    src_stride: usize,
    dst: &mut I420,
    y0: usize,
    y1: usize,
    threads: usize,
) {
    let w = dst.width;
    let rows = dst.y.len() / w.max(1);
    let y1 = y1.min(rows);
    if y1 <= y0 || src.len() < src_stride * (y1 - 1) + w * 4 {
        return;
    }
    let suv = dst.stride_uv();
    let (yp, up, vp) = (
        SendPtr(dst.y.as_mut_ptr()),
        SendPtr(dst.u.as_mut_ptr()),
        SendPtr(dst.v.as_mut_ptr()),
    );
    let src_p = SendPtr(src.as_ptr() as *mut u8);
    // Bounds were checked above: rows [a, b) of src and of each plane lie inside their buffers.
    let run = |a: usize, b: usize| unsafe {
        let rows = Rows {
            src: src_p.get().add(a * src_stride),
            src_stride,
            y: yp.get().add(a * w),
            u: up.get().add((a / 2) * suv),
            v: vp.get().add((a / 2) * suv),
            stride_uv: suv,
            width: w,
            height: b - a,
        };
        rows.convert();
    };
    split_rows(y0, y1, threads, run);
}

/// A band of rows to convert: where it starts in the source and in each plane.
struct Rows {
    src: *const u8,
    src_stride: usize,
    y: *mut u8,
    u: *mut u8,
    v: *mut u8,
    stride_uv: usize,
    width: usize,
    height: usize,
}

impl Rows {
    #[cfg(feature = "libyuv")]
    unsafe fn convert(&self) {
        unsafe {
            ARGBToI420(
                self.src,
                self.src_stride as i32,
                self.y,
                self.width as i32,
                self.u,
                self.stride_uv as i32,
                self.v,
                self.stride_uv as i32,
                self.width as i32,
                self.height as i32,
            );
        }
    }

    #[cfg(not(feature = "libyuv"))]
    unsafe fn convert(&self) {
        unsafe { self.convert_portable() }
    }

    /// libyuv's C rows: Y = (66 R + 129 G + 25 B + 0x1080) >> 8, and U, V from each 2x2 block averaged with rounding,
    /// vertically first.
    #[cfg_attr(feature = "libyuv", allow(dead_code))]
    unsafe fn convert_portable(&self) {
        let (w, cw) = (self.width, self.width.div_ceil(2));
        for pair in 0..self.height.div_ceil(2) {
            let r0 = pair * 2;
            let r1 = (r0 + 1).min(self.height - 1);
            // SAFETY: convert_band checked that every row of the band lies inside the source and the planes, and each
            // plane row is borrowed alone.
            let (s0, s1) = unsafe {
                (
                    std::slice::from_raw_parts(self.src.add(r0 * self.src_stride), w * 4),
                    std::slice::from_raw_parts(self.src.add(r1 * self.src_stride), w * 4),
                )
            };
            let rows = if r1 == r0 { 1 } else { 2 };
            for (r, s) in [(r0, s0), (r1, s1)].into_iter().take(rows) {
                luma_row(s, unsafe {
                    std::slice::from_raw_parts_mut(self.y.add(r * w), w)
                });
            }
            let (u, v) = unsafe {
                (
                    std::slice::from_raw_parts_mut(self.u.add(pair * self.stride_uv), cw),
                    std::slice::from_raw_parts_mut(self.v.add(pair * self.stride_uv), cw),
                )
            };
            for cx in 0..cw {
                let (x0, x1) = (cx * 2, (cx * 2 + 1).min(w - 1));
                let avg = |c: usize| {
                    let left = (u32::from(s0[x0 * 4 + c]) + u32::from(s1[x0 * 4 + c]) + 1) >> 1;
                    let right = (u32::from(s0[x1 * 4 + c]) + u32::from(s1[x1 * 4 + c]) + 1) >> 1;
                    ((left + right + 1) >> 1) as i32
                };
                let (b, g, r) = (avg(0), avg(1), avg(2));
                u[cx] = ((112 * b - 74 * g - 38 * r + 0x8080) >> 8) as u8;
                v[cx] = ((112 * r - 94 * g - 18 * b + 0x8080) >> 8) as u8;
            }
        }
    }
}

#[cfg_attr(feature = "libyuv", allow(dead_code))]
fn luma_row(src: &[u8], y: &mut [u8]) {
    for (out, px) in y.iter_mut().zip(src.as_chunks::<4>().0) {
        let (b, g, r) = (u32::from(px[0]), u32::from(px[1]), u32::from(px[2]));
        *out = ((66 * r + 129 * g + 25 * b + 0x1080) >> 8) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test picture: a gradient with a few saturated blocks, `w` x `h` BGRX, rows padded to `stride`.
    fn picture(w: usize, h: usize, stride: usize) -> Vec<u8> {
        let mut px = vec![0u8; stride * h];
        for y in 0..h {
            for x in 0..w {
                let i = y * stride + x * 4;
                let block = (x / 8 + y / 8) % 4;
                let (b, g, r) = match block {
                    0 => ((x * 3) as u8, (y * 5) as u8, ((x + y) * 2) as u8),
                    1 => (255, 0, 0),
                    2 => (0, 255, 0),
                    _ => (0, 0, 255),
                };
                px[i..i + 4].copy_from_slice(&[b, g, r, 0xff]);
            }
        }
        px
    }

    #[test]
    fn primaries_land_on_bt601_limited_range() {
        // White, black, and red as BT.601 limited range has them (Y 235/16; red: Y 81, U 90, V 240), within a step.
        for (bgr, want) in [
            ([255u8, 255, 255], (235u8, 128u8, 128u8)),
            ([0, 0, 0], (16, 128, 128)),
            ([0, 0, 255], (81, 90, 240)),
        ] {
            let mut src = Vec::new();
            for _ in 0..16 * 2 {
                src.extend_from_slice(&[bgr[0], bgr[1], bgr[2], 0]);
            }
            let mut dst = I420::new(16, 2);
            convert_band(&src, 64, &mut dst, 0, 2, 1);
            let close = |a: u8, b: u8| a.abs_diff(b) <= 1;
            assert!(
                close(dst.y[0], want.0) && close(dst.u[0], want.1) && close(dst.v[0], want.2),
                "{bgr:?} -> {} {} {}",
                dst.y[0],
                dst.u[0],
                dst.v[0]
            );
        }
    }

    #[test]
    fn a_band_converts_only_its_rows_and_threads_agree_with_one() {
        let (w, h, stride) = (130usize, 300usize, 130 * 4 + 24);
        let src = picture(w, h, stride);
        let mut one = I420::new(w, h);
        convert_band(&src, stride, &mut one, 0, h, 1);
        let mut four = I420::new(w, h);
        convert_band(&src, stride, &mut four, 0, h, 4);
        assert!(one.y == four.y && one.u == four.u && one.v == four.v);
        // Rows 100..200 only: the rest keeps the blank picture's values.
        let mut band = I420::new(w, h);
        convert_band(&src, stride, &mut band, 100, 200, 2);
        assert_eq!(band.y[99 * w], 16);
        assert_eq!(band.y[100 * w..200 * w], one.y[100 * w..200 * w]);
        assert_eq!(band.y[200 * w], 16);
        assert_eq!(band.u[50 * 65..100 * 65], one.u[50 * 65..100 * 65]);
    }

    /// The portable converter is what a build without libyuv (Windows) streams with: it must agree with libyuv's SIMD
    /// rows to a step.
    #[cfg(feature = "libyuv")]
    #[test]
    fn the_portable_converter_matches_libyuv() {
        let (w, h, stride) = (131usize, 77usize, 131 * 4 + 12);
        let src = picture(w, h, stride);
        let mut yuv = I420::new(w, h);
        convert_band(&src, stride, &mut yuv, 0, h, 1);
        let mut portable = I420::new(w, h);
        let suv = portable.stride_uv();
        let rows = Rows {
            src: src.as_ptr(),
            src_stride: stride,
            y: portable.y.as_mut_ptr(),
            u: portable.u.as_mut_ptr(),
            v: portable.v.as_mut_ptr(),
            stride_uv: suv,
            width: w,
            height: h,
        };
        unsafe { rows.convert_portable() };
        let worst =
            |a: &[u8], b: &[u8]| a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
        assert!(
            worst(&yuv.y, &portable.y) <= 1,
            "Y off by {}",
            worst(&yuv.y, &portable.y)
        );
        assert!(
            worst(&yuv.u, &portable.u) <= 2,
            "U off by {}",
            worst(&yuv.u, &portable.u)
        );
        assert!(
            worst(&yuv.v, &portable.v) <= 2,
            "V off by {}",
            worst(&yuv.v, &portable.v)
        );
    }

    #[test]
    fn bgra_rows_are_copied_without_the_padding() {
        let (w, h, stride) = (5usize, 4usize, 32usize);
        let src = picture(w, h, stride);
        let mut b = Bgra::new(w, h);
        b.copy_rows(&src, stride, 1, 3);
        assert_eq!(&b.data[..w * 4], &[0u8; 20][..]);
        assert_eq!(&b.data[w * 4..2 * w * 4], &src[stride..stride + w * 4]);
        assert_eq!(&b.data[3 * w * 4..], &[0u8; 20][..]);
    }
}
