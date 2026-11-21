//! The SPS and PPS the VA-API encoder hands its driver as a packed header, written here rather than left to the driver:
//! a driver writes no colour description (the pictures are BT.601 limited range from sRGB, as x264's and NVENC's VUI
//! say) and no bitstream restriction, which is what tells a decoder that nothing is reordered, so it shows each picture
//! as it arrives. Also the level, from the picture's size and rate.

/// The stream's shape, which the SPS, the PPS and the driver's parameter buffers all say the same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stream {
    /// 100 (High), 77 (Main) or 66 (Constrained Baseline).
    pub profile_idc: u8,
    pub level_idc: u8,
    pub width: u32,
    pub height: u32,
    pub log2_max_frame_num: u32,
    /// CABAC (Main and High) rather than CAVLC.
    pub cabac: bool,
    /// The 8x8 transform (High only).
    pub transform_8x8: bool,
    pub pic_init_qp: u8,
}

impl Stream {
    pub fn mb_width(&self) -> u32 {
        self.width.div_ceil(16)
    }
    pub fn mb_height(&self) -> u32 {
        self.height.div_ceil(16)
    }
    /// The crop off the right and bottom in 4:2:0 crop units (2 pixels), when the size is not whole macroblocks.
    pub fn crop(&self) -> Option<(u32, u32)> {
        let right = (self.mb_width() * 16 - self.width) / 2;
        let bottom = (self.mb_height() * 16 - self.height) / 2;
        (right > 0 || bottom > 0).then_some((right, bottom))
    }
}

/// The lowest level whose limits hold `width` x `height` at `fps` and a bitrate of up to 50 Mbit/s (a keyframe's
/// boost), never under 4.1. (H.264 table A-1: max frame size and macroblocks a second.)
pub fn level_for(width: u32, height: u32, fps: u32) -> u8 {
    const LEVELS: &[(u8, u64, u64)] = &[
        (41, 8_192, 245_760),
        (42, 8_704, 522_240),
        (50, 22_080, 589_824),
        (51, 36_864, 983_040),
        (52, 36_864, 2_073_600),
        (60, 139_264, 4_177_920),
        (61, 139_264, 8_355_840),
        (62, 139_264, 16_711_680),
    ];
    let fs = u64::from(width.div_ceil(16)) * u64::from(height.div_ceil(16));
    let mbps = fs * u64::from(fps.max(1));
    LEVELS
        .iter()
        .find(|(_, max_fs, max_mbps)| fs <= *max_fs && mbps <= *max_mbps)
        .map_or(62, |(l, _, _)| *l)
}

/// Bits, most significant first.
#[derive(Default)]
pub struct Bits {
    bytes: Vec<u8>,
    bit: u32,
}

impl Bits {
    pub fn u(&mut self, n: u32, v: u32) {
        for i in (0..n).rev() {
            if self.bit == 0 {
                self.bytes.push(0);
            }
            if (v >> i) & 1 == 1 {
                *self.bytes.last_mut().expect("a byte") |= 0x80 >> self.bit;
            }
            self.bit = (self.bit + 1) % 8;
        }
    }

    pub fn flag(&mut self, b: bool) {
        self.u(1, b as u32);
    }

    /// Unsigned Exp-Golomb.
    pub fn ue(&mut self, v: u32) {
        let v = u64::from(v) + 1;
        let len = 64 - v.leading_zeros();
        self.u(len - 1, 0);
        for i in (0..len).rev() {
            self.u(1, ((v >> i) & 1) as u32);
        }
    }

    /// Signed Exp-Golomb.
    pub fn se(&mut self, v: i32) {
        self.ue(if v > 0 { 2 * v as u32 - 1 } else { (-2 * v) as u32 });
    }

    /// The RBSP's stop bit and the zeros to the byte boundary.
    pub fn trailing(mut self) -> Vec<u8> {
        self.u(1, 1);
        while self.bit != 0 {
            self.u(1, 0);
        }
        self.bytes
    }
}

