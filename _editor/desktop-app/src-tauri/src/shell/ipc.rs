//! sway's IPC for the shell, on the session's own socket (`SWAYSOCK`, which the session hands this app). The framing
//! is the one copy this app and `ic`'s screen service share (`_sandbox/ic/sway-ipc`).

use std::io;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use serde_json::Value;

pub(super) use intentic_sway_ipc::{
    read_frame, EVENT_BINDING, EVENT_WINDOW, EVENT_WORKSPACE, GET_TREE, GET_WORKSPACES,
};

fn socket() -> io::Result<PathBuf> {
    std::env::var_os("SWAYSOCK")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No desktop session"))
}

pub(super) fn request(kind: u32, payload: &str) -> io::Result<Value> {
    intentic_sway_ipc::request(&socket()?, kind, payload)
}

pub(super) fn command(command: &str) -> io::Result<()> {
    intentic_sway_ipc::command(&socket()?, command)
}

pub(super) fn subscribe() -> io::Result<UnixStream> {
    intentic_sway_ipc::subscribe(&socket()?, &["binding", "window", "workspace"])
}
