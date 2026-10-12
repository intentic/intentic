use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::util::{iso_utc, timestamp, Fail, Result};

/* Every connect/recreate leaves a log on this machine — otherwise a failed setup is only ever seen on the terminal it scrolled past.

Each line ic writes itself (a section, a step, the verdict) starts with its moment in UTC, so an agent reading the log
next to the sandbox's own can line the two up; output copied in as it streams (a docker build or pull) is left as
docker wrote it. And one file stops growing at CAP: a build that prints for an hour must not leave a log nobody can
open. What streams in past it is left out, except its last TAIL bytes, which are written when ic speaks again or the log
closes: the end of a failed build is where its error is. */

/// How large one log grows from streamed output before the middle of what follows is left out.
const CAP: u64 = 8 << 20;

/// How much of the output left out is kept: its end.
const TAIL: usize = 256 << 10;

pub fn log_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("INTENTIC_LOG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    home_dir().join(".intentic").join("logs")
}

/// ~/.intentic — the per-user state dir (channel records, logs). INTENTIC_HOME to move it, as recreate.sh
/// honored for its channel record.
pub fn intentic_home() -> PathBuf {
    if let Ok(dir) = std::env::var("INTENTIC_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    home_dir().join(".intentic")
}

fn home_dir() -> PathBuf {
    #[cfg(unix)]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
}

/// Clonable so the tee threads that mirror a docker build/pull into the log can share it with the flow.
#[derive(Clone)]
pub struct Log {
    pub path: PathBuf,
    file: Arc<Mutex<Sink>>,
}

/// The file, and what has gone into it: how much, and the output held back past CAP.
struct Sink {
    out: Box<dyn Write + Send>,
    written: u64,
    /// Bytes streamed in past CAP since ic last spoke, the TAIL of which are held in `tail`.
    skipped: u64,
    tail: Vec<u8>,
}

impl Sink {
    fn new(out: Box<dyn Write + Send>) -> Sink {
        Sink {
            out,
            written: 0,
            skipped: 0,
            tail: Vec::new(),
        }
    }

    fn put(&mut self, bytes: &[u8]) {
        if self.out.write_all(bytes).is_ok() {
            self.written += bytes.len() as u64;
        }
    }

    /// Streamed output: written while the file is under CAP, held back (its end only) past it.
    fn stream(&mut self, bytes: &[u8]) {
        if self.skipped == 0 && self.written + bytes.len() as u64 <= CAP {
            self.put(bytes);
            return;
        }
        self.skipped += bytes.len() as u64;
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > TAIL {
            let cut = self.tail.len() - TAIL;
            // From the next line on when one starts soon, so the kept end does not open mid-line.
            let start = self.tail[cut..]
                .iter()
                .take(4096)
                .position(|byte| *byte == b'\n')
                .map_or(cut, |at| cut + at + 1);
            self.tail.drain(..start);
        }
    }

    /// What was held back: how much was left out, then the end of it.
    fn flush_tail(&mut self) {
        if self.skipped == 0 {
            return;
        }
        let tail = std::mem::take(&mut self.tail);
        let left_out = self.skipped - tail.len() as u64;
        self.skipped = 0;
        let note = format!(
            "[ic: {left_out} bytes of output left out here to keep this log under {} MiB; the last {} bytes follow]\n",
            CAP >> 20,
            tail.len()
        );
        self.put(note.as_bytes());
        self.put(&tail);
        if !tail.ends_with(b"\n") {
            self.put(b"\n");
        }
    }

    /// A line ic writes itself, always kept, after whatever output it follows.
    fn line(&mut self, text: &str, at: u64) {
        self.flush_tail();
        self.put(format!("{} {text}\n", iso_utc(at)).as_bytes());
        let _ = self.out.flush();
    }
}

impl Drop for Sink {
    fn drop(&mut self) {
        self.flush_tail();
        let _ = self.out.flush();
    }
}

impl Log {
    /// Open `<log dir>/<prefix>-<timestamp>.log`, pruning that prefix to the newest 10 first.
    pub fn create(prefix: &str) -> Result<Log> {
        Log::create_named(prefix, prefix)
    }

    /// Same, with a longer filename prefix pruned under a shared family — recreate logs are named
    /// `recreate-<mode>-…` but all count against one `recreate-` retention, as the script's were.
    pub fn create_named(family: &str, prefix: &str) -> Result<Log> {
        let dir = log_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|err| Fail(format!("could not create log dir {}: {err}", dir.display())))?;
        prune(&dir, family);
        // A name outside its family (`move-…` under `engine`, `restore-…` under `backup`) is pruned under its own name
        // too, or the family's count never reaches it and those logs pile up for ever.
        if prefix != family && !prefix.starts_with(&format!("{family}-")) {
            prune(&dir, prefix);
        }
        let path = dir.join(format!("{prefix}-{}.log", timestamp()));
        let file = std::fs::File::create(&path)
            .map_err(|err| Fail(format!("could not create {}: {err}", path.display())))?;
        Ok(Log {
            path,
            file: Arc::new(Mutex::new(Sink::new(Box::new(file)))),
        })
    }

    /// One line of ic's own, with its moment in front.
    pub fn line(&self, text: &str) {
        if let Ok(mut sink) = self.file.lock() {
            sink.line(text, crate::sandbox::now_ms());
        }
    }

    /// A `== title ==` section header, the shape the shell logs used — greppable seams between phases.
    pub fn section(&self, title: &str) {
        self.line(&format!("== {title} =="));
    }

    /// Output copied in as it was printed (a docker build or pull, a container's logs): as it came, up to CAP.
    pub fn write(&self, bytes: &[u8]) {
        if let Ok(mut sink) = self.file.lock() {
            sink.stream(bytes);
        }
    }
}

