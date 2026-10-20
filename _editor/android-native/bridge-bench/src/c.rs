//! Plain C functions, which JNA maps by name (`JnaDirect.kt` through `Native.register`, `JnaInterface.kt` through
//! `Native.load`). What Rust hands back, Kotlin reads and then frees through the matching `_free` function.

use std::ffi::{CStr, CString, c_char};
use std::ptr;

#[unsafe(no_mangle)]
pub extern "C" fn bb_noop() {}

/// Answers the NUL-terminated UTF-8 `request` with a new string, which the caller frees with [`bb_string_free`].
///
/// # Safety
/// `request` is a NUL-terminated string that lives for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_echo(request: *const c_char) -> *mut c_char {
    let Ok(request) = unsafe { CStr::from_ptr(request) }.to_str() else {
        return ptr::null_mut();
    };
    CString::new(crate::echo(request)).map_or(ptr::null_mut(), CString::into_raw)
}

/// # Safety
/// `reply` came from [`bb_echo`] and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_string_free(reply: *mut c_char) {
    if !reply.is_null() {
        drop(unsafe { CString::from_raw(reply) });
    }
}

/// Answers `len` bytes at `input` with new bytes, their count written to `out_len`; the caller frees them with
/// [`bb_bytes_free`] and that count.
///
/// # Safety
/// `input` holds `len` bytes and `out_len` is writable, both for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_bytes(input: *const u8, len: i32, out_len: *mut i32) -> *mut u8 {
    let input: &[u8] = if len <= 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(input, len as usize) }
    };
    let out = crate::bytes(input).into_boxed_slice();
    unsafe { *out_len = out.len() as i32 };
    Box::into_raw(out).cast()
}

/// # Safety
/// `data` and `len` came from one [`bb_bytes`] call and are freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_bytes_free(data: *mut u8, len: i32) {
    if !data.is_null() {
        drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(data, len.max(0) as usize)) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_and_bytes_come_back_and_free() {
        let request = CString::new(r#"{"type":"Ping"}"#).unwrap();
        unsafe {
            let reply = bb_echo(request.as_ptr());
            assert_eq!(
                CStr::from_ptr(reply).to_str().unwrap(),
                r#"{"type":"Ping"}"#
            );
            bb_string_free(reply);

            let input = [1u8, 2, 3];
            let mut len = 0;
            let out = bb_bytes(input.as_ptr(), 3, &mut len);
            assert_eq!(std::slice::from_raw_parts(out, len as usize), &input);
            bb_bytes_free(out, len);
        }
    }
}
