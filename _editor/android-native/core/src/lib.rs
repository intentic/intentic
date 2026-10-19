//! The native Android client's Rust core: see README.md.

pub mod render;
pub mod stream;
pub mod transcript;

mod jni_api;
#[cfg(feature = "surface")]
mod surface;

use std::sync::Mutex;
use stream::Stream;
use transcript::{Row, StreamSpec};

/// One open conversation: its rows, and the turn streaming into it if one is.
pub struct Conversation {
    rows: Vec<Row>,
    spec: StreamSpec,
    stream: Option<Stream>,
}

impl Conversation {
    pub fn open(fixture: &str, rows: usize) -> Result<Self, transcript::FixtureError> {
        let (rows, spec) = transcript::inflate(fixture, rows)?;
        Ok(Conversation {
            rows,
            spec,
            stream: None,
        })
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn append_user(&mut self, text: &str) -> usize {
        self.rows.push(Row {
            role: transcript::Role::User,
            text: text.into(),
            tools: Vec::new(),
        });
        self.rows.len() - 1
    }

    pub fn stream_start(&mut self, now_ms: u64, duration_ms: u64) {
        self.stream = Some(Stream::new(self.spec.clone(), now_ms, duration_ms));
    }

    pub fn streaming(&self) -> bool {
        self.stream.as_ref().is_some_and(|stream| !stream.done())
    }

    /// The rows the turn changed or added by `now_ms`, each once, in order.
    pub fn stream_tick(&mut self, now_ms: u64) -> Vec<usize> {
        let mut changed = Vec::new();
        if let Some(stream) = self.stream.as_mut() {
            stream.tick(&mut self.rows, now_ms, &mut changed);
        }
        changed.dedup();
        changed
    }
}

/// What the JNI side holds behind a handle: render runs on the app's background threads while the main thread ticks
/// the stream, so a row is cloned under the lock and rendered outside it.
pub(crate) struct Shared(pub Mutex<Conversation>);
