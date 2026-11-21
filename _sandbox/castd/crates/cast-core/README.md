# cast-core

castd's streaming engine without its platform: the media socket, the encoder every viewer shares, rate control, tokens and peer connections, and the traits a platform's capture, input and sound implement.

## Key files

- [src/capture.rs](src/capture.rs) — what a platform implements for the picture: a screen source, its captures, their
  damage.
- [src/frame.rs](src/frame.rs) — the frames between capture and encoder: CPU I420, CPU BGRA, or a platform's own
  surface.
- [src/encoder.rs](src/encoder.rs) — the encoder seam: encoder kinds, the fallback, the self-test, castd's x264 and
  NVENC.
- [src/input.rs](src/input.rs) — viewers' input as the platform receives it, and the thread it runs on.
- [src/video.rs](src/video.rs) — the pipeline: damage, paint-over, the shared encoder, the per-viewer send and skip.
- [src/server.rs](src/server.rs) — the media socket's upgrade and the control endpoints, on any byte stream.

## What a platform provides

Everything castd's README describes about the media socket, the bitrate policy, exact pictures for a local viewer,
recordings and `/wait` happens here, whatever the platform. A platform brings four things, and castd's are in
[cast-x11](../cast-x11):

- **A screen source** (`ScreenSource`): opens a `Capture` of the screen (or a crop of it), opens it again after every
  change of size, and resizes the screen between captures when it can. A screen that is someone's own monitor keeps
  its size: `resize_limits` answers None and a viewer's box changes only the scale.
- **A capture** (`Capture`), owned by the pipeline's `capture` thread. It keeps the `Damage` the platform reports
  (XDamage rectangles, DXGI dirty and move rectangles), offers something to wait on beside the hub's wake (an X
  socket, the `Wake` a DXGI thread signals), and once a frame is due brings the damaged rows into what the encoder
  reads next: `grab` then `fill`. A capture whose picture is in memory implements `pixels` and gets `fill`,
  `snapshot` and `region` for free.
- **An input sink** (`InputSink`), run on the `input` thread in order with the clipboard. Keys arrive as the DOM named
  them (`key` with the layout applied, `code` for the physical key), points in screen pixels with the crop's origin
  added, scrolls as picture pixels that `ScrollAcc` turns into wheel notches without losing a fraction. The sink also
  says which DOM keys it types, so a key it cannot type never makes its viewer the driver.
- **Optionally a sound source** (`AudioSource`): 10 ms of 48 kHz stereo at a time, which the `audio` thread encodes
  to Opus while a viewer listens. The PulseAudio one is here too (`pulse`, Linux).

The pointer and the clipboard go the other way: the platform calls `Hub::set_cursor` (with `clipboard::cursor` to make
the PNG) and `Hub::clipboard_changed` when they change on the screen, and `Hub::pointer_at` as the pointer moves (screen
pixels; the hub sends `pointer` in picture pixels, only when it moved, and again to a viewer that joins). cast-x11 calls
it on XInput 2's raw motion, at most every 8 ms; cast-win on each of duplication's pointer updates, off the picture while
the pointer is on another output or hidden.

## The zero-copy path

An encoder says which frames it reads (`VideoEncoder::formats`), a capture which it fills (`Capture::formats`), and the
pipeline hands the encoder the first of its formats the capture can fill. castd's are CPU I420 on both sides. A
Windows backend that keeps the picture on the GPU answers `Native` on both: its capture makes D3D11 textures in
`new_frame` and copies the damaged rows into them in `fill`; its encoder (NVENC on D3D11, a Media Foundation MFT, on
the same device) downcasts `Picture::Native` to its own texture type. The core never looks inside a native frame,
never cuts one into stripes, and falls back to the CPU path (the `Encoders::fallback`, which reads I420) when the two
sides do not meet. The pipeline test runs both paths with a painted in-memory screen.

## Serving and peers

