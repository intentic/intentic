# cast-core

castd's streaming engine without its platform: the media socket, the encoder every viewer shares, rate control, tokens and peer connections, and the traits a platform's capture, input and sound implement.

## Key files

- [src/capture.rs](src/capture.rs) — what a platform implements for the picture: a screen source, its captures, their
  damage.
- [src/frame.rs](src/frame.rs) — the frames between capture and encoder: CPU I420, CPU BGRA, or a platform's own
  surface.
- [src/encoder.rs](src/encoder.rs) — the encoder seam: encoder kinds, the fallback, the self-test, castd's x264,
  NVENC and VA-API.
- [src/vaapi/mod.rs](src/vaapi/mod.rs) — VA-API's H.264 encoder (Intel, AMD, D3D12 on WSL2), libva opened at run time;
  [ffi.rs](src/vaapi/ffi.rs) its API written out, [h264.rs](src/vaapi/h264.rs) the SPS and PPS it hands the driver.
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
  every one of them: str0m's default drops all queued resends once what it resent passes 15% of what it sent in the
  last second, which a burst of loss does, and the pictures then wait for the viewer to ask again (turned off
  2026-11-21, measured below). A decoder that lost the stream asks with PLI or FIR, which castd answers with a
  keyframe at most every 500 ms (one may still be on its way).
- **Keyframes**: on a track a keyframe, and a frame of new content after a lull, may take what the slowest track's
  link carries in 200 ms (`KEY_WINDOW` in [src/video.rs](src/video.rs), never below 160 kbit) instead of a channel's
  four times the cap: nothing acks the pictures behind it, so a larger one only fills the bottleneck's buffer. The
  encoder gets it through `VideoEncoder::set_rate_key`: a full VBV buffer of that size for x264, NVENC and VA-API;
  openh264 has no VBV and picks an IDR's QP from bits per pixel, so it is given a bitrate whose second is the budget,
  which tops its range at QP 40 (720p text still comes out at 100 to 120 kB, about 1.5 times the budget at 2.7
  Mbit/s); Media Foundation is given the cap.
- **Rate**: transport-wide feedback drives str0m's congestion control (Google's: delay gradient, loss, probing),
  started at the bitrate castd aims for or 2 Mbit/s, whichever is higher, and probing toward `--max-kbps`. While a
  track's viewer steers, the encoder is given `TRACK_SHARE` (0.85) of its estimate, the rest left for
  retransmissions, scaled down further while the encoder puts out more than that share (openh264 at its QP ceiling on
  content too busy for the link), and to 0.7 of it while what was sent runs ahead (below).
- **Pace**: nothing acks a track's pictures. castd counts what it sent against a bucket that the share drains, never
  more than 500 ms of it, and holds the capture while the bucket is more than two frames (and 60 ms) ahead, or the
  oldest packet str0m's pacer still holds (a picture's, or a resend's, which go first) has waited that long: frames
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
first shows it ("glass"), on the canvas for `media` and on `requestVideoFrameCallback` for the track. `--keyframes
16,31` has the page ask for a keyframe at those seconds, as a decoder that lost the stream would. `run.sh` puts
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

### Loss, keyframes and the 40 ms case, measured again (2026-11-21, later)

