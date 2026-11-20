//! What one viewer's socket has yet to send, filled by its terminal's hub and emptied by the socket: netd's design
//! (`_sandbox/netd/crates/netd/src/term/hub.rs`). A viewer that falls OUTBOX_HIGH behind drops everything after that,
//! and once its socket has drained it is drawn a fresh snapshot instead of the backlog.

use std::sync::Mutex;

use bytes::{Bytes, BytesMut};
use tokio::sync::Notify;

/// Past this much queued for one viewer, its output is dropped until it drains and takes a fresh snapshot.
pub const OUTBOX_HIGH: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Delivery {
    Live,
    /// Fell behind: everything is dropped until the socket has drained.
    Stalled,
    /// Drained, and the socket has asked the hub for a snapshot.
    Resyncing,
}

struct Queue {
    bytes: BytesMut,
    delivery: Delivery,
    ended: Option<(i32, Option<String>)>,
    grid: Option<(u16, u16)>,
}

pub struct Outbox {
    queue: Mutex<Queue>,
    ready: Notify,
}

/// What a socket takes from its outbox next.
#[derive(Debug, PartialEq, Eq)]
pub enum Taken {
    Grid(u16, u16),
    Bytes(Bytes),
    /// Drained after a stall: the socket asks the hub for a snapshot.
    Resync,
    Ended(i32, Option<String>),
    Nothing,
}

impl Default for Outbox {
    fn default() -> Self {
        Self {
            queue: Mutex::new(Queue {
                bytes: BytesMut::new(),
                delivery: Delivery::Live,
                ended: None,
                grid: None,
            }),
            ready: Notify::new(),
        }
    }
}

impl Outbox {
    fn with<T>(&self, change: impl FnOnce(&mut Queue) -> T) -> T {
        let value = change(&mut self.queue.lock().expect("outbox poisoned"));
        self.ready.notify_one();
        value
    }

    /// The program's output, for a viewer that is keeping up.
    pub fn output(&self, bytes: &[u8]) {
        self.with(|queue| {
            if queue.delivery != Delivery::Live {
                return;
            }
            queue.bytes.extend_from_slice(bytes);
            if queue.bytes.len() > OUTBOX_HIGH {
                queue.bytes = BytesMut::new();
                queue.delivery = Delivery::Stalled;
            }
        });
    }

    /// A snapshot replaces whatever was queued: it draws the screen as it stands at the moment it was cut.
    pub fn snapshot(&self, snapshot: &[u8]) {
        self.with(|queue| {
            queue.bytes.clear();
            queue.bytes.extend_from_slice(snapshot);
            queue.delivery = Delivery::Live;
        });
    }

    pub fn grid(&self, cols: u16, rows: u16) {
        self.with(|queue| queue.grid = Some((cols, rows)));
    }

    pub fn end(&self, code: i32, reason: Option<String>) {
        self.with(|queue| {
            queue.ended.get_or_insert((code, reason));
        });
    }

    /// At most `max` bytes, then the end once everything before it is taken.
    pub fn take(&self, max: usize) -> Taken {
        let mut queue = self.queue.lock().expect("outbox poisoned");
        // The grid first, under the same lock as the bytes: output drawn for a new size never overtakes its announcement.
        if let Some((cols, rows)) = queue.grid.take() {
            return Taken::Grid(cols, rows);
        }
        if !queue.bytes.is_empty() {
            let length = queue.bytes.len().min(max);
            return Taken::Bytes(queue.bytes.split_to(length).freeze());
        }
        if let Some((code, reason)) = queue.ended.clone() {
            return Taken::Ended(code, reason);
        }
        if queue.delivery == Delivery::Stalled {
            queue.delivery = Delivery::Resyncing;
            return Taken::Resync;
        }
        Taken::Nothing
    }

    pub async fn changed(&self) {
        self.ready.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_viewer_that_falls_behind_drops_its_backlog_and_asks_once_for_a_snapshot() {
        let outbox = Outbox::default();
        outbox.output(&vec![b'x'; OUTBOX_HIGH + 1]);
        outbox.output(b"lost while stalled");
        assert_eq!(outbox.take(16), Taken::Resync);
        outbox.output(b"lost while resyncing");
        assert_eq!(outbox.take(16), Taken::Nothing);
        outbox.snapshot(b"screen");
        outbox.output(b"+live");
        assert_eq!(
            outbox.take(64),
            Taken::Bytes(Bytes::from_static(b"screen+live"))
        );
    }

    #[test]
    fn the_grid_goes_before_the_bytes_and_the_end_after_them() {
        let outbox = Outbox::default();
        outbox.output(b"abc");
        outbox.end(0, None);
        outbox.grid(100, 30);
        assert_eq!(outbox.take(2), Taken::Grid(100, 30));
        assert_eq!(outbox.take(2), Taken::Bytes(Bytes::from_static(b"ab")));
        assert_eq!(outbox.take(2), Taken::Bytes(Bytes::from_static(b"c")));
        assert_eq!(outbox.take(2), Taken::Ended(0, None));
    }
}