/// One line onto a long-lived log (a relay that serves for days), with its moment in front: the file is moved to
/// `<name>.1` once it passes `max` bytes, so two files at most are kept. Best-effort, like every log here.
// Only the Windows relay keeps a log this long-lived today.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn append_rotating(path: &std::path::Path, line: &str, max: u64) {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > max) {
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        let _ = std::fs::rename(path, PathBuf::from(old));
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{} {line}", iso_utc(crate::sandbox::now_ms()));
    }
}

/// Keep the newest 10 `<prefix>-*.log` (by name — the timestamp format sorts), delete the rest. Best-effort,
/// exactly like the `ls -1t | tail -n +10 | xargs rm -f` it replaces.
fn prune(dir: &std::path::Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{prefix}-")) && name.ends_with(".log")
                })
        })
        .collect();
    logs.sort();
    logs.reverse();
    for stale in logs.iter().skip(9) {
        let _ = std::fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sink writing into a buffer the test reads back.
    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("lock").extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn ic_s_own_lines_carry_their_moment_and_streamed_output_does_not() {
        let buffer = Shared::default();
        let mut sink = Sink::new(Box::new(buffer.clone()));
        sink.line("== run command ==", 1_791_240_330_007);
        sink.stream(b"#1 [internal] load build definition\n");
        drop(sink);
        let text = String::from_utf8(buffer.0.lock().expect("lock").clone()).expect("UTF-8");
        assert_eq!(
            text,
            "2026-10-05T22:45:30.007Z == run command ==\n#1 [internal] load build definition\n"
        );
    }

    #[test]
    fn output_past_the_cap_keeps_its_end_and_says_how_much_was_left_out() {
        let buffer = Shared::default();
        let mut sink = Sink::new(Box::new(buffer.clone()));
        let chunk = vec![b'x'; 1 << 20];
        for _ in 0..(CAP >> 20) {
            sink.stream(&chunk);
        }
        let mut more = vec![b'y'; 3 * TAIL];
        more.extend_from_slice(b"\nERROR");
        sink.stream(&more);
        sink.line(
            "intentic: the rebuild failed, so the sandbox is untouched.",
            0,
        );
        let text = String::from_utf8(buffer.0.lock().expect("lock").clone()).expect("UTF-8");
        assert!(text.len() < CAP as usize + TAIL + 1024, "{}", text.len());
        assert!(
            text.contains("bytes of output left out here"),
            "the gap is said"
        );
        assert!(text.contains("\nERROR\n"), "the end of the output is kept");
        assert!(text.ends_with(
            "1970-01-01T00:00:00.000Z intentic: the rebuild failed, so the sandbox is untouched.\n"
        ));
    }

    #[test]
    fn a_long_lived_log_rotates_past_its_size_and_keeps_two_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("logs").join("pipe-relay.log");
        append_rotating(&path, "serving", 10);
        append_rotating(&path, "a client connected", 10);
        let rotated = dir.path().join("logs").join("pipe-relay.log.1");
        let old = std::fs::read_to_string(&rotated).expect("rotated");
        assert!(old.ends_with("Z serving\n"), "{old}");
        let new = std::fs::read_to_string(&path).expect("current");
        assert!(new.ends_with("Z a client connected\n"), "{new}");
    }

    #[test]
    fn prunes_to_the_newest_ten_including_the_one_about_to_be_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        for i in 0..15 {
            std::fs::write(
                dir.path()
                    .join(format!("connect-2026010{}-0000{i:02}.log", i % 10)),
                "x",
            )
            .expect("write");
        }
        std::fs::write(dir.path().join("recreate-20260101-000000.log"), "x").expect("write");
        prune(dir.path(), "connect");
        let connect_logs = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("connect-"))
            .count();
        assert_eq!(
            connect_logs, 9,
            "9 kept + the one Log::create then writes = 10"
        );
        assert!(
            dir.path().join("recreate-20260101-000000.log").exists(),
            "other prefixes untouched"
        );
    }
}
