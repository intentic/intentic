//! The part of libva's API the VA-API encoder uses, written out by hand from libva 2.22's headers (va.h, va_enc_h264.h,
//! va_vpp.h, va_drmcommon.h; MIT) so that building needs no libva headers, and opened at run time with libloading so the
//! binary runs where there is no libva. The structs keep libva's layout exactly (the tests hold their sizes and the
//! offsets that matter to what bindgen made of the same headers); bitfields are the `u32` they share, set through the
//! helpers below.

#![allow(
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    dead_code
)]

use std::ffi::{c_char, c_int, c_uint, c_void};

pub type VADisplay = *mut c_void;
pub type VAStatus = c_int;
pub type VAGenericID = c_uint;
pub type VAConfigID = VAGenericID;
pub type VAContextID = VAGenericID;
pub type VASurfaceID = VAGenericID;
pub type VABufferID = VAGenericID;
pub type VAImageID = VAGenericID;
pub type VAProfile = c_int;
pub type VAEntrypoint = c_int;
pub type VABufferType = c_int;
pub type VAMessageCallback = Option<unsafe extern "C" fn(*mut c_void, *const c_char)>;

pub const VA_STATUS_SUCCESS: VAStatus = 0;
pub const VA_INVALID_ID: u32 = 0xffff_ffff;
pub const VA_INVALID_SURFACE: u32 = VA_INVALID_ID;
pub const VA_ATTRIB_NOT_SUPPORTED: u32 = 0x8000_0000;
pub const VA_PROGRESSIVE: c_int = 1;

pub const VAProfileNone: VAProfile = -1;
pub const VAProfileH264Main: VAProfile = 6;
pub const VAProfileH264High: VAProfile = 7;
pub const VAProfileH264ConstrainedBaseline: VAProfile = 13;

pub const VAEntrypointEncSlice: VAEntrypoint = 6;
pub const VAEntrypointEncSliceLP: VAEntrypoint = 8;
pub const VAEntrypointVideoProc: VAEntrypoint = 10;

pub const VAConfigAttribRTFormat: c_int = 0;
pub const VAConfigAttribRateControl: c_int = 5;
pub const VAConfigAttribEncPackedHeaders: c_int = 10;
pub const VAConfigAttribEncMaxRefFrames: c_int = 13;

pub const VA_RT_FORMAT_YUV420: u32 = 0x0000_0001;
pub const VA_RT_FORMAT_RGB32: u32 = 0x0002_0000;

pub const VA_RC_CBR: u32 = 0x0000_0002;
pub const VA_RC_VBR: u32 = 0x0000_0004;
pub const VA_RC_CQP: u32 = 0x0000_0010;

pub const VA_ENC_PACKED_HEADER_SEQUENCE: u32 = 0x0000_0001;

pub const VA_FOURCC_NV12: u32 = 0x3231_564E;
pub const VA_FOURCC_BGRX: u32 = 0x5852_4742;
pub const VA_FOURCC_BGRA: u32 = 0x4152_4742;
pub const VA_FOURCC_RGBX: u32 = 0x5842_4752;
pub const VA_FOURCC_RGBA: u32 = 0x4142_4752;

pub const VAEncCodedBufferType: VABufferType = 21;
pub const VAEncSequenceParameterBufferType: VABufferType = 22;
pub const VAEncPictureParameterBufferType: VABufferType = 23;
pub const VAEncSliceParameterBufferType: VABufferType = 24;
pub const VAEncPackedHeaderParameterBufferType: VABufferType = 25;
pub const VAEncPackedHeaderDataBufferType: VABufferType = 26;
pub const VAEncMiscParameterBufferType: VABufferType = 27;
pub const VAProcPipelineParameterBufferType: VABufferType = 41;

pub const VAEncMiscParameterTypeFrameRate: u32 = 0;
pub const VAEncMiscParameterTypeRateControl: u32 = 1;
pub const VAEncMiscParameterTypeHRD: u32 = 5;

pub const VAEncPackedHeaderSequence: u32 = 1;

pub const VA_PICTURE_H264_INVALID: u32 = 0x0000_0001;
pub const VA_PICTURE_H264_SHORT_TERM_REFERENCE: u32 = 0x0000_0008;

