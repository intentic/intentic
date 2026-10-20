//! What the bridge bench's Kotlin calls: three operations, each exported three ways. `jni` holds the functions
//! `dev.intentic.bridgebench.Jni` binds by name, `c` the plain C functions JNA maps, and `rustbuffer` the same
//! operations in the convention UniFFI's generated Kotlin calls (a `RustBuffer` struct by value, a call-status struct
//! per call). Every way does the same work in Rust, so what differs between them is the crossing.

mod c;
mod jni;
mod rustbuffer;

/// The reply to a request: a new string with the request's text, as an answer built from a request would be.
fn echo(request: &str) -> String {
    request.to_owned()
}

/// The bytes analogue of [`echo`].
fn bytes(input: &[u8]) -> Vec<u8> {
    input.to_vec()
}
