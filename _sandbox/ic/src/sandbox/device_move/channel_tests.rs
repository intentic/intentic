use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::Command;
use std::time::Duration;

use serde_json::json;

use super::out::accept_within;
use super::stream::{self, Incoming};
use super::wire::{self, Keys, Kind, Role};
use crate::docker::{self, Target};
use crate::engine::moves;
use crate::util::Result;

/* The move's stream end to end over real sockets, the way the two ic runs use it: the source dialling the target, or
both listening on loopback with a relay pumping bytes between them as the calling sandbox's daemon does between its two
`devices reach` tunnels (it sees only ciphertext). Sections are plain processes here (`head`, `cat`), so the protocol is
tested without docker; the volume test below takes two engines. */

/// The relay: dial both loopback ports and pump each way; with `cut_after`, drop both connections once that many
/// bytes have gone from the source towards the target (a relay, or a network, dying mid-copy).
fn relay(
    source_port: u16,
    target_port: u16,
    cut_after: Option<u64>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let source = TcpStream::connect(("127.0.0.1", source_port)).unwrap();
        let target = TcpStream::connect(("127.0.0.1", target_port)).unwrap();
        let (mut s_read, mut t_write) = (source.try_clone().unwrap(), target.try_clone().unwrap());
        let (mut t_read, mut s_write) = (target.try_clone().unwrap(), source.try_clone().unwrap());
        let back = std::thread::spawn(move || {
            let _ = std::io::copy(&mut t_read, &mut s_write);
            let _ = s_write.shutdown(Shutdown::Write);
        });
        let mut moved = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = match s_read.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            if cut_after.is_some_and(|cut| moved + read as u64 > cut) {
                let _ = source.shutdown(Shutdown::Both);
                let _ = target.shutdown(Shutdown::Both);
                break;
            }
            if t_write.write_all(&buffer[..read]).is_err() {
                break;
            }
            moved += read as u64;
        }
        let _ = t_write.shutdown(Shutdown::Write);
        let _ = back.join();
    })
}

const BYTES: u64 = 3_000_000;