pub const VASurfaceAttribPixelFormat: c_int = 1;
pub const VASurfaceAttribMemoryType: c_int = 6;
pub const VASurfaceAttribExternalBufferDescriptor: c_int = 7;
pub const VASurfaceAttribUsageHint: c_int = 8;
pub const VAGenericValueTypeInteger: c_int = 1;
pub const VAGenericValueTypePointer: c_int = 3;
pub const VA_SURFACE_ATTRIB_SETTABLE: u32 = 0x0000_0002;
pub const VA_SURFACE_ATTRIB_USAGE_HINT_ENCODER: i32 = 0x0000_0002;
pub const VA_SURFACE_ATTRIB_USAGE_HINT_VPP_READ: i32 = 0x0000_0004;
pub const VA_SURFACE_ATTRIB_USAGE_HINT_VPP_WRITE: i32 = 0x0000_0008;
pub const VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2: i32 = 0x4000_0000;

pub const VAProcColorStandardBT601: c_int = 1;
pub const VAProcColorStandardSRGB: c_int = 8;
pub const VA_LSB_FIRST: u32 = 1;
pub const VA_SOURCE_RANGE_REDUCED: u8 = 1;
pub const VA_SOURCE_RANGE_FULL: u8 = 2;
/// va_vpp.h's matrix_coefficients for BT.601 (H.273's SMPTE 170M).
pub const MATRIX_SMPTE170M: u8 = 6;
pub const MATRIX_RGB: u8 = 0;

