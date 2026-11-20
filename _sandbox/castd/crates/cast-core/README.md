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
the PNG) and `Hub::clipboard_changed` when they change on the screen.

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

The peer port (`rtc`) is castd's ICE-lite by default. `rtc::start_with` with `Ice::Full` makes it a full agent, for a
computer behind a NAT: it asks STUN servers for its server-reflexive address, takes the viewer's trickled candidates,
and sends checks of its own, whose answers come back to the peer that sent them.

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