/// One move of BYTES bytes, directly or relayed. Answers what each side ended with: the source's verdict, and the
/// file the target wrote.
fn one_move(
    relayed: bool,
    cut_after: Option<u64>,
    wrong_key: bool,
) -> (Result<String>, Result<Vec<u8>>) {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("arrived");
    let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target_port = target_listener.local_addr().unwrap().port();
    let source_keys = Keys::generate().unwrap();
    let target_keys = Keys::generate().unwrap();
    let (source_public, target_public) = (source_keys.public, target_keys.public);
    let handed = if wrong_key {
        Keys::generate().unwrap().public
    } else {
        source_public
    };
    let out_path = out.clone();
    let target = std::thread::spawn(move || -> Result<Vec<u8>> {
        let mut connection =
            accept_within(&target_listener, Duration::from_secs(20))?.expect("a connection");
        connection.set_read_timeout(Some(Duration::from_secs(20)))?;
        let theirs = wire::greet(&mut connection, &target_keys.public, Role::Target, "move-1")?;
        if !wire::is_expected(&theirs, &handed) {
            crate::util::bail!("stranger");
        }
        let mut session = wire::agree(target_keys, &theirs, Role::Target, "move-1")?;
        session
            .send
            .send(&mut connection, Kind::Ack, br#"{"ready":true}"#)?;
        let mut open: Option<Incoming> = None;
        let received = (|| -> Result<()> {
            loop {
                let (kind, payload) = session.receive.next(&mut connection)?;
                match kind {
                    Kind::Begin => {
                        let mut command = Command::new("sh");
                        command.args(["-c", &format!("cat > {}", out_path.display())]);
                        open = Some(Incoming::start(command)?);
                    }
                    Kind::Data => {
                        open.as_mut().expect("begun").write(&payload)?;
                    }
                    Kind::Finish => {
                        open.take().expect("begun").close()?;
                    }
                    Kind::End => return Ok(()),
                    _ => crate::util::bail!("out of turn"),
                }
            }
        })();
        if let Err(error) = received {
            if let Some(open) = open.take() {
                open.abandon();
            }
            let _ = std::fs::remove_file(&out_path);
            return Err(error);
        }
        session.send.send(
            &mut connection,
            Kind::Verdict,
            br#"{"ok":true,"host":"here"}"#,
        )?;
        let _ = session.receive.next(&mut connection);
        Ok(std::fs::read(&out_path)?)
    });
    let source = std::thread::spawn(move || -> Result<String> {
        let mut connection = if relayed {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let source_port = listener.local_addr().unwrap().port();
            let pumping = relay(source_port, target_port, cut_after);
            let connection = accept_within(&listener, Duration::from_secs(20))?.expect("the relay");
            std::mem::forget(pumping);
            connection
        } else {
            TcpStream::connect(("127.0.0.1", target_port))?
        };
        connection.set_read_timeout(Some(Duration::from_secs(20)))?;
        let mut session =
            wire::handshake(&mut connection, source_keys, Role::Source, "move-1", || {
                Ok(target_public)
            })?;
        let (kind, _) = session.receive.next(&mut connection)?;
        assert_eq!(kind, Kind::Ack);
        let mut command = Command::new("sh");
        command.args(["-c", &format!("yes abcdefgh | head -c {BYTES}")]);
        stream::send(
            &mut session.send,
            &mut connection,
            &json!({ "kind": "volume", "name": "v" }),
            command,
            &json!({}),
            "s",
            "volume",
            BYTES,
        )?;
        session.send.end(&mut connection)?;
        let (kind, verdict) = session.receive.next(&mut connection)?;
        assert_eq!(kind, Kind::Verdict);
        session.send.send(&mut connection, Kind::Ack, b"{}")?;
        Ok(String::from_utf8_lossy(&verdict).to_string())
    });
    let _ = &dir;
    let (source, target) = (source.join().unwrap(), target.join().unwrap());
    let _ = source_public;
    (source, target)
}

#[test]
fn a_direct_move_arrives_whole_and_the_source_hears_the_verdict() {
    let (source, target) = one_move(false, None, false);
    assert_eq!(source.unwrap(), r#"{"ok":true,"host":"here"}"#);
    let arrived = target.unwrap();
    assert_eq!(arrived.len() as u64, BYTES);
    assert!(arrived.starts_with(b"abcdefgh\nabcdefgh\n"));
}

#[test]
fn a_relayed_move_arrives_whole() {
    let (source, target) = one_move(true, None, false);
    assert_eq!(source.unwrap(), r#"{"ok":true,"host":"here"}"#);
    assert_eq!(target.unwrap().len() as u64, BYTES);
}

#[test]
fn a_relay_killed_mid_stream_fails_both_sides_and_leaves_nothing() {
    let (source, target) = one_move(true, Some(BYTES / 2), false);
    assert!(source.is_err(), "the source must not think it moved");
    let error = target.unwrap_err();
    assert!(error.0.contains("stopped"), "{}", error.0);
}

#[test]
fn a_source_whose_key_was_not_handed_over_is_refused() {
    let (source, target) = one_move(false, None, true);
    assert_eq!(target.unwrap_err().0, "stranger");
    assert!(source.is_err());
}

/* Two engines (or one, twice): a volume with files, links and a sparse file copied through the stream, its manifest
the same on both ends. Gated like the repo's other machine tests: it needs docker and an image with GNU tar and find. */
#[test]
#[ignore = "needs docker: IC_MOVE_FROM_HOST / IC_MOVE_TO_HOST (default: the local engine) and IC_MOVE_TEST_IMAGE (default debian:stable-slim)"]
fn a_volume_crosses_between_engines_through_the_stream() {
    let host =
        |name: &str| std::env::var(name).unwrap_or_else(|_| "unix:///var/run/docker.sock".into());
    let engine = |address: String| {
        Target::Intentic(docker::EngineEnv {
            host: address,
            cert_path: String::new(),
            bin: std::path::PathBuf::new(),
            pipe: None,
        })
    };
    let (from, to) = (
        engine(host("IC_MOVE_FROM_HOST")),
        engine(host("IC_MOVE_TO_HOST")),
    );
    let image = std::env::var("IC_MOVE_TEST_IMAGE").unwrap_or_else(|_| "debian:stable-slim".into());
    let suffix = std::process::id();
    let (theirs, ours) = (
        format!("ic-move-test-from-{suffix}"),
        format!("ic-move-test-to-{suffix}"),
    );
    for (on, volume) in [(&from, &theirs), (&to, &ours)] {
        moves::run_on(on, &["volume", "create", volume], docker::READ_LIMIT).unwrap();
    }
    let fill = format!("{theirs}:/v");
    moves::run_on(
        &from,
        &["run", "--rm", "-v", &fill, "--entrypoint", "sh", &image, "-c",
          "mkdir -p /v/a/b && echo hi > /v/a/b/f && ln -s b/f /v/a/l && truncate -s 50M /v/sparse && chown 1000:1000 /v/a/b/f"],
        Duration::from_secs(300),
    )
    .unwrap();
    let source_keys = Keys::generate().unwrap();
    let target_keys = Keys::generate().unwrap();
    let (source_public, target_public) = (source_keys.public, target_keys.public);
    let mut sending = wire::agree(source_keys, &target_public, Role::Source, "m").unwrap();
    let mut receiving = wire::agree(target_keys, &source_public, Role::Target, "m").unwrap();
    let read_args = super::out::tar_out_args(
        &format!("ic-move-test-read-{suffix}"),
        &theirs,
        false,
        &image,
    );
    let refs: Vec<&str> = read_args.iter().map(String::as_str).collect();
    let (files, hash) = moves::manifest(&from, &theirs, &image, false).unwrap();
    let mut sealed = Vec::new();
    stream::send(
        &mut sending.send,
        &mut sealed,
        &json!({ "kind": "volume", "name": theirs }),
        moves::archive_command(&from, &refs),
        &json!({ "files": files, "hash": hash }),
        "t",
        "volume",
        0,
    )
    .unwrap();
    sending.send.end(&mut sealed).unwrap();
    let write_args = super::into::tar_in_args(
        &format!("ic-move-test-write-{suffix}"),
        &ours,
        false,
        &image,
    );
    let refs: Vec<&str> = write_args.iter().map(String::as_str).collect();
    let mut incoming = Incoming::start(moves::archive_command(&to, &refs)).unwrap();
    let mut read = std::io::Cursor::new(sealed);
    loop {
        let (kind, payload) = receiving.receive.next(&mut read).unwrap();
        match kind {
            Kind::Data => {
                incoming.write(&payload).unwrap();
            }
            Kind::End => break,
            _ => {}
        }
    }
    incoming.close().unwrap();
    let arrived = moves::manifest(&to, &ours, &image, false).unwrap();
    for (on, volume) in [(&from, &theirs), (&to, &ours)] {
        let _ = docker::capture_on(on, &["volume", "rm", "-f", volume], docker::READ_LIMIT);
    }
    assert!(files >= 3, "{files}");
    assert_eq!(arrived, (files, hash));
}