Every track freeze at 40 ms and 0.5% in the first matrix came from one moment, the cap's fall from 10 to 3 Mbit/s: the
track was sending 4.5 Mbit/s (openh264 at its QP floor; `media`'s ack-based controller held itself near 2), the
bottleneck overflowed before the estimate fell, and the burst of lost packets was never all sent again: str0m drops
every queued resend once what it resent passes 15% of what it sent in the last second, so the pictures waited for the
viewer to ask again, about 2.3 s of freezes with pictures 1.4 to 1.8 s old. Three changes since:

- **Every resend goes** ([src/rtc/peer.rs](src/rtc/peer.rs), `open_track`): 40 ms and 0.5% went from 3.8 to 5.1%
  frozen to 1.4 to 1.5% in the first runs, the cap's fall from 2.3 s of freezes to 0.6.
- **str0m's own queue counts** (`Feedback::queue_ms`): with resends uncapped they go ahead of the pictures in str0m's
  pacer, and after a burst the pictures stood a second behind there through the 3 Mbit/s step (p95 1.3 s at 40 ms and
  0.5%, 0.7 to 1.8 s at 200 ms and 0.5%) with castd's bucket empty. The age of the oldest packet str0m still holds
  now gates the capture beside the bucket, and the standing delay went.
- **A keyframe sized to the link** (above, under Keyframes): before it, a keyframe asked for in the 3 Mbit/s step
  (`--keyframes`) was 128 to 164 kB from openh264, 390 to 580 ms of that link's estimate; now 102 to 121 kB from
  openh264 and a full VBV buffer of 200 ms of the estimate from the encoders that have one.

Measured as the first matrix was (same harness, `matrix.sh`, 45 s a run after 4 s of warm-up, `quiet --pin 4`, Chrome
for Testing 156 headless, openh264 at 1280x720), in this sandbox on `rog` with 1 to 3 cores busy elsewhere. "Before" is
the cast-core this work started from, "after" this one, each run twice; `media`'s path did not change and ran once.
None of the "after" or `media` runs logged a stalled step (`capture: N ms in <step>`, added by this change: earlier,
on a loaded host, the bench's own synthetic screen took seconds in its mutex and memcpy; those runs are not here).

| Link (RTT, loss each way) | Path | Glass p50 / p95 / p99 (ms) | Shown /s | Freezes /min (frozen) | Keyframes | Sent (kbit/s) |
| --- | --- | --- | --- | --- | --- | --- |
| LAN (no impairment) | track, before | 16.3 / 24.2 / 26.4 | 53.7 | 0 (0%) | 0 | 3704 |
| LAN (no impairment) | track, before, again | 16.4 / 24 / 25.5 | 54.1 | 0 (0%) | 0 | 3889 |
| LAN (no impairment) | track, after | 15.9 / 23.6 / 24.9 | 53.9 | 0 (0%) | 0 | 3743 |
| LAN (no impairment) | track, after, again | 16.1 / 23.6 / 24.9 | 54 | 0 (0%) | 0 | 3725 |
| LAN (no impairment) | `media` | 17.1 / 25.3 / 39.9 | 55.9 | 0 (0%) | 0 | 3715 |
| 40 ms, 0.5% | track, before | 40 / 66.7 / 108.8 | 44.6 | 4 (4.2%) | 0 | 3593 → 2148 → 3505 |
| 40 ms, 0.5% | track, before, again | 40.6 / 74.2 / 303.8 | 43.5 | 8 (7.1%) | 0 | 3608 → 2413 → 2867 |
| 40 ms, 0.5% | track, after | 40 / 73.6 / 112.8 | 45.8 | 1.3 (0.9%) | 0 | 3604 → 2199 → 3610 |
| 40 ms, 0.5% | track, after, again | 40 / 80.3 / 115.5 | 45.6 | 2.7 (1.2%) | 0 | 3611 → 2230 → 3046 |
| 40 ms, 0.5% | `media` | 61.9 / 151.8 / 216.7 | 36.1 | 5.3 (2.2%) | 0 | 1008 → 542 → 659 |
| 40 ms, 2% | track, before | 41.6 / 88.5 / 134.6 | 34.1 | 1.3 (4.7%) | 0 | 3811 → 2377 → 3517 |
| 40 ms, 2% | track, before, again | 41.7 / 129.1 / 201.7 | 36 | 2.7 (2.2%) | 0 | 3316 → 2252 → 3667 |
| 40 ms, 2% | track, after | 40.6 / 80.3 / 124.8 | 37.4 | 2.7 (1.7%) | 0 | 3587 → 2176 → 2962 |
| 40 ms, 2% | track, after, again | 40.5 / 74.8 / 100.8 | 37.9 | 1.3 (0.5%) | 0 | 3870 → 1950 → 3677 |
| 40 ms, 2% | `media` | 75.3 / 427.1 / 1103.8 | 28.1 | 22.7 (18.3%) | 0 | 398 → 518 → 626 |
| 40 ms, 5% | track, before | 44 / 146.1 / 693 | 24 | 17.3 (13.4%) | 0 | 3864 → 2276 → 3029 |
| 40 ms, 5% | track, before, again | 44.7 / 147.9 / 253.1 | 25.8 | 12 (6.9%) | 0 | 3728 → 2271 → 3167 |
| 40 ms, 5% | track, after | 42.8 / 96.7 / 194.7 | 27.6 | 5.3 (3%) | 0 | 3837 → 2064 → 2719 |
| 40 ms, 5% | track, after, again | 49.3 / 161.1 / 302.6 | 24.1 | 10.7 (5.3%) | 0 | 3671 → 2441 → 3394 |
| 40 ms, 5% | `media` | 98.4 / 1091.8 / 1375.4 | 14 | 44 (55.3%) | 0 | 410 → 459 → 339 |
| 100 ms, 0.5% | track, before | 71.9 / 117.9 / 170.1 | 39.9 | 6.7 (6.1%) | 0 | 3674 → 2376 → 3288 |
| 100 ms, 0.5% | track, before, again | 73 / 142.5 / 207.4 | 40.7 | 5.3 (3.7%) | 0 | 3699 → 2324 → 3028 |
| 100 ms, 0.5% | track, after | 71.8 / 106.3 / 162.6 | 41.8 | 2.7 (1.5%) | 0 | 3715 → 2275 → 3202 |
| 100 ms, 0.5% | track, after, again | 72 / 126.2 / 365.3 | 38.6 | 5.3 (2.1%) | 0 | 3526 → 2269 → 3467 |
| 100 ms, 0.5% | `media` | 84.2 / 286.7 / 477.3 | 33.4 | 14.7 (6.2%) | 0 | 542 → 577 → 646 |
| 100 ms, 2% | track, before | 74.8 / 166 / 278.6 | 26.1 | 4 (2.1%) | 0 | 3687 → 2206 → 3212 |
| 100 ms, 2% | track, before, again | 74.6 / 174.7 / 1055.5 | 24.8 | 13.3 (11.2%) | 0 | 3843 → 2233 → 3210 |
| 100 ms, 2% | track, after | 74.1 / 167.5 / 271 | 27.1 | 16 (6.9%) | 0 | 3787 → 2072 → 3186 |
| 100 ms, 2% | track, after, again | 73.3 / 164.1 / 304.2 | 27.3 | 13.3 (6%) | 0 | 3722 → 2174 → 3145 |
| 100 ms, 2% | `media` | 308.9 / 1043.6 / 2163.7 | 17 | 45.3 (34.5%) | 0 | 536 → 478 → 425 |
| 100 ms, 5% | track, before | 146.9 / 279.1 / 373.6 | 17.8 | 26.7 (11.3%) | 0 | 3828 → 2264 → 3735 |
| 100 ms, 5% | track, before, again | 130.3 / 272.6 / 1110.9 | 17 | 32 (18.5%) | 0 | 3884 → 2203 → 2743 |
| 100 ms, 5% | track, after | 134.7 / 247.6 / 350.4 | 17.4 | 30.7 (14.3%) | 0 | 3061 → 2124 → 3571 |
| 100 ms, 5% | track, after, again | 123.8 / 233.1 / 574.8 | 17.5 | 33.3 (14.8%) | 0 | 3728 → 1978 → 2786 |
| 100 ms, 5% | `media` | 4644.7 / 7686.5 / 7872 | 5 | 29.3 (81.1%) | 11 | 483 → 420 → 453 |
| 200 ms, 0.5% | track, before | 126.1 / 187.7 / 316.9 | 32.7 | 64 (28.8%) | 0 | 3843 → 2160 → 3075 |
| 200 ms, 0.5% | track, before, again | 125.8 / 212.8 / 2966.9 | 29.6 | 60 (32.3%) | 0 | 3820 → 1983 → 3534 |
| 200 ms, 0.5% | track, after | 133 / 300.4 / 468.6 | 27.3 | 70.7 (27.6%) | 0 | 2735 → 2173 → 3109 |
| 200 ms, 0.5% | track, after, again | 126 / 193.7 / 365.9 | 31.7 | 72 (29.7%) | 0 | 3832 → 2190 → 3415 |
| 200 ms, 0.5% | `media` | 251.3 / 1819.6 / 2028.2 | 17.2 | 45.3 (42.1%) | 0 | 397 → 311 → 435 |
| 200 ms, 2% | track, before | 146.2 / 328.3 / 613.4 | 13.1 | 80 (44.6%) | 1 | 3802 → 2066 → 3446 |
| 200 ms, 2% | track, before, again | 130.4 / 333.4 / 769.8 | 16.7 | 81.3 (38.1%) | 0 | 3836 → 2241 → 2962 |
| 200 ms, 2% | track, after | 152.3 / 354.1 / 757.9 | 14.8 | 92 (37.4%) | 0 | 3824 → 2149 → 3108 |
| 200 ms, 2% | track, after, again | 168.6 / 425.4 / 862.4 | 14.2 | 105.3 (43.8%) | 0 | 3876 → 2237 → 3211 |
| 200 ms, 2% | `media` | 16671.4 / 20839 / 20985.6 | 1.9 | 26.7 (90.9%) | 11 | 427 → 381 → 553 |
| 200 ms, 5% | track, before | 310.5 / 510.6 / 2645.6 | 11.4 | 49.3 (36.3%) | 1 | 3802 → 2093 → 2758 |
| 200 ms, 5% | track, before, again | 311.7 / 495.6 / 2807.8 | 12.5 | 50.7 (27.4%) | 0 | 3815 → 2266 → 3228 |
| 200 ms, 5% | track, after | 304.6 / 467 / 715.7 | 13.7 | 50.7 (20.9%) | 0 | 3633 → 1973 → 3446 |
| 200 ms, 5% | track, after, again | 298.3 / 392.4 / 660.3 | 13.3 | 48 (21.4%) | 0 | 3704 → 1976 → 2765 |
| 200 ms, 5% | `media` | 30599.8 / 33387.3 / 33431.3 | 4.2 | 28 (79.3%) | 11 | 392 → 462 → 424 |

- **40 ms and 100 ms with 0.5%**, the commonest home internet: the track now freezes a third to a sixth as often as
  before (0.9 to 2.1% frozen against 3.7 to 7.1%) and is ahead of `media` on every count, a third less delay at the
  median and half at the 95th percentile at 40 ms. At 40 ms with 2 and 5% loss it froze 0.5 to 5.3% of the time, from
  2.2 to 13.4%.
- **100 and 200 ms with 2 to 5% loss** freeze about as often as before (6 to 15% at 100 ms, 37 to 44% at 200 ms and
  2%, and 28 to 30% at 200 ms and 0.5%), except 200 ms and 5% (21% from 27 to 36%); the 99th percentile fell by up to
  three quarters. What is left there is the round trip each lost packet costs: an H.264 frame waits for every packet
  before it (below), and at 200 ms and 2% about eight are lost a second, each holding the picture for a round trip.
- **On a LAN** the two are the same within a millisecond (16/24 ms for the track, 17/25 for `media`); the track shows
  54 pictures a second to `media`'s 56, though it decodes all 57 (`framesDecoded`): the rest are never presented
  (`requestVideoFrameCallback` skips them). Not a difference worth switching carriers for, which costs a keyframe and
  a decoder mid-session.
- **The mode**, then: the track wherever the viewer can show it, on every link; `media` is what a viewer or server that
  cannot do the track falls back to, as before. No per-link switch was built: no profile has `media` ahead.

Weighed for repairing a loss without waiting a round trip, and not built:

- **Intra refresh, long-term references, reference invalidation, decoding past a gap**: Chrome's packet buffer
  (libwebrtc's `modules/video_coding/packet_buffer.cc`) hands an H.264 delta frame on only once no sequence number
  before it is missing, unless the packet carries a generic frame descriptor, and it starts a stream again only on an
  IDR. So on the track as negotiated, a loss holds every later picture until its resend or a keyframe arrives, whatever
  the encoder's references; intra refresh would only spread a keyframe out, and a viewer could not even restart on it.
- **ULPFEC in RED**: str0m negotiates RED for audio only and writes the header extensions (the transport-wide
  sequence number) as it sends, after castd would have had to XOR them; and without a generic descriptor a lost FEC
  packet is a sequence gap that holds the next frame as a lost picture packet does. FlexFEC: Chrome offers it only
  behind a field trial.
- **The dependency descriptor and temporal layers**: Chrome 156 negotiates the descriptor when the viewer asks
  (`setHeaderExtensionsToNegotiate`; it lists it as stopped), which lifts the rule above, and openh264's two temporal
  layers make every other frame one nothing references, whose loss costs that frame alone. But reference frames carry
  most of the packets, so at 200 ms and 2% the picture would still wait on a round trip several times a second; it
  needs a descriptor writer and layering in every encoder for perhaps half the stalls, and was left.
- **Proactive resends**, each packet sent again on the RTX stream right after it, so a picture waits only when both
  copies are lost: measured once with a str0m patched to do it (`StreamTx::set_duplicates`, not kept) and the encoder
  given half the share: at 200 ms and 2%, 8.1% frozen against 34 to 44%, 37 pictures a second against 14 to 17, NACKs
  from 678 to 99; at 100 ms and 2%, 41 pictures a second against 27. But doubling what crossed the link made the
  3 Mbit/s step collapse the estimate (p95 2.1 s). It needs str0m to offer it (str0m has no way to resend unasked) and
  a rate that makes room for it only where loss and round trip call for it: the largest gain left for 200 ms links.

**The stuck picture** did not come back: 40 LAN runs of the track, 30 s each, every picture's stamp read, no PLI, no
keyframe, the longest gap between pictures 33 to 67 ms in 38 of them and 333 and 367 ms in two the host loaded.
Once, at 40 ms and 0.5% with keyframes asked for, no picture was encoded for six seconds with the flow open; the
`capture: N ms in <step>` warning added for it has since caught the same shape in one loaded stretch, up to 4.1 s in
the synthetic screen's `pump` and 4.4 s in its `grab` (a mutex and a 3.7 MB copy) and a 1.8 s encode, with the host
swapping and its cores busy: the bench's own process stalled, most likely the first time too.

**Left**, as of this measurement:

- 200 ms links with 2 to 5% loss, still frozen a fifth to two fifths of the time: proactive resends (above), or the
  descriptor with a reference structure that skips a lost frame.
- At 200 ms a cap's fall still leaves 1.5 to 2 s of stale pictures while resends repair the burst; a keyframe once a
  burst would take longer to repair than to replace was not tried.
- openh264's keyframes stay about 1.5 times the budget (its QP for an IDR tops out at 40).
- Starting on a bad link: the socket carries video until the peer is up, and at 200 ms and 5% the answer once waited
  16 s behind it and the peer then failed (the page measured nothing). Holding video off the socket while an offer
  is pending would fix it.
- The estimate climbs back slowly after a cap lifts: about 3.5 Mbit/s 15 s after the cap went back to 10.

## VA-API

(2026-11-21) `vaapi` ([src/vaapi](src/vaapi)) is an encoder kind and castd's `Backend::Vaapi` (`--encoder vaapi`, and
`auto` after NVENC). libva.so.2 and libva-drm.so.2 are opened at run time and the part of libva 2.22's API it uses is
written out in ffi.rs (MIT headers; a test holds the structs to the sizes and offsets bindgen computed from them), so
it builds with no headers and runs where libva is absent. `device()` takes `CAST_VAAPI_DEVICE` or the first render
node whose driver offers H.264 encoding (on WSL2, where the node is vgem, libva is told `d3d12` when its own guess
fails), once a process.

- **castd's contract**: High profile where offered (CABAC, the 8x8 transform), else Main, else Constrained Baseline;
  the low-power entry point (Intel's VDEnc) where there is one (`CAST_VAAPI_LOW_POWER=0` leaves it); one reference, no
  B-frames, picture order from frame order; a GOP of 32,767 told to the driver and an IDR only when asked; each
  picture synced and its coded buffer read before `encode` returns.
- **Rate control** is NVENC's floor: VBR (CBR where the driver has no VBR, or `CAST_VAAPI_RC=cbr`) at the
  controller's cap, `min_qp` at castd's CRF, the HRD buffer castd's 1.25 frames (or `set_rate_buf`'s, full), frame
  skipping and bit stuffing off. A rate change is a new rate-control and HRD parameter on the next picture.
- **Headers**: the SPS and PPS are castd's ([h264.rs](src/vaapi/h264.rs)), a packed sequence header on each IDR where
  the driver takes one, saying what x264's and NVENC's do (BT.601 limited range from sRGB) plus a bitstream
  restriction (nothing reordered). A driver without packed headers writes its own, which `headers` reads back.
- **Pictures**: I420 interleaved into the NV12 surface through a derived image where the driver gives one, else an
  image put onto it. `VaapiKind { vpp: true }` (`CAST_VAAPI_VPP=1`) takes BGRA instead and has the driver's video
  processor convert it (sRGB full range to BT.601 limited), leaving the CPU only a copy; off by default (below).
- **Measured** on rog's WSL2 Arch (Mesa 26.2.7's d3d12 driver, libva 2.24), the only VA-API driver on these
  computers: on the RTX 5080 (`MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA`) it passes the self-test (packed headers, the
  I420 path) and streams as NVENC does (remoted's README has the numbers); on the Intel iGPU, d3d12's default, every
  picture comes back empty (FFmpeg's `h264_vaapi` as well), which the encoder reports as an error. The d3d12 driver
  segfaults in `vaEndPicture` in its video processor (FFmpeg's `scale_vaapi` too) and when no packed header is given,
  so a daemon that must outlive a driver probes in a child process (remoted does). Intel's iHD and AMD's radeonsi, the
  drivers VA-API is for, were not reachable: neither the low-power path, nor a driver writing its own headers, nor
  the video processor's colours have been checked on them.

## Features and Windows

`libyuv` (the default) converts BGRX to I420 with libyuv; without it a portable converter does libyuv's arithmetic in
Rust. `x264` links libx264 (GPL-2.0), `nvenc` binds NVIDIA's encoder on CUDA (Linux), `vaapi` VA-API's (Linux, below),
`opus` and `pulse` the sound.
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
