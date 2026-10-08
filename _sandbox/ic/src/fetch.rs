/* A DOWNLOAD THAT SURVIVES THE RESTART IN THE MIDDLE OF IT — the 600 MB Docker Desktop installer and the sandbox
image's 1.8 GB of layers are both fetched before a Windows restart that may come halfway through, and starting either
over is minutes nobody gets back. */

// The bytes go to `<file>.part`, and only a whole file is renamed into place. A later run that finds a `.part` asks the
// server for the rest (`Range`) — and, for a URL whose content can change under it (Docker's "latest installer" URL),
// only for the rest of THE SAME file (`If-Range` with the validator saved beside the part): a server whose file moved
// on answers with all of the new one, which replaces the part rather than being glued onto it. A content-addressed URL
// (a registry blob) is verified by its digest instead, so it needs no validator.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A ureq agent for long bodies on whatever connection the user has: no global timeout (it would only cap slow
/// connections at "failed"), a connect timeout, and a read timeout that is what catches a transfer that died.
pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(None)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .build()
        .new_agent()
}

/// Where the bytes of `into` go until they are whole.
pub fn part_of(into: &Path) -> PathBuf {
    let mut name = into.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    into.with_file_name(name)
}

/// Where the validator (ETag or Last-Modified) of the file a `.part` holds is kept.
fn validator_of(into: &Path) -> PathBuf {
    let mut name = into.file_name().unwrap_or_default().to_os_string();
    name.push(".part.validator");
    into.with_file_name(name)
}