/// One NAL unit, Annex B: a 4-byte start code, the header, and the RBSP with emulation prevention bytes.
pub fn nal(nal_ref_idc: u8, nal_type: u8, rbsp: &[u8]) -> Vec<u8> {
    let mut out = vec![0, 0, 0, 1, (nal_ref_idc << 5) | nal_type];
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// The sequence parameter set, Annex B.
pub fn sps(s: &Stream) -> Vec<u8> {
    let mut b = Bits::default();
    b.u(8, u32::from(s.profile_idc));
    // constraint_set0..5: Constrained Baseline is Baseline that Main decoders take (0 and 1); Main says so (1).
    let flags: u32 = match s.profile_idc {
        66 => 0b1100_0000,
        77 => 0b0100_0000,
        _ => 0,
    };
    b.u(8, flags);
    b.u(8, u32::from(s.level_idc));
    b.ue(0); // seq_parameter_set_id
    if s.profile_idc == 100 {
        b.ue(1); // chroma_format_idc: 4:2:0
        b.ue(0); // bit_depth_luma_minus8
        b.ue(0); // bit_depth_chroma_minus8
        b.flag(false); // qpprime_y_zero_transform_bypass_flag
        b.flag(false); // seq_scaling_matrix_present_flag
    }
    b.ue(s.log2_max_frame_num - 4);
    b.ue(2); // pic_order_cnt_type: the order is the decoding order
    b.ue(1); // max_num_ref_frames
    b.flag(false); // gaps_in_frame_num_value_allowed_flag
    b.ue(s.mb_width() - 1);
    b.ue(s.mb_height() - 1);
    b.flag(true); // frame_mbs_only_flag
    b.flag(true); // direct_8x8_inference_flag
    match s.crop() {
        Some((right, bottom)) => {
            b.flag(true);
            b.ue(0);
            b.ue(right);
            b.ue(0);
            b.ue(bottom);
        }
        None => b.flag(false),
    }
    b.flag(true); // vui_parameters_present_flag
    b.flag(false); // aspect_ratio_info_present_flag
    b.flag(false); // overscan_info_present_flag
    b.flag(true); // video_signal_type_present_flag
    b.u(3, 5); // video_format: unspecified
    b.flag(false); // video_full_range_flag
    b.flag(true); // colour_description_present_flag
    b.u(8, 1); // colour_primaries: BT.709 (sRGB's)
    b.u(8, 13); // transfer_characteristics: sRGB
    b.u(8, 6); // matrix_coefficients: BT.601 (SMPTE 170M), as the conversion
    b.flag(false); // chroma_loc_info_present_flag
    b.flag(false); // timing_info_present_flag: pictures come when the screen changes
    b.flag(false); // nal_hrd_parameters_present_flag
    b.flag(false); // vcl_hrd_parameters_present_flag
    b.flag(false); // pic_struct_present_flag
    b.flag(true); // bitstream_restriction_flag
    b.flag(true); // motion_vectors_over_pic_boundaries_flag
    b.ue(0); // max_bytes_per_pic_denom
    b.ue(0); // max_bits_per_mb_denom
    b.ue(15); // log2_max_mv_length_horizontal
    b.ue(15); // log2_max_mv_length_vertical
    b.ue(0); // max_num_reorder_frames: shown as decoded
    b.ue(1); // max_dec_frame_buffering: the one reference
    nal(3, 7, &b.trailing())
}

/// The picture parameter set, Annex B.
pub fn pps(s: &Stream) -> Vec<u8> {
    let mut b = Bits::default();
    b.ue(0); // pic_parameter_set_id
    b.ue(0); // seq_parameter_set_id
    b.flag(s.cabac);
    b.flag(false); // bottom_field_pic_order_in_frame_present_flag
    b.ue(0); // num_slice_groups_minus1
    b.ue(0); // num_ref_idx_l0_default_active_minus1
    b.ue(0); // num_ref_idx_l1_default_active_minus1
    b.flag(false); // weighted_pred_flag
    b.u(2, 0); // weighted_bipred_idc
    b.se(i32::from(s.pic_init_qp) - 26);
    b.se(0); // pic_init_qs_minus26
    b.se(0); // chroma_qp_index_offset
    b.flag(true); // deblocking_filter_control_present_flag
    b.flag(false); // constrained_intra_pred_flag
    b.flag(false); // redundant_pic_cnt_present_flag
    if s.profile_idc == 100 {
        b.flag(s.transform_8x8);
        b.flag(false); // pic_scaling_matrix_present_flag
        b.se(0); // second_chroma_qp_index_offset
    }
    nal(3, 8, &b.trailing())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads bits back, for checking what was written.
    struct Reader<'a> {
        data: &'a [u8],
        pos: usize,
    }

    impl Reader<'_> {
        fn u(&mut self, n: u32) -> u32 {
            let mut v = 0;
            for _ in 0..n {
                let bit = (self.data[self.pos / 8] >> (7 - self.pos % 8)) & 1;
                v = (v << 1) | u32::from(bit);
                self.pos += 1;
            }
            v
        }
        fn ue(&mut self) -> u32 {
            let mut zeros = 0;
            while self.u(1) == 0 {
                zeros += 1;
            }
            ((1u64 << zeros) - 1 + u64::from(self.u(zeros))) as u32
        }
        fn se(&mut self) -> i32 {
            let k = self.ue() as i64;
            (if k % 2 == 1 { (k + 1) / 2 } else { -k / 2 }) as i32
        }
    }

    /// The RBSP of an Annex B NAL with its emulation prevention bytes taken out.
    fn rbsp(nal: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut zeros = 0;
        for &b in &nal[5..] {
            if zeros >= 2 && b == 3 {
                zeros = 0;
                continue;
            }
            out.push(b);
            zeros = if b == 0 { zeros + 1 } else { 0 };
        }
        out
    }

    #[test]
    fn exp_golomb_reads_back() {
        let mut b = Bits::default();
        for v in [0, 1, 2, 3, 7, 8, 255, 65535] {
            b.ue(v);
        }
        for v in [0, 1, -1, 2, -2, -26, 25] {
            b.se(v);
        }
        let bytes = b.trailing();
        let mut r = Reader {
            data: &bytes,
            pos: 0,
        };
        for v in [0, 1, 2, 3, 7, 8, 255, 65535] {
            assert_eq!(r.ue(), v);
        }
        for v in [0, 1, -1, 2, -2, -26, 25] {
            assert_eq!(r.se(), v);
        }
    }

    #[test]
    fn three_zeros_never_appear_in_a_nal() {
        let n = nal(3, 7, &[0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
        assert_eq!(&n[..5], &[0, 0, 0, 1, 0x67]);
        assert!(!n[4..].windows(3).any(|w| w[0] == 0 && w[1] == 0 && w[2] <= 3 && w[2] != 3));
        assert_eq!(rbsp(&n), vec![0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
    }

    #[test]
    fn an_sps_says_the_size_the_crop_and_no_reordering() {
        let s = Stream {
            profile_idc: 100,
            level_idc: level_for(1918, 1080, 60),
            width: 1918,
            height: 1080,
            log2_max_frame_num: 16,
            cabac: true,
            transform_8x8: true,
            pic_init_qp: 26,
        };
        let sps = sps(&s);
        assert_eq!(&sps[..8], &[0, 0, 0, 1, 0x67, 100, 0, 42]);
        let body = rbsp(&sps);
        let mut r = Reader {
            data: &body[3..],
            pos: 0,
        };
        assert_eq!(r.ue(), 0); // sps id
        assert_eq!((r.ue(), r.ue(), r.ue(), r.u(1), r.u(1)), (1, 0, 0, 0, 0));
        assert_eq!(r.ue(), 12); // log2_max_frame_num_minus4
        assert_eq!(r.ue(), 2); // poc type
        assert_eq!(r.ue(), 1); // refs
        assert_eq!(r.u(1), 0);
        assert_eq!((r.ue() + 1, r.ue() + 1), (120, 68));
        assert_eq!((r.u(1), r.u(1)), (1, 1));
        assert_eq!(r.u(1), 1, "cropped");
        assert_eq!((r.ue(), r.ue(), r.ue(), r.ue()), (0, 1, 0, 4));
        assert_eq!(r.u(1), 1, "vui");
        assert_eq!((r.u(1), r.u(1), r.u(1)), (0, 0, 1));
        assert_eq!((r.u(3), r.u(1), r.u(1)), (5, 0, 1));
        assert_eq!((r.u(8), r.u(8), r.u(8)), (1, 13, 6));
        assert_eq!((r.u(1), r.u(1), r.u(1), r.u(1), r.u(1)), (0, 0, 0, 0, 0));
        assert_eq!((r.u(1), r.u(1)), (1, 1), "bitstream restriction");
        assert_eq!((r.ue(), r.ue(), r.ue(), r.ue()), (0, 0, 15, 15));
        assert_eq!((r.ue(), r.ue()), (0, 1), "nothing reordered");
        assert_eq!(r.u(1), 1, "stop bit");
        assert_eq!(
            crate::encoder::codec_string(&sps).as_deref(),
            Some("avc1.64002a")
        );
    }

    #[test]
    fn a_pps_says_the_entropy_coder_and_the_qp() {
        let s = Stream {
            profile_idc: 100,
            level_idc: 41,
            width: 64,
            height: 64,
            log2_max_frame_num: 16,
            cabac: true,
            transform_8x8: true,
            pic_init_qp: 30,
        };
        let body = rbsp(&pps(&s));
        let mut r = Reader {
            data: &body,
            pos: 0,
        };
        assert_eq!((r.ue(), r.ue(), r.u(1), r.u(1), r.ue()), (0, 0, 1, 0, 0));
        assert_eq!((r.ue(), r.ue(), r.u(1), r.u(2)), (0, 0, 0, 0));
        assert_eq!((r.se(), r.se(), r.se()), (4, 0, 0));
        assert_eq!((r.u(1), r.u(1), r.u(1)), (1, 0, 0));
        assert_eq!((r.u(1), r.u(1), r.se()), (1, 0, 0));
    }

    #[test]
    fn the_level_follows_size_and_rate() {
        assert_eq!(level_for(1280, 720, 30), 41);
        assert_eq!(level_for(1920, 1080, 60), 42);
        assert_eq!(level_for(2560, 1600, 60), 51);
        assert_eq!(level_for(3840, 2160, 60), 52);
        assert_eq!(level_for(7680, 4320, 60), 61);
    }
}