`server::router` serves castd's routes; `server::serve_connection` serves one HTTP/1.1 connection, upgrades included,
on any `AsyncRead + AsyncWrite`: a Unix socket, TCP, a yamux stream inside a WebSocket a device daemon dialled out.
Whoever accepts the connection decides who reaches the control endpoints, which need no token.

A daemon that serves screens on demand beside other work (intentic-remoted) keeps the process alive whatever one
screen does: `video::spawn` answers a `Video` whose `stop` ends the capture and encode threads (the sound's and
cast-x11's cursor thread follow `Hub::stopped`), and a capture that fails for good goes to `Hub::on_fatal` when one is
set instead of ending the process, as castd's does. `media::serve_guarded` takes a `Guard` the socket asks before
input and token refreshes, and hands it the viewer's client so a drop elsewhere can end it.

The peer port (`rtc`) is castd's ICE-lite by default. `rtc::start_with` with `Ice::Full` makes it a full agent, for a
computer behind a NAT: it asks STUN servers for its server-reflexive address, takes the viewer's trickled candidates,
and sends checks of its own, whose answers come back to the peer that sent them.

## Across the internet: the pictures on a video track

On a peer, `media` is an ordered, reliable SCTP channel, which was built for a LAN (castd's README says why). Across
the internet it fails three ways at once: a lost packet holds every picture behind it until SCTP sends it again, SCTP's
congestion window halves on every loss whether or not the link is full, and the ack-based controller (rate.rs) reads
the retransmissions' delay as queueing and presses the bitrate to its floor. Measured below at 100 ms and 2% loss,
the picture ran a quarter of a second late at the median and more than a second at the 95th percentile, at 500 kbit/s
on a 10 Mbit/s link.

So a viewer may ask for the pictures on a video track (2026-11-21). Its offer carries one receive-only video section
offering H.264 in packetization mode 1; `rtc::accept_with` answers it when the pictures are one stream (a single
stripe), and once the peer's channels open, its hello on `media` says `track` and every picture goes out as RTP there
([src/rtc/peer.rs](src/rtc/peer.rs)): str0m packetizes the access unit, its RTP time is its capture time on the 90 kHz
clock, and it carries the playout-delay extension at zero, beside the viewer's own `jitterBufferTarget = 0`. The
browser's own WebRTC pipeline shows it (hardware decoder, jitter buffer); everything else stays on the channels.

- **Repair**: a NACK is answered from str0m's send buffer (on the retransmission format where the viewer offered one),
  and a decoder that lost the stream asks with PLI or FIR, which castd answers with a keyframe at most every 500 ms
  (one may still be on its way).
- **Rate**: transport-wide feedback drives str0m's congestion control (Google's: delay gradient, loss, probing),
  started at the bitrate castd aims for or 2 Mbit/s, whichever is higher, and probing toward `--max-kbps`. While a
  track's viewer steers, the encoder is given `TRACK_SHARE` (0.85) of its estimate, the rest left for
  retransmissions, scaled down further while the encoder puts out more than that share (openh264 at its QP ceiling on
  content too busy for the link), and to 0.7 of it while what was sent runs ahead (below).
- **Pace**: nothing acks a track's pictures. castd counts what it sent against a bucket that the share drains, never
  more than 500 ms of it, and holds the capture while the bucket is more than two frames (and 60 ms) ahead: frames
  are dropped at the source rather than filling the bottleneck's buffer and every retransmission behind it. A
  keyframe waits too, a second at most. A viewer that does not steer is skipped on the same bucket as a channel
  viewer is on its acks. str0m paces what is sent at 1.1 times its estimate.
- **Rejected, measured**: acking each picture as it was shown (`requestVideoFrameCallback`'s `rtpTimestamp` sent
  back on `input`) and gating on those acks as on a channel's: a NACK's repair looks like queueing, the gate shut
  the capture until the repair came, and with nothing sent a lost last packet was never even noticed (22% of the run
  frozen at 100 ms and 2%). Sending the track unpaced: it saved nothing on a LAN (16.3 against 16.0 ms at the median)
  and on a capped link a keyframe's burst overflowed the bottleneck, the estimate collapsed, and 78% of the run froze.
  A loss-tolerant `media` instead (unordered, partially reliable video with intra refresh): it needs intra refresh in
  four encoders (x264, openh264, NVENC, Media Foundation) and a WebCodecs decoder that can go on past a missing
  reference, which it cannot; the track brings NACK, PLI, congestion control and the hardware decoder as they are.
- **The peer's own loop** ([src/rtc/peer.rs](src/rtc/peer.rs)), for both paths: str0m hands out one paced packet per
  timeout, and taking each through tokio's millisecond timer sent a frame's packets a millisecond apart (7 ms to
  assemble a 720p delta on a LAN), so a timeout already due is taken at once, up to 1024 of them or 5 ms before the
  loop reads what came in. A datagram is never waited on: a burst into a slow link filled the socket's send buffer and
  held the loop, and with it everything the viewer said, for up to 52 ms a datagram (measured), so a full buffer drops
  it, as UDP may.
- **Who asks**: the editor asks wherever its view can show a `<video>`: a connected computer's screen
  (`useDeviceScreen`). The sandbox's own browser windows do not, so castd's LAN path is the one castd's README
  measures. Older ends keep working: an older viewer offers no video section and gets `media`; an older castd answers
  the section and never sends on it, its hello says no `track`, and the viewer goes on decoding `media` (checked with
  the castd before this change and a page offering the track: 485 pictures decoded off `media`, the track silent).

### Measured across an impaired link

[examples/wanbench](examples/wanbench) is the harness: cast-core serving a synthetic screen (text-like lines scrolling
3 px a frame, a box crossing them, painted at 57 Hz so a run samples every phase against the 60 Hz capture and display)
whose top row carries a stamp (the wall-clock millisecond it was painted, a counter and a checksum, in 16-pixel blocks),
to a headless Chrome whose page reads the stamp back off every picture it shows: capture to the rendering update that
first shows it ("glass"), on the canvas for `media` and on `requestVideoFrameCallback` for the track. `run.sh` puts
the server and Chrome in two network namespaces joined by a veth pair: netem on each end (half the round trip, half the
jitter, the loss, in order) and tbf downstream as the bottleneck (a 100 ms buffer at the cap), the cap 10 Mbit/s,
3 Mbit/s from a third of the run and 10 again from two thirds. `matrix.sh` runs every profile; `analyze.mjs` reads the
reports. A freeze is a gap over 200 ms between two pictures shown (the content moves all the time).

```
cd _sandbox/castd   # needs CAP_NET_ADMIN and CAP_SYS_ADMIN (ip netns, tc) and a Chrome (run.sh --chrome, else Playwright's)
cargo build --release -p cast-core --example wanbench --features x264,openh264
quiet --pin 4 -- crates/cast-core/examples/wanbench/matrix.sh --bin target/release/examples/wanbench --dir /tmp/wan --mode track
```

Measured 2026-11-21 in this sandbox on `rog` (16 cores; other work kept 3 to 10 of them busy), each run under `quiet
--pin 4`, Chrome for Testing 156 headless (software decode), openh264 (remoted's software encoder) at 1280x720, 45 s a
run after 4 s of warm-up. "Before" is the castd this change started from (the same harness built at that commit, whose
viewer offers the track and is answered on `media`); "after" is this one, the track where the page asks for it and
`media` where it does not. Glass is capture to the first rendering update showing the picture; shown is pictures shown
a second (at most one a rendering update, of 57 painted); sent is what the encoder put out in each step of the cap,
its first two seconds left out.

| Link (RTT, loss each way) | Path | Glass p50 / p95 / p99 (ms) | Shown /s | Freezes /min (frozen) | Keyframes | Sent (kbit/s) |
| --- | --- | --- | --- | --- | --- | --- |
| LAN (no impairment) | `media`, before | 13.1 / 25.9 / 41.9 | 58.4 | 0 (0%) | 0 | 3912 |
| LAN (no impairment) | `media`, after | 20.2 / 60.5 / 131.3 | 47 | 6.7 (5.1%) | 0 | 3304 |
| LAN (no impairment) | track | 17.2 / 28 / 48.2 | 50.7 | 0 (0%) | 0 | 3640 |
| LAN (no impairment) | track, again | 19.8 / 49.5 / 124.5 | 45.1 | 6.7 (3.5%) | 0 | 3467 |
| 40 ms, 0.5% | `media`, before | 40.5 / 106.9 / 157.1 | 52 | 0 (0%) | 0 | 2006 → 1908 → 1683 |
| 40 ms, 0.5% | `media`, after | 44.4 / 127.9 / 186.8 | 45.8 | 0 (0%) | 0 | 1899 → 1763 → 2504 |
| 40 ms, 0.5% | track | 44.8 / 109.8 / 190 | 39 | 5.3 (5.4%) | 0 | 3171 → 2332 → 2653 |
| 40 ms, 0.5% | track, again | 62.8 / 170.2 / 459.5 | 27.3 | 17.3 (13.7%) | 0 | 2677 → 1490 → 1232 |
| 40 ms, 2% | `media`, before | 37.1 / 87.8 / 720.9 | 39.6 | 10.7 (15.5%) | 0 | 582 → 665 → 814 |
| 40 ms, 2% | track | 42.4 / 94 / 204.8 | 34.2 | 4 (4.3%) | 0 | 3663 → 1437 → 1806 |
| 40 ms, 5% | `media`, before | 63.5 / 1064.4 / 1647.7 | 15.8 | 36 (51.9%) | 0 | 442 → 495 → 495 |
| 40 ms, 5% | track | 45.3 / 131.2 / 215.7 | 25.2 | 24 (11.5%) | 0 | 3273 → 1966 → 2429 |
| 100 ms, 0.5% | `media`, before | 74.1 / 224.2 / 614 | 37.7 | 9.3 (4.3%) | 0 | 969 → 639 → 659 |
| 100 ms, 0.5% | track | 75.1 / 140.8 / 209.4 | 36.6 | 5.3 (6.3%) | 0 | 3568 → 2473 → 2588 |
| 100 ms, 2% | `media`, before | 261 / 1177.3 / 2511.7 | 16.5 | 42.7 (33.7%) | 0 | 572 → 452 → 500 |
| 100 ms, 2% | `media`, after | 290.6 / 1139.4 / 1482.4 | 17.2 | 44 (39.7%) | 0 | 424 → 429 → 446 |
| 100 ms, 2% | track | 85.9 / 203.4 / 307.5 | 18.8 | 14.7 (18.6%) | 1 | 3741 → 1905 → 2276 |
| 100 ms, 2% | track, again | 79.9 / 185.9 / 472.8 | 22.4 | 14.7 (16.2%) | 0 | 3706 → 2218 → 2573 |
| 100 ms, 5% | `media`, before | 1401.2 / 5783.4 / 7199.7 | 6.7 | 45.3 (68.7%) | 5 | 334 → 398 → 664 |
| 100 ms, 5% | track | 155.7 / 299 / 470.2 | 15.9 | 26.7 (13.5%) | 0 | 2795 → 2242 → 2871 |
| 200 ms, 0.5% | `media`, before | 133.1 / 853.5 / 1584.6 | 22.9 | 54.7 (35.7%) | 0 | 476 → 431 → 607 |
| 200 ms, 0.5% | track | 139.4 / 318.2 / 680 | 24.8 | 70.7 (32.7%) | 0 | 3833 → 2354 → 2064 |
| 200 ms, 2% | `media`, before | 19847.6 / 24446.9 / 24779.9 | 3.7 | 37.3 (83.1%) | 11 | 461 → 472 → 553 |
| 200 ms, 2% | track | 194.6 / 448.9 / 653.1 | 12.3 | 83.9 (43.3%) | 0 | 2495 → 965 → 779 |
| 200 ms, 5% | `media`, before | 26595.4 / 40227.2 / 40260.6 | 1.2 | 22.7 (93.6%) | 11 | 388 → 414 → 458 |
| 200 ms, 5% | `media`, after | 18265.9 / 27574.1 / 27911.1 | 3 | 30.7 (88.5%) | 10 | 538 → 438 → 495 |
| 200 ms, 5% | track | 317.4 / 496.6 / 1055.2 | 12.9 | 56 (30.1%) | 0 | 3757 → 1953 → 2275 |
| 200 ms, 5% | track, again | 296.8 / 505.8 / 1340 | 12 | 66.7 (38.8%) | 0 | 3816 → 1554 → 1129 |

- **Across the internet the track is the way**: `media`'s 95th percentile passed a second at 5% loss on any round trip
  and at 2% from 100 ms, and at 200 ms with 2 or 5% the picture fell 20 to 27 s behind; the track's 95th percentile
  stayed under 510 ms everywhere, its median the link's one-way delay plus about a round trip at 5% loss, at 4 to 8
  times `media`'s bitrate. What it still pays is the retransmission's wait: a frame with a packet lost waits a round
  trip for it, and the frames behind it wait too (the decoder takes them in order), which is most of the freezes left
  at 200 ms.
- **On a LAN they are the same**: run back to back on the same load, `media` gave 22.5/77.2 and 19.3/46.1 ms (p50/p95)
  from the castd before and 24.0/72.0 and 18.7/37.9 from this one; the track 17.0 to 18.1 at the median and 26 to 56 at
  the 95th percentile over seven runs. Earlier, on a calmer machine, the two were 16.5/24.0 (`media`) against
  16.0/23.8 (track). At 40 ms and 0.5% the two are alike in delay, and `media` froze less, at about two thirds of the
  track's bitrate.
- **Left**: forward error correction (str0m has none) or intra refresh, to repair a loss without waiting a round
  trip; a keyframe kept small on a slow link (once about a megabyte went out in a quarter second around one, as the
  cap fell, and the estimate collapsed under the loss); openh264 at its QP ceiling cannot fit full-screen scrolling into 3 Mbit/s at 57 frames a second, so frames
  are dropped at the source there; and one LAN run of the track in about twenty showed a picture that stopped
  updating while the browser went on decoding, which the bench caught by its stamps no longer reading and which did
  not come back in six runs after a failed write on the track was made to wait for a keyframe (`Track::broken`),
  the one way found for castd to send a picture its viewer would decode against the wrong reference.

## Features and Windows

`libyuv` (the default) converts BGRX to I420 with libyuv; without it a portable converter does libyuv's arithmetic in
Rust. `x264` links libx264 (GPL-2.0), `nvenc` binds NVIDIA's encoder on CUDA (Linux), `opus` and `pulse` the sound.
With none of them cast-core links no C library and builds for Windows:

Two features exist for a build with no GPL and nothing of the system's to link, a Windows one above all
([cast-win](../cast-win)): `openh264` is Cisco's openh264 (BSD-2-Clause, built from source by openh264-sys2, with clang-cl
and NASM under cargo-xwin) as an encoder kind, `cast_core::openh264::OpenH264`: Constrained Baseline, screen-content
mode, bitrate mode at the controller's cap, no frame skipping, so it passes the same self-test; a rate change is
`ENCODER_OPTION_BITRATE`, which openh264 applies without an IDR. Screen-content mode turns scene-change detection on
whatever it is told, so a scene change (a window switch) may come out as an IDR nobody asked for. openh264 cannot move its
QP range without a reset, so `crf` sets nothing and paint-over relies on a still picture converging under the cap.
`opus1` encodes the sound with opus1 (libopus 1.6 ported to Rust, BSD-3-Clause) where `opus` (libopus) is off, the same
restricted-low-delay 10 ms packets.

```
cargo xwin build -p cast-core --target x86_64-pc-windows-msvc --no-default-features
```

Its tests run on Windows natively (all but the Unix-socket `viewers` test). On `omen` (2026-11-20) the linker failed
writing test binaries' PDB files (LNK1318), with or without debug info; `RUSTFLAGS="-C link-arg=/DEBUG:NONE"` leaves
the PDB out and every test passes.