/// The `slice_type` values (H.264's, mod 5).
pub const SLICE_TYPE_P: u8 = 0;
pub const SLICE_TYPE_I: u8 = 2;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAConfigAttrib {
    pub type_: c_int,
    pub value: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAGenericValue {
    pub type_: c_int,
    /// A union of int, float, pointer and function pointer: 8 bytes, 8-aligned.
    pub value: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VASurfaceAttrib {
    pub type_: c_int,
    pub flags: u32,
    pub value: VAGenericValue,
}

impl VASurfaceAttrib {
    pub fn int(type_: c_int, v: i32) -> VASurfaceAttrib {
        VASurfaceAttrib {
            type_,
            flags: VA_SURFACE_ATTRIB_SETTABLE,
            value: VAGenericValue {
                type_: VAGenericValueTypeInteger,
                value: v as u32 as u64,
            },
        }
    }

    pub fn pointer(type_: c_int, p: *mut c_void) -> VASurfaceAttrib {
        VASurfaceAttrib {
            type_,
            flags: VA_SURFACE_ATTRIB_SETTABLE,
            value: VAGenericValue {
                type_: VAGenericValueTypePointer,
                value: p as u64,
            },
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VADRMPRIMEObject {
    pub fd: c_int,
    pub size: u32,
    pub drm_format_modifier: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VADRMPRIMELayer {
    pub drm_format: u32,
    pub num_planes: u32,
    pub object_index: [u32; 4],
    pub offset: [u32; 4],
    pub pitch: [u32; 4],
}

/// `VADRMPRIMESurfaceDescriptor`: a surface as DMA-BUF objects and the layers laid out in them.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VADRMPRIMESurfaceDescriptor {
    pub fourcc: u32,
    pub width: u32,
    pub height: u32,
    pub num_objects: u32,
    pub objects: [VADRMPRIMEObject; 4],
    pub num_layers: u32,
    pub layers: [VADRMPRIMELayer; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAImageFormat {
    pub fourcc: u32,
    pub byte_order: u32,
    pub bits_per_pixel: u32,
    pub depth: u32,
    pub red_mask: u32,
    pub green_mask: u32,
    pub blue_mask: u32,
    pub alpha_mask: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAImage {
    pub image_id: VAImageID,
    pub format: VAImageFormat,
    pub buf: VABufferID,
    pub width: u16,
    pub height: u16,
    pub data_size: u32,
    pub num_planes: u32,
    pub pitches: [u32; 3],
    pub offsets: [u32; 3],
    pub num_palette_entries: i32,
    pub entry_bytes: i32,
    pub component_order: [i8; 4],
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VACodedBufferSegment {
    pub size: u32,
    pub bit_offset: u32,
    pub status: u32,
    pub reserved: u32,
    pub buf: *mut c_void,
    pub next: *mut c_void,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAPictureH264 {
    pub picture_id: VASurfaceID,
    pub frame_idx: u32,
    pub flags: u32,
    pub TopFieldOrderCnt: i32,
    pub BottomFieldOrderCnt: i32,
    pub va_reserved: [u32; 4],
}

impl VAPictureH264 {
    pub const INVALID: VAPictureH264 = VAPictureH264 {
        picture_id: VA_INVALID_SURFACE,
        frame_idx: 0,
        flags: VA_PICTURE_H264_INVALID,
        TopFieldOrderCnt: 0,
        BottomFieldOrderCnt: 0,
        va_reserved: [0; 4],
    };
}

/// `seq_fields` of [`VAEncSequenceParameterBufferH264`], bit by bit as va_enc_h264.h declares them.
pub mod seq_fields {
    pub fn chroma_format_idc(v: u32) -> u32 {
        v & 3
    }
    pub fn frame_mbs_only_flag(v: u32) -> u32 {
        (v & 1) << 2
    }
    pub fn direct_8x8_inference_flag(v: u32) -> u32 {
        (v & 1) << 5
    }
    pub fn log2_max_frame_num_minus4(v: u32) -> u32 {
        (v & 0xf) << 6
    }
    pub fn pic_order_cnt_type(v: u32) -> u32 {
        (v & 3) << 10
    }
    pub fn log2_max_pic_order_cnt_lsb_minus4(v: u32) -> u32 {
        (v & 0xf) << 12
    }
}

/// `pic_fields` of [`VAEncPictureParameterBufferH264`].
pub mod pic_fields {
    pub fn idr_pic_flag(v: u32) -> u32 {
        v & 1
    }
    pub fn reference_pic_flag(v: u32) -> u32 {
        (v & 3) << 1
    }
    pub fn entropy_coding_mode_flag(v: u32) -> u32 {
        (v & 1) << 3
    }
    pub fn transform_8x8_mode_flag(v: u32) -> u32 {
        (v & 1) << 8
    }
    pub fn deblocking_filter_control_present_flag(v: u32) -> u32 {
        (v & 1) << 9
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncSequenceParameterBufferH264 {
    pub seq_parameter_set_id: u8,
    pub level_idc: u8,
    pub intra_period: u32,
    pub intra_idr_period: u32,
    pub ip_period: u32,
    pub bits_per_second: u32,
    pub max_num_ref_frames: u32,
    pub picture_width_in_mbs: u16,
    pub picture_height_in_mbs: u16,
    pub seq_fields: u32,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub num_ref_frames_in_pic_order_cnt_cycle: u8,
    pub offset_for_non_ref_pic: i32,
    pub offset_for_top_to_bottom_field: i32,
    pub offset_for_ref_frame: [i32; 256],
    pub frame_cropping_flag: u8,
    pub frame_crop_left_offset: u32,
    pub frame_crop_right_offset: u32,
    pub frame_crop_top_offset: u32,
    pub frame_crop_bottom_offset: u32,
    pub vui_parameters_present_flag: u8,
    pub vui_fields: u32,
    pub aspect_ratio_idc: u8,
    pub sar_width: u32,
    pub sar_height: u32,
    pub num_units_in_tick: u32,
    pub time_scale: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncPictureParameterBufferH264 {
    pub CurrPic: VAPictureH264,
    pub ReferenceFrames: [VAPictureH264; 16],
    pub coded_buf: VABufferID,
    pub pic_parameter_set_id: u8,
    pub seq_parameter_set_id: u8,
    pub last_picture: u8,
    pub frame_num: u16,
    pub pic_init_qp: u8,
    pub num_ref_idx_l0_active_minus1: u8,
    pub num_ref_idx_l1_active_minus1: u8,
    pub chroma_qp_index_offset: i8,
    pub second_chroma_qp_index_offset: i8,
    pub pic_fields: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncSliceParameterBufferH264 {
    pub macroblock_address: u32,
    pub num_macroblocks: u32,
    pub macroblock_info: VABufferID,
    pub slice_type: u8,
    pub pic_parameter_set_id: u8,
    pub idr_pic_id: u16,
    pub pic_order_cnt_lsb: u16,
    pub delta_pic_order_cnt_bottom: i32,
    pub delta_pic_order_cnt: [i32; 2],
    pub direct_spatial_mv_pred_flag: u8,
    pub num_ref_idx_active_override_flag: u8,
    pub num_ref_idx_l0_active_minus1: u8,
    pub num_ref_idx_l1_active_minus1: u8,
    pub RefPicList0: [VAPictureH264; 32],
    pub RefPicList1: [VAPictureH264; 32],
    pub luma_log2_weight_denom: u8,
    pub chroma_log2_weight_denom: u8,
    pub luma_weight_l0_flag: u8,
    pub luma_weight_l0: [i16; 32],
    pub luma_offset_l0: [i16; 32],
    pub chroma_weight_l0_flag: u8,
    pub chroma_weight_l0: [[i16; 2]; 32],
    pub chroma_offset_l0: [[i16; 2]; 32],
    pub luma_weight_l1_flag: u8,
    pub luma_weight_l1: [i16; 32],
    pub luma_offset_l1: [i16; 32],
    pub chroma_weight_l1_flag: u8,
    pub chroma_weight_l1: [[i16; 2]; 32],
    pub chroma_offset_l1: [[i16; 2]; 32],
    pub cabac_init_idc: u8,
    pub slice_qp_delta: i8,
    pub disable_deblocking_filter_idc: u8,
    pub slice_alpha_c0_offset_div2: i8,
    pub slice_beta_offset_div2: i8,
    pub va_reserved: [u32; 4],
}

/// The header of a misc parameter buffer; its payload follows at offset 4.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterBuffer {
    pub type_: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterRateControl {
    pub bits_per_second: u32,
    pub target_percentage: u32,
    pub window_size: u32,
    pub initial_qp: u32,
    pub min_qp: u32,
    pub basic_unit_size: u32,
    /// reset:1, disable_frame_skip:1, disable_bit_stuffing:1, mb_rate_control:4, temporal_id:8, cfs_I_frames:1,
    /// enable_parallel_brc:1, enable_dynamic_scaling:1, frame_tolerance_mode:2, reserved:12.
    pub rc_flags: u32,
    pub ICQ_quality_factor: u32,
    pub max_qp: u32,
    pub quality_factor: u32,
    pub target_frame_size: u32,
    pub va_reserved: [u32; 4],
}

pub mod rc_flags {
    pub const RESET: u32 = 1;
    pub const DISABLE_FRAME_SKIP: u32 = 1 << 1;
    pub const DISABLE_BIT_STUFFING: u32 = 1 << 2;
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterHRD {
    pub initial_buffer_fullness: u32,
    pub buffer_size: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterFrameRate {
    /// Frames per second, or (denominator << 16 | numerator).
    pub framerate: u32,
    pub framerate_flags: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncPackedHeaderParameterBuffer {
    pub type_: u32,
    pub bit_length: u32,
    pub has_emulation_bytes: u8,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VARectangle {
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAProcColorProperties {
    pub chroma_sample_location: u8,
    pub color_range: u8,
    pub colour_primaries: u8,
    pub transfer_characteristics: u8,
    pub matrix_coefficients: u8,
    pub reserved: [u8; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAProcPipelineParameterBuffer {
    pub surface: VASurfaceID,
    pub surface_region: *const VARectangle,
    pub surface_color_standard: c_int,
    pub output_region: *const VARectangle,
    pub output_background_color: u32,
    pub output_color_standard: c_int,
    pub pipeline_flags: u32,
    pub filter_flags: u32,
    pub filters: *mut VABufferID,
    pub num_filters: u32,
    pub forward_references: *mut VASurfaceID,
    pub num_forward_references: u32,
    pub backward_references: *mut VASurfaceID,
    pub num_backward_references: u32,
    pub rotation_state: u32,
    pub blend_state: *const c_void,
    pub mirror_state: u32,
    pub additional_outputs: *mut VASurfaceID,
    pub num_additional_outputs: u32,
    pub input_surface_flag: u32,
    pub output_surface_flag: u32,
    pub input_color_properties: VAProcColorProperties,
    pub output_color_properties: VAProcColorProperties,
    pub processing_mode: c_int,
    pub output_hdr_metadata: *mut c_void,
    pub va_reserved: [u32; 16],
}

/// A zeroed `T`: every libva parameter struct starts as zero (its reserved words must be).
pub fn zeroed<T: Copy>() -> T {
    // SAFETY: used only for the plain-data structs above, for which all-zero bytes are a valid value (null pointers,
    // zero integers).
    unsafe { std::mem::zeroed() }
}

/// libva's entry points, from libva.so.2 and libva-drm.so.2.
pub struct Va {
    _va: libloading::Library,
    _drm: libloading::Library,
    pub vaGetDisplayDRM: unsafe extern "C" fn(c_int) -> VADisplay,
    pub vaInitialize: unsafe extern "C" fn(VADisplay, *mut c_int, *mut c_int) -> VAStatus,
    pub vaTerminate: unsafe extern "C" fn(VADisplay) -> VAStatus,
    pub vaErrorStr: unsafe extern "C" fn(VAStatus) -> *const c_char,
    pub vaQueryVendorString: unsafe extern "C" fn(VADisplay) -> *const c_char,
    pub vaSetInfoCallback: Option<
        unsafe extern "C" fn(VADisplay, VAMessageCallback, *mut c_void) -> VAMessageCallback,
    >,
    pub vaSetErrorCallback: Option<
        unsafe extern "C" fn(VADisplay, VAMessageCallback, *mut c_void) -> VAMessageCallback,
    >,
    pub vaSetDriverName: Option<unsafe extern "C" fn(VADisplay, *const c_char) -> VAStatus>,
    pub vaMaxNumEntrypoints: unsafe extern "C" fn(VADisplay) -> c_int,
    pub vaQueryConfigEntrypoints:
        unsafe extern "C" fn(VADisplay, VAProfile, *mut VAEntrypoint, *mut c_int) -> VAStatus,
    pub vaGetConfigAttributes: unsafe extern "C" fn(
        VADisplay,
        VAProfile,
        VAEntrypoint,
        *mut VAConfigAttrib,
        c_int,
    ) -> VAStatus,
    pub vaCreateConfig: unsafe extern "C" fn(
        VADisplay,
        VAProfile,
        VAEntrypoint,
        *mut VAConfigAttrib,
        c_int,
        *mut VAConfigID,
    ) -> VAStatus,
    pub vaDestroyConfig: unsafe extern "C" fn(VADisplay, VAConfigID) -> VAStatus,
    pub vaCreateSurfaces: unsafe extern "C" fn(
        VADisplay,
        c_uint,
        c_uint,
        c_uint,
        *mut VASurfaceID,
        c_uint,
        *mut VASurfaceAttrib,
        c_uint,
    ) -> VAStatus,
    pub vaDestroySurfaces: unsafe extern "C" fn(VADisplay, *mut VASurfaceID, c_int) -> VAStatus,
    pub vaCreateContext: unsafe extern "C" fn(
        VADisplay,
        VAConfigID,
        c_int,
        c_int,
        c_int,
        *mut VASurfaceID,
        c_int,
        *mut VAContextID,
    ) -> VAStatus,
    pub vaDestroyContext: unsafe extern "C" fn(VADisplay, VAContextID) -> VAStatus,
    pub vaCreateBuffer: unsafe extern "C" fn(
        VADisplay,
        VAContextID,
        VABufferType,
        c_uint,
        c_uint,
        *mut c_void,
        *mut VABufferID,
    ) -> VAStatus,
    pub vaDestroyBuffer: unsafe extern "C" fn(VADisplay, VABufferID) -> VAStatus,
    pub vaMapBuffer: unsafe extern "C" fn(VADisplay, VABufferID, *mut *mut c_void) -> VAStatus,
    pub vaUnmapBuffer: unsafe extern "C" fn(VADisplay, VABufferID) -> VAStatus,
    pub vaBeginPicture: unsafe extern "C" fn(VADisplay, VAContextID, VASurfaceID) -> VAStatus,
    pub vaRenderPicture:
        unsafe extern "C" fn(VADisplay, VAContextID, *mut VABufferID, c_int) -> VAStatus,
    pub vaEndPicture: unsafe extern "C" fn(VADisplay, VAContextID) -> VAStatus,
    pub vaSyncSurface: unsafe extern "C" fn(VADisplay, VASurfaceID) -> VAStatus,
    pub vaDeriveImage: unsafe extern "C" fn(VADisplay, VASurfaceID, *mut VAImage) -> VAStatus,
    pub vaCreateImage:
        unsafe extern "C" fn(VADisplay, *mut VAImageFormat, c_int, c_int, *mut VAImage) -> VAStatus,
    pub vaPutImage: unsafe extern "C" fn(
        VADisplay,
        VASurfaceID,
        VAImageID,
        c_int,
        c_int,
        c_uint,
        c_uint,
        c_int,
        c_int,
        c_uint,
        c_uint,
    ) -> VAStatus,
    pub vaDestroyImage: unsafe extern "C" fn(VADisplay, VAImageID) -> VAStatus,
    pub vaExportSurfaceHandle:
        Option<unsafe extern "C" fn(VADisplay, VASurfaceID, u32, u32, *mut c_void) -> VAStatus>,
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {
        // SAFETY: the symbol is libva's, with the signature va.h declares, which the field's type repeats.
        *unsafe { $lib.get(concat!($name, "\0").as_bytes()) }
            .map_err(|e| format!("{} lacks {}: {e}", "libva", $name))?
    };
}

macro_rules! opt_sym {
    ($lib:expr, $name:literal) => {
        // SAFETY: as `sym!`; absent in an older libva, which is fine.
        unsafe { $lib.get(concat!($name, "\0").as_bytes()) }
            .ok()
            .map(|s| *s)
    };
}

impl Va {
    /// Opens libva and libva-drm (the driver's packages install both); an error names what is missing.
    pub fn load() -> Result<Va, String> {
        // SAFETY: loading a shared library runs its constructors; libva's only set up its own state.
        let va = unsafe { libloading::Library::new("libva.so.2") }
            .map_err(|e| format!("libva.so.2 not found ({e})"))?;
        let drm = unsafe { libloading::Library::new("libva-drm.so.2") }
            .map_err(|e| format!("libva-drm.so.2 not found ({e})"))?;
        Ok(Va {
            vaGetDisplayDRM: sym!(drm, "vaGetDisplayDRM"),
            vaInitialize: sym!(va, "vaInitialize"),
            vaTerminate: sym!(va, "vaTerminate"),
            vaErrorStr: sym!(va, "vaErrorStr"),
            vaQueryVendorString: sym!(va, "vaQueryVendorString"),
            vaSetInfoCallback: opt_sym!(va, "vaSetInfoCallback"),
            vaSetErrorCallback: opt_sym!(va, "vaSetErrorCallback"),
            vaSetDriverName: opt_sym!(va, "vaSetDriverName"),
            vaMaxNumEntrypoints: sym!(va, "vaMaxNumEntrypoints"),
            vaQueryConfigEntrypoints: sym!(va, "vaQueryConfigEntrypoints"),
            vaGetConfigAttributes: sym!(va, "vaGetConfigAttributes"),
            vaCreateConfig: sym!(va, "vaCreateConfig"),
            vaDestroyConfig: sym!(va, "vaDestroyConfig"),
            vaCreateSurfaces: sym!(va, "vaCreateSurfaces"),
            vaDestroySurfaces: sym!(va, "vaDestroySurfaces"),
            vaCreateContext: sym!(va, "vaCreateContext"),
            vaDestroyContext: sym!(va, "vaDestroyContext"),
            vaCreateBuffer: sym!(va, "vaCreateBuffer"),
            vaDestroyBuffer: sym!(va, "vaDestroyBuffer"),
            vaMapBuffer: sym!(va, "vaMapBuffer"),
            vaUnmapBuffer: sym!(va, "vaUnmapBuffer"),
            vaBeginPicture: sym!(va, "vaBeginPicture"),
            vaRenderPicture: sym!(va, "vaRenderPicture"),
            vaEndPicture: sym!(va, "vaEndPicture"),
            vaSyncSurface: sym!(va, "vaSyncSurface"),
            vaDeriveImage: sym!(va, "vaDeriveImage"),
            vaCreateImage: sym!(va, "vaCreateImage"),
            vaPutImage: sym!(va, "vaPutImage"),
            vaDestroyImage: sym!(va, "vaDestroyImage"),
            vaExportSurfaceHandle: opt_sym!(va, "vaExportSurfaceHandle"),
            _va: va,
            _drm: drm,
        })
    }

    /// libva's words for a status.
    pub fn error(&self, status: VAStatus) -> String {
        // SAFETY: vaErrorStr returns a static string for any status.
        let s = unsafe { (self.vaErrorStr)(status) };
        if s.is_null() {
            format!("VA status {status}")
        } else {
            // SAFETY: a NUL-terminated static string.
            unsafe { std::ffi::CStr::from_ptr(s) }
                .to_string_lossy()
                .into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    /// The sizes and offsets bindgen computed from libva 2.22's own headers on x86_64.
    #[test]
    fn the_structs_keep_libvas_layout() {
        assert_eq!(size_of::<VAConfigAttrib>(), 8);
        assert_eq!(size_of::<VASurfaceAttrib>(), 24);
        assert_eq!(size_of::<VADRMPRIMESurfaceDescriptor>(), 312);
        assert_eq!(size_of::<VAImageFormat>(), 48);
        assert_eq!(size_of::<VAImage>(), 120);
        assert_eq!(size_of::<VACodedBufferSegment>(), 48);
        assert_eq!(size_of::<VAPictureH264>(), 36);
        assert_eq!(size_of::<VAEncSequenceParameterBufferH264>(), 1132);
        assert_eq!(size_of::<VAEncPictureParameterBufferH264>(), 648);
        assert_eq!(size_of::<VAEncSliceParameterBufferH264>(), 3140);
        assert_eq!(size_of::<VAEncMiscParameterRateControl>(), 60);
        assert_eq!(size_of::<VAEncMiscParameterHRD>(), 24);
        assert_eq!(size_of::<VAEncMiscParameterFrameRate>(), 24);
        assert_eq!(size_of::<VAEncPackedHeaderParameterBuffer>(), 28);
        assert_eq!(size_of::<VAProcPipelineParameterBuffer>(), 224);
        assert_eq!(offset_of!(VAEncSequenceParameterBufferH264, seq_fields), 28);
        assert_eq!(
            offset_of!(VAEncSequenceParameterBufferH264, offset_for_ref_frame),
            44
        );
        assert_eq!(
            offset_of!(VAEncSequenceParameterBufferH264, vui_fields),
            1092
        );
        assert_eq!(
            offset_of!(VAEncSequenceParameterBufferH264, time_scale),
            1112
        );
        assert_eq!(offset_of!(VAEncPictureParameterBufferH264, coded_buf), 612);
        assert_eq!(offset_of!(VAEncPictureParameterBufferH264, frame_num), 620);
        assert_eq!(
            offset_of!(VAEncPictureParameterBufferH264, pic_init_qp),
            622
        );
        assert_eq!(offset_of!(VAEncPictureParameterBufferH264, pic_fields), 628);
        assert_eq!(offset_of!(VAEncSliceParameterBufferH264, idr_pic_id), 14);
        assert_eq!(offset_of!(VAEncSliceParameterBufferH264, RefPicList0), 36);
        assert_eq!(
            offset_of!(VAEncSliceParameterBufferH264, luma_weight_l0),
            2344
        );
        assert_eq!(
            offset_of!(VAEncSliceParameterBufferH264, cabac_init_idc),
            3118
        );
        assert_eq!(
            offset_of!(VAEncPackedHeaderParameterBuffer, has_emulation_bytes),
            8
        );
        assert_eq!(
            offset_of!(VAProcPipelineParameterBuffer, input_color_properties),
            132
        );
        assert_eq!(
            offset_of!(VAProcPipelineParameterBuffer, processing_mode),
            148
        );
        assert_eq!(
            offset_of!(VAProcPipelineParameterBuffer, output_hdr_metadata),
            152
        );
        assert_eq!(offset_of!(VAImage, pitches), 68);
    }
}
