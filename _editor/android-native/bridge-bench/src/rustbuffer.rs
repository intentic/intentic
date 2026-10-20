//! The same operations in the convention UniFFI's scaffolding exports and its generated Kotlin calls (`Uniffi.kt`):
//! every argument and answer that is not a number travels in a [`RustBuffer`] passed by value, every call takes a
//! [`RustCallStatus`] to report an error in, and Kotlin allocates and frees buffers through Rust. Written out by hand
//! from UniFFI 0.32's templates rather than generated, so the bench carries no bindgen step.

use std::mem::{ManuallyDrop, MaybeUninit};

/// UniFFI's `RustBuffer`: a `Vec<u8>` taken apart, owned by Rust while Kotlin holds it.
#[repr(C)]
pub struct RustBuffer {
    capacity: u64,
    len: u64,
    data: *mut u8,
}

impl RustBuffer {
    fn from_vec(vec: Vec<u8>) -> Self {
        let mut vec = ManuallyDrop::new(vec);
        RustBuffer {
            capacity: vec.capacity() as u64,
            len: vec.len() as u64,
            data: vec.as_mut_ptr(),
        }
    }

    /// # Safety
    /// The buffer came from [`RustBuffer::from_vec`] and is consumed once.
    unsafe fn into_vec(self) -> Vec<u8> {
        if self.data.is_null() {
            return Vec::new();
        }
        unsafe { Vec::from_raw_parts(self.data, self.len as usize, self.capacity as usize) }
    }
}

/// UniFFI's `RustCallStatus`: a code (0 is success) and, on an error, the error serialized into a buffer.
#[repr(C)]
pub struct RustCallStatus {
    code: i8,
    error_buf: MaybeUninit<RustBuffer>,
}

/// The scaffolding contract version Kotlin checks when it loads the library, as UniFFI's does.
#[unsafe(no_mangle)]
pub extern "C" fn bb_rb_contract_version() -> u32 {
    30
}

// One checksum per exported function, which the generated Kotlin compares on load.
#[unsafe(no_mangle)]
pub extern "C" fn bb_rb_checksum_noop() -> u16 {
    101
}

#[unsafe(no_mangle)]
pub extern "C" fn bb_rb_checksum_echo() -> u16 {
    102
}

#[unsafe(no_mangle)]
pub extern "C" fn bb_rb_checksum_bytes() -> u16 {
    103
}

/// `ffi_<crate>_rustbuffer_alloc`: a zeroed buffer of `size` bytes Kotlin writes an argument into.
#[unsafe(no_mangle)]
pub extern "C" fn bb_rb_alloc(size: u64, _status: &mut RustCallStatus) -> RustBuffer {
    RustBuffer::from_vec(vec![0; size as usize])
}

/// `ffi_<crate>_rustbuffer_free`.
///
/// # Safety
/// `buf` came from this library and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_rb_free(buf: RustBuffer, _status: &mut RustCallStatus) {
    drop(unsafe { buf.into_vec() });
}

#[unsafe(no_mangle)]
pub extern "C" fn bb_rb_noop(_status: &mut RustCallStatus) {}

/// A `String` argument arrives as its UTF-8 bytes and leaves the same way, as UniFFI lifts and lowers it.
///
/// # Safety
/// `request` came from [`bb_rb_alloc`] and is consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_rb_echo(
    request: RustBuffer,
    status: &mut RustCallStatus,
) -> RustBuffer {
    match String::from_utf8(unsafe { request.into_vec() }) {
        Ok(request) => RustBuffer::from_vec(crate::echo(&request).into_bytes()),
        Err(_) => {
            status.code = 2;
            RustBuffer::from_vec(Vec::new())
        }
    }
}

/// A `Vec<u8>` argument arrives as a big-endian `i32` length and the bytes, and leaves the same way.
///
/// # Safety
/// `input` came from [`bb_rb_alloc`] and is consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_rb_bytes(input: RustBuffer, status: &mut RustCallStatus) -> RustBuffer {
    let input = unsafe { input.into_vec() };
    let Some((len, rest)) = input.split_first_chunk::<4>() else {
        status.code = 2;
        return RustBuffer::from_vec(Vec::new());
    };
    let len = i32::from_be_bytes(*len).max(0) as usize;
    let Some(input) = rest.get(..len) else {
        status.code = 2;
        return RustBuffer::from_vec(Vec::new());
    };
    let out = crate::bytes(input);
    let mut lowered = Vec::with_capacity(4 + out.len());
    lowered.extend_from_slice(&(out.len() as i32).to_be_bytes());
    lowered.extend_from_slice(&out);
    RustBuffer::from_vec(lowered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> RustCallStatus {
        RustCallStatus {
            code: 0,
            error_buf: MaybeUninit::uninit(),
        }
    }

    #[test]
    fn echo_and_bytes_round_trip_through_buffers() {
        let mut call = status();
        let reply = unsafe { bb_rb_echo(RustBuffer::from_vec(b"{\"a\":1}".to_vec()), &mut call) };
        assert_eq!(call.code, 0);
        assert_eq!(unsafe { reply.into_vec() }, b"{\"a\":1}");

        let mut lowered = 3i32.to_be_bytes().to_vec();
        lowered.extend_from_slice(&[7, 8, 9]);
        let out = unsafe { bb_rb_bytes(RustBuffer::from_vec(lowered.clone()), &mut call) };
        assert_eq!(call.code, 0);
        assert_eq!(unsafe { out.into_vec() }, lowered);

        let buf = bb_rb_alloc(16, &mut call);
        assert_eq!(buf.len, 16);
        unsafe { bb_rb_free(buf, &mut call) };
    }
}
