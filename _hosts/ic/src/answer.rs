use std::io::Write;
use std::sync::Mutex;

/* WHERE A VERB'S OUTPUT GOES. A run of `ic` writes its two streams, as it always has; a request `ic serve` answers
(serve.rs) runs the same verb in this process, and what it writes is kept here instead, every byte, so the answer is
what the per-call verb would have printed. One request runs at a time (serve.rs says why), so the capture is the
process's, not a thread's: a verb's own worker threads (a listing's reads in parallel) are caught with it. Every write
of the crate's goes through here: the `println!`/`eprintln!` that main.rs shadows, the renderer's (ui.rs), and the
JSON lines a verb emits (sandbox/fix/report.rs). */

#[derive(Default)]
pub struct Captured {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Both streams in the order they were written: what a caller reading the two as one sees (the machine agent's
    /// runIc), line for line.
    pub output: Vec<u8>,
}

static CAPTURE: Mutex<Option<Captured>> = Mutex::new(None);

fn captured() -> std::sync::MutexGuard<'static, Option<Captured>> {
    CAPTURE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `body` with every write of this process kept rather than printed, and answers it with what was written.
pub fn capture<T>(body: impl FnOnce() -> T) -> (T, Captured) {
    *captured() = Some(Captured::default());
    // A panic in the verb still ends the capture, so the next request does not inherit it.
    struct End;
    impl Drop for End {
        fn drop(&mut self) {
            if let Ok(mut held) = CAPTURE.lock() {
                held.take();
            }
        }
    }
    let end = End;
    let value = body();
    let kept = captured().take().unwrap_or_default();
    drop(end);
    (value, kept)
}

#[derive(Clone, Copy)]
enum Which {
    Out,
    Err,
}

/// One of the process's two streams, as every writer in this crate holds it.
pub struct Stream(Which);

pub fn stdout() -> Stream {
    Stream(Which::Out)
}

pub fn stderr() -> Stream {
    Stream(Which::Err)
}

impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        {
            let mut held = captured();
            if let Some(kept) = held.as_mut() {
                match self.0 {
                    Which::Out => kept.stdout.extend_from_slice(bytes),
                    Which::Err => kept.stderr.extend_from_slice(bytes),
                }
                kept.output.extend_from_slice(bytes);
                return Ok(bytes.len());
            }
        }
        match self.0 {
            Which::Out => std::io::stdout().lock().write(bytes),
            Which::Err => std::io::stderr().lock().write(bytes),
        }
    }

    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        // One lock for the whole buffer, so a line written by one thread is never split by another's.
        {
            let mut held = captured();
            if let Some(kept) = held.as_mut() {
                match self.0 {
                    Which::Out => kept.stdout.extend_from_slice(bytes),
                    Which::Err => kept.stderr.extend_from_slice(bytes),
                }
                kept.output.extend_from_slice(bytes);
                return Ok(());
            }
        }
        match self.0 {
            Which::Out => std::io::stdout().lock().write_all(bytes),
            Which::Err => std::io::stderr().lock().write_all(bytes),
        }
    }

    // A formatted line is one write, as std's own stream makes it (it holds its lock for the whole line).
    fn write_fmt(&mut self, args: std::fmt::Arguments<'_>) -> std::io::Result<()> {
        let text = std::fmt::format(args);
        self.write_all(text.as_bytes())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if captured().is_some() {
            return Ok(());
        }
        match self.0 {
            Which::Out => std::io::stdout().flush(),
            Which::Err => std::io::stderr().flush(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_keeps_both_streams_and_their_order_and_ends_with_its_body() {
        let ((), kept) = capture(|| {
            let _ = writeln!(stdout(), "[1]");
            let _ = writeln!(stderr(), "intentic: careful");
            let _ = writeln!(stdout(), "[2]");
        });
        assert_eq!(kept.stdout, b"[1]\n[2]\n");
        assert_eq!(kept.stderr, b"intentic: careful\n");
        assert_eq!(kept.output, b"[1]\nintentic: careful\n[2]\n");
        assert!(captured().is_none());
    }
}