/// How many bytes of `into` are already on disk: the whole file, or its part.
pub fn on_disk(into: &Path) -> u64 {
    std::fs::metadata(into)
        .or_else(|_| std::fs::metadata(part_of(into)))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// What a server's `Content-Range: bytes 100-199/500` says the whole file is. `*` (unknown) and anything malformed
/// is None.
pub fn content_range_total(header: &str) -> Option<u64> {
    header
        .trim()
        .strip_prefix("bytes ")?
        .rsplit_once('/')?
        .1
        .trim()
        .parse()
        .ok()
}

/// How a resumed request has to be asked, from what is on disk: the byte to start at and the validator to send with
/// it. Nothing to resume (no part, or a part of a changeable URL whose validator was lost) is a fresh start at 0.
pub fn resume_from(
    part_len: u64,
    validator: Option<&str>,
    content_addressed: bool,
) -> (u64, Option<String>) {
    if part_len == 0 {
        return (0, None);
    }
    match validator.map(str::trim).filter(|value| !value.is_empty()) {
        Some(validator) => (part_len, Some(validator.to_string())),
        None if content_addressed => (part_len, None),
        None => (0, None),
    }
}

/// Download `url` to `into`, resuming whatever an earlier run left. `headers` ride on the request (a registry's
/// bearer token); `content_addressed` says the URL names one file forever, so a part needs no validator to be resumed.
/// `on_read(have, total)` is called after every chunk (total 0 when the server did not say), from this thread.
pub fn resumable(
    agent: &ureq::Agent,
    url: &str,
    headers: &[(&str, String)],
    into: &Path,
    content_addressed: bool,
    on_read: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    if into.exists() {
        return Ok(());
    }
    let part = part_of(into);
    let validator_file = validator_of(into);
    let part_len = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
    let saved = std::fs::read_to_string(&validator_file).ok();
    let (start, if_range) = resume_from(part_len, saved.as_deref(), content_addressed);

    let mut request = agent.get(url);
    for (name, value) in headers {
        request = request.header(*name, value.as_str());
    }
    if start > 0 {
        request = request.header("Range", format!("bytes={start}-"));
        if let Some(validator) = &if_range {
            request = request.header("If-Range", validator.as_str());
        }
    }
    let response = match request.call() {
        Ok(response) => response,
        // A part that is already the whole file: the server has no byte after it to send. Start over rather than guess.
        Err(ureq::Error::StatusCode(416)) if start > 0 => {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&validator_file);
            return resumable(agent, url, headers, into, content_addressed, on_read);
        }
        Err(error) => return Err(format!("{url}: {error}")),
    };
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let length: u64 = header("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let resumed = response.status().as_u16() == 206 && start > 0;
    let (mut have, total) = if resumed {
        let total = header("content-range")
            .as_deref()
            .and_then(content_range_total)
            .unwrap_or(if length > 0 { start + length } else { 0 });
        (start, total)
    } else {
        // A whole new file: whatever the part held is not a prefix of it. The validator is saved before the first byte,
        // so a run cut short at any point leaves a part a later run can ask about.
        let _ = std::fs::remove_file(&part);
        match header("etag").or_else(|| header("last-modified")) {
            Some(validator) if !content_addressed => {
                let _ = std::fs::write(&validator_file, validator);
            }
            _ => {
                let _ = std::fs::remove_file(&validator_file);
            }
        }
        (0, length)
    };
    if let Some(dir) = into.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .map_err(|error| format!("could not write {}: {error}", part.display()))?;
    let mut reader = response.into_body().into_reader();
    let mut buffer = vec![0u8; 256 * 1024];
    on_read(have, total);
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("the download stopped early ({error})"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("could not write {}: {error}", part.display()))?;
        have += read as u64;
        on_read(have, total);
    }
    file.flush()
        .map_err(|error| format!("could not write {}: {error}", part.display()))?;
    drop(file);
    if total > 0 && have != total {
        return Err(format!(
            "the download ended at {have} of {total} bytes; trying again picks up from there"
        ));
    }
    std::fs::rename(&part, into)
        .map_err(|error| format!("could not finish writing {}: {error}", into.display()))?;
    let _ = std::fs::remove_file(&validator_file);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_content_range_names_the_whole_file() {
        assert_eq!(content_range_total("bytes 100-199/500"), Some(500));
        assert_eq!(content_range_total(" bytes 0-0/1 "), Some(1));
        assert_eq!(content_range_total("bytes 100-199/*"), None);
        assert_eq!(content_range_total("items 1-2/3"), None);
        assert_eq!(content_range_total(""), None);
    }

    /* A PART IS ONLY RESUMED WHEN IT CAN BE TRUSTED TO BE A PREFIX OF WHAT THE SERVER SENDS NEXT. */
    #[test]
    fn a_part_is_resumed_only_with_something_that_vouches_for_it() {
        assert_eq!(resume_from(0, Some("\"abc\""), false), (0, None));
        assert_eq!(
            resume_from(500, Some("\"abc\""), false),
            (500, Some("\"abc\"".to_string())),
            "a changeable URL resumes with its validator, so a moved file comes back whole"
        );
        assert_eq!(
            resume_from(500, None, false),
            (0, None),
            "a changeable URL without a validator could glue two versions together: start over"
        );
        assert_eq!(resume_from(500, Some("  "), false), (0, None));
        assert_eq!(
            resume_from(500, None, true),
            (500, None),
            "a blob is checked by its digest, so its part resumes on its own"
        );
    }

    #[test]
    fn the_part_and_its_validator_sit_beside_the_file() {
        let into = Path::new("/tmp/x/Docker Desktop Installer.exe");
        assert_eq!(
            part_of(into),
            PathBuf::from("/tmp/x/Docker Desktop Installer.exe.part")
        );
        assert_eq!(
            validator_of(into),
            PathBuf::from("/tmp/x/Docker Desktop Installer.exe.part.validator")
        );
    }

    /* The real thing, against a local server that honours Range — the case a restart halfway through produces. */
    #[test]
    fn a_download_cut_short_is_finished_from_where_it_stopped() {
        use std::net::TcpListener;
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = body.clone();
        let ranges = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = ranges.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut request = [0u8; 4096];
                let n = stream.read(&mut request).unwrap();
                let text = String::from_utf8_lossy(&request[..n]).to_string();
                let range = text
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("range: bytes=")
                            .map(str::to_string)
                    })
                    .and_then(|r| r.trim_end_matches('-').parse::<usize>().ok());
                seen.lock().unwrap().push(text.clone());
                let (status, slice, extra) = match range {
                    Some(from) => (
                        "206 Partial Content",
                        &served[from..],
                        format!(
                            "Content-Range: bytes {from}-{}/{}\r\n",
                            served.len() - 1,
                            served.len()
                        ),
                    ),
                    None => ("200 OK", &served[..], String::new()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: \"v1\"\r\n{extra}Connection: close\r\n\r\n",
                    slice.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(slice).unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let into = dir.path().join("installer.exe");
        // What a run that died at 70 000 bytes left behind.
        std::fs::write(part_of(&into), &body[..70_000]).unwrap();
        std::fs::write(validator_of(&into), "\"v1\"").unwrap();
        let mut last = (0, 0);
        resumable(
            &agent(),
            &format!("http://127.0.0.1:{port}/installer.exe"),
            &[],
            &into,
            false,
            &mut |have, total| last = (have, total),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(&into).unwrap(),
            body,
            "the file is whole and in order"
        );
        assert_eq!(
            last,
            (200_000, 200_000),
            "progress counts the part it already had"
        );
        assert!(!part_of(&into).exists() && !validator_of(&into).exists());
        let request = ranges.lock().unwrap()[0].to_ascii_lowercase();
        assert!(request.contains("range: bytes=70000-"), "{request}");
        assert!(request.contains("if-range: \"v1\""), "{request}");
    }
}
