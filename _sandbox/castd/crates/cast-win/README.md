# cast-win

The Windows platform for cast-core: each monitor captured with DXGI Desktop Duplication and kept on the GPU for NVENC or Media Foundation's hardware encoder, openh264 where neither passes, SendInput, the clipboard, the pointer's shape and WASAPI loopback.

## Key files

- [src/capture.rs](src/capture.rs) — desktop duplication of one monitor, its damage, the GPU and memory sinks, losing and
  regaining the desktop.
- [src/select.rs](src/select.rs) — which encoder a monitor is sent with, each proven by a self-test on its GPU first.
- [src/nvenc.rs](src/nvenc.rs) — NVIDIA's encoder on D3D11, reading the captured textures in place.
- [src/mft.rs](src/mft.rs) — Media Foundation's hardware H.264 encoder (Quick Sync, AMD) on the same device.
- [src/input.rs](src/input.rs) — SendInput: DOM keys and codes, Unicode text, the pointer over the virtual desktop.
- [src/screen.rs](src/screen.rs) — one monitor put together: what intentic-remoted's Windows platform opens.

On any other target the crate is empty, so castd's workspace still builds and tests on Linux. remoted's Windows build
links it (`_devices/remoted/src/media/windows.rs`).

## Capture

One monitor is one [`DxgiSource`](src/capture.rs) (cast-core's `ScreenSource`). The process is made per-monitor DPI aware
(v2) first, so every coordinate is a physical pixel and `DuplicateOutput1` is allowed; it asks for BGRA, so Windows
converts an HDR desktop, and `DuplicateOutput` is the fallback. Monitors are listed from DXGI joined with the display
configuration ([displays.rs](src/displays.rs)): a monitor's id hashes its EDID manufacturer and product, its connector's
kind and instance and its target id, so it is stable across reboots, a mode change and other monitors coming and going,
and its session is `screen-<id>`.

- **A thread and a device of the duplication's own.** `AcquireNextFrame` holds its D3D11 device's lock while it waits:
  measured on omen, a copy on that device waited 219-435 ms behind it on a still screen. So the duplication thread has a
  device nobody else uses, copies each frame's dirty and move rectangles into a mirror texture there and releases the
  frame at once; the mirror is shared (an NT handle, a keyed mutex orders the two devices) with the pipeline's device,
  where a copy now costs 0.12-0.37 ms to submit.
- **Frames on the GPU** (`Sink::Gpu`): the pipeline's frames are textures on the encoder's device and `fill` copies the
  damaged rows from the mirror on the GPU; the picture never reaches the CPU. The capture also fills CPU frames, read
  back for them, so openh264 can take a picture the hardware encoder cannot open at.
- **Another GPU** (an Optimus panel on the Intel iGPU, NVENC on the NVIDIA one): the damaged rows go through memory
  (staging readback on one, `UpdateSubresource` on the other). It works and is slow (below), so selection prefers the
  monitor's own GPU's encoder.
- **Frames in memory** (`Sink::Cpu`, openh264): the damaged rows are read back through a staging texture.
- **Losing it.** A mode change, a desktop switch and a GPU reset take duplication away (`DXGI_ERROR_ACCESS_LOST`,
  `DEVICE_REMOVED`): the thread duplicates again, and a new size, a monitor moved to another GPU or a reset device has the
  pipeline open a new capture. While it may not duplicate (the secure desktop of a sign-in, a UAC prompt or
  Ctrl+Alt+Del, which only a SYSTEM service can capture) the picture is a placeholder saying "Secure desktop (sign-in,
  lock screen, UAC or Ctrl+Alt+Del): not visible remotely", never the last frame frozen. A monitor missing for 5 s ends
  the screen, its viewers told it was unplugged.
- **GDI** ([gdi.rs](src/gdi.rs)) where duplication is not offered (`DXGI_ERROR_UNSUPPORTED`: Remote Desktop, some VMs,
  four duplications already) or is refused while the desktop showing is the person's own: BitBlt at 30 fps at most,
  damage found by comparing 64x32 tiles. It checks every 5 s whether duplication works again and hands back to it.
  `CAST_WIN_CAPTURE=gdi` forces it.
- While a capture runs, its thread asks Windows to keep the display on (`ES_DISPLAY_REQUIRED`), as a screen someone is
  watching should not go dark; the request ends with the thread and no power setting changes.

**The pointer** is never in the picture: duplication hands its shape over separately ([cursor.rs](src/cursor.rs)), and
it goes to viewers as cast-core's cursor message, a PNG and its hotspot. Colour shapes are reordered to RGBA;
monochrome (AND and XOR masks) and masked-colour shapes are painted as a browser can draw them, an inverting pixel
black with a white rim; the standard system cursors also carry their CSS keyword. A pointer hidden on this monitor
(typing, or on another monitor) is sent as `none`.

## Encoders

[select.rs](src/select.rs) picks per monitor, the first that passes its self-test (an IDR with SPS and PPS, deltas that
come straight back, a rate change that adds no keyframe, an IDR on demand; cast-core's test, with the pictures as
textures on the encoder's GPU). `CAST_WIN_ENCODER=nvenc|mf|openh264` asks for one.

1. **NVENC on the monitor's own GPU** ([nvenc.rs](src/nvenc.rs)): `nvEncodeAPI64.dll` opened at runtime, a session on the
   D3D11 device, the frames registered as `NV_ENC_BUFFER_FORMAT_ARGB` (the encoder converts to 4:2:0), P1 with the
   ultra-low-latency tuning, no B-frames, an infinite GOP with an IDR on demand, a rate change by
   `nvEncReconfigureEncoder` with neither a reset nor an IDR, castd's QP floor under the cap (paint-over lowers it).
   `CASTD_NVENC_PRESET=1..7` as castd's. The bindings ([src/generated/nvenc_sys.rs](src/generated/nvenc_sys.rs)) were
   made with cast-core's own bindgen setup from ffnvcodec 12.1's header.
2. **Media Foundation on the monitor's own GPU** ([mft.rs](src/mft.rs)): the adapter's hardware H.264 MFT (`MFTEnum2` with
   its LUID), a DXGI device manager, BGRA in where it takes ARGB32 (Intel's does) else NV12 converted by the GPU's video
   processor, low-latency mode, low-delay VBR or peak-constrained VBR, no B-frames, an IDR only when asked
   (`CODECAPI_AVEncVideoForceKeyFrame`). The mean bitrate alone moves under a peak set at the open: changing both at once
   made Intel's encoder start over with an IDR, either one alone did not (rog and omen). Not NVIDIA's own MFT: activating
   it failed on both laptops and left the driver refusing the next NVENC session in the process.
3. **NVENC on another GPU**, the rows crossing through memory.
4. **openh264** (cast-core's), reading the picture back.

H.264 High 4:4:4 is not used: browsers do not decode it, and paint-over sharpens text instead.

## Input, clipboard, sound

- **Input** ([input.rs](src/input.rs)), cast-core's `InputSink`: a character key types `key` on the key that types it on
  the focused window's layout (Shift pressed or lifted around it, Caps Lock allowed for), else as Unicode, which is also
  how an AltGr character goes, this viewer's Ctrl and Alt lifted around it; every other key goes as the scancode its
  DOM `code` names, E0 where the key has it (right modifiers, the keypad's Enter and divide, the navigation cluster,
  media and browser keys), so raw input sees what a keyboard sends; the keypad's keys stay the keypad's. `text` is
  Unicode, Enter and Tab as keys. The pointer is absolute over the virtual desktop, the monitor's origin added to the
  picture's point; buttons 1-5; the DOM `buttons` mask lets go of a button whose `up` was lost. Scrolling is the
  high-resolution wheel, 120 units per 100 CSS px at the monitor's scale, fractions carried by cast-core's
  `ScrollAcc`. Each viewer's keys and buttons are its own and are let go when it leaves. `BlockInput` is never used.
- **Clipboard** ([clipboard.rs](src/clipboard.rs)): text, `HTML Format` (its fragment) and an image (`PNG`, a DIB made
  into one), both ways, polled every 250 ms by its sequence number; our own write and a viewer's content read back are
  never sent out again.
- **Sound** ([audio.rs](src/audio.rs)): WASAPI loopback of the default output device, 48 kHz stereo 16-bit converted by
  Windows, a 20 ms buffer drained every 2 ms, so a 10 ms packet leaves about 12 ms after it played; cast-core encodes it
  with opus1 (libopus in Rust), since there is no libopus to link here.

## Measured

2026-11-20 on `rog` (RTX 5080 Laptop GPU, Intel Graphics driving the 2560x1600 240 Hz panel, Windows 11 26200) and
`omen` (RTX 3080 Laptop GPU driving an LG TV at 1920x1080, Intel UHD driving the 2560x1440 panel, Windows 11 26300), both
on mains power, release builds cross-compiled here with cargo-xwin. Every self-test passed where its hardware is: NVENC
on both RTX GPUs, Intel's Quick Sync MFT on both iGPUs, openh264 on both; all three monitors duplicated with GPU frames.

**The pipeline, end to end on the computer itself** (`examples/serve.rs --synthetic`, cast-core's `examples/viewer.rs`
over loopback TCP, 10 s after 2 s of warm-up, the server's whole process CPU). Neither laptop could be duplicated with
moving content while measured (omen sat at its sign-in screen, which duplication captures but no window draws over; rog
refused duplication with `E_ACCESSDENIED` for every process from about 16:00 on while its input desktop was still the
person's own, and by 16:30 GDI read it black, its display most likely asleep), so the picture is drawn on the encoder's GPU and copied into the pipeline's frame on the GPU, as the
duplicated desktop is; what is left out is duplication's own wait for the next composed frame. Scroll: a text page
moving 8 px a frame; video: a smooth picture panning.

| computer | size | encoder | scene | fps | Mbit/s | capture to arrival p50 / p90 / p99 | CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rog | 1920x1080 | NVENC | scroll | 60 | 11.8 | 2.9 / 6.5 / 12.4 ms | 0.05 cores |
| rog | 1920x1080 | NVENC | video | 60 | 3.4 | 10.7 / 11.6 / 15.8 ms | 0.07 cores |
| rog | 1920x1080 | Quick Sync (MF) | scroll | 60 | 20.0 | 7.8 / 8.6 / 17.8 ms | 0.14 cores |
| rog | 1920x1080 | Quick Sync (MF) | video | 60 | 13.1 | 7.7 / 8.3 / 13.7 ms | 0.06 cores |
| rog | 1920x1080 | openh264 | scroll | 58 | 6.5 | 15.0 / 29.7 / 42.4 ms | 0.92 cores |
| rog | 1920x1080 | openh264 | video | 60 | 9.1 | 13.2 / 15.3 / 19.9 ms | 0.91 cores |
| omen | 1920x1080 | NVENC | scroll | 60 | 12.1 | 11.3 / 12.1 / 13.0 ms | 0.05 cores |
| omen | 1920x1080 | NVENC | video | 60 | 3.3 | 11.2 / 12.1 / 12.6 ms | 0.02 cores |
| omen | 1920x1080 | Quick Sync (MF) | scroll | 60 | 33.2 | 7.3 / 9.9 / 25.8 ms | 0.10 cores |
| omen | 1920x1080 | Quick Sync (MF) | video | 60 | 16.1 | 7.1 / 8.1 / 9.4 ms | 0.07 cores |
| omen | 1920x1080 | openh264 | scroll | 59 | 6.5 | 20.9 / 34.2 / 50.2 ms | 1.09 cores |
| omen | 1920x1080 | openh264 | video | 60 | 9.0 | 19.0 / 27.1 / 39.9 ms | 1.19 cores |
| rog | 2560x1600 | NVENC | scroll | 60 | 21.2 | 5.1 / 12.0 / 17.2 ms | 0.04 cores |
| rog | 2560x1600 | NVENC | video | 60 | 5.8 | 12.1 / 24.4 / 49.6 ms | 0.03 cores |
| rog | 2560x1600 | Quick Sync (MF) | scroll | 60 | 34.6 | 13.0 / 19.7 / 33.7 ms | 0.07 cores |
| rog | 2560x1600 | Quick Sync (MF) | video | 60 | 24.2 | 12.6 / 13.2 / 13.9 ms | 0.09 cores |
| rog | 2560x1600 | openh264 | scroll | 46 | 6.7 | 49.2 / 77.4 / 99.7 ms | 1.31 cores |
| rog | 2560x1600 | openh264 | video | 57 | 16.2 | 33.4 / 48.2 / 64.2 ms | 1.37 cores |
| omen | 2560x1440 | NVENC | scroll | 60 | 18.9 | 16.4 / 18.0 / 20.0 ms | 0.06 cores |
| omen | 2560x1440 | NVENC | video | 60 | 5.0 | 16.6 / 17.7 / 21.9 ms | 0.02 cores |
| omen | 2560x1440 | Quick Sync (MF) | scroll | 60 | 52.8 | 10.4 / 18.3 / 44.4 ms | 0.15 cores |
| omen | 2560x1440 | Quick Sync (MF) | video | 60 | 25.5 | 10.6 / 14.2 / 16.3 ms | 0.14 cores |
| omen | 2560x1440 | openh264 | scroll | 41 | 6.5 | 54.1 / 93.2 / 113.8 ms | 1.52 cores |
| omen | 2560x1440 | openh264 | video | 40 | 10.7 | 57.8 / 78.6 / 94.6 ms | 1.69 cores |

**The encoders alone** (`examples/encbench.rs`, frames paced at 60 fps, a picture copied into the frame on the GPU before
each; wall time from the frame handed over to its access unit back, CPU of that call; `move` is what the path spends
moving the picture through memory per frame):

| computer | size | encoder | scroll: wall p50, CPU | video: wall p50, CPU | move |
| --- | --- | --- | --- | --- | --- |
| rog | 1920x1080 | NVENC | 2.0 ms, 0.14 ms | 9.7 ms, 0.34 ms | none |
| rog | 1920x1080 | NVENC through memory | 2.0 ms, 0.41 ms | 11.2 ms, 0.48 ms | 1.3 ms |
| rog | 1920x1080 | Quick Sync (MF) | 7.1 ms, 0.82 ms | 6.9 ms, 0.61 ms | none |
| rog | 1920x1080 | openh264 | 9.2 ms, 5.4 ms | 5.1 ms, 1.0 ms | 1.7 ms |
| rog | 2560x1600 | NVENC | 10.6 ms, 0.07 ms | 10.9 ms, 0.41 ms | none |
| rog | 2560x1600 | NVENC through memory | 26.1 ms, 0.68 ms | 26.7 ms, 0.14 ms | 3.5-4.7 ms |
| rog | 2560x1600 | Quick Sync (MF) | 12.0 ms, 0.61 ms | 11.9 ms, 0.75 ms | none |
| rog | 2560x1600 | openh264 | 19.5 ms, 13.9 ms | 10.0 ms, 2.1 ms | 3.3-3.5 ms |
| omen | 1920x1080 | NVENC | 6.6 ms, 0.48 ms | 10.1 ms, 0.0 ms | none |
| omen | 1920x1080 | Quick Sync (MF) | 5.9 ms, 0.61 ms | 6.1 ms, 0.88 ms | none |
| omen | 2560x1440 | NVENC | 16.0 ms, 0.2 ms | 15.5 ms, 0.54 ms | none |
| omen | 2560x1440 | NVENC through memory | 24.6 ms, 0.48 ms | 19.3 ms, 0.34 ms | 1.4-2.0 ms |
| omen | 2560x1440 | Quick Sync (MF) | 8.3 ms, 0.54 ms | 8.5 ms, 0.41 ms | none |
| omen | 2560x1440 | openh264 | 17.9 ms, 11.4 ms | 15.3 ms, 1.5 ms | 3.4-4.0 ms |

What the numbers say:

- **NVENC's latency follows the laptop GPU's clock.** The same 1600p encode took 3.5-4.3 ms for the first seconds of a
  run and 10-11 ms once the GPU had settled at the light load a 60 fps stream is (unpaced it stays at 1.4 ms at 1080p).
  Its CPU is negligible either way (0.02-0.07 cores for the whole process at 1080p60). Holding the clock up is a driver
  setting (NVIDIA's "prefer maximum performance" for the process), which cast-win does not change.
- **Quick Sync is the steadier path on these laptops**: 6-12 ms whatever the clock, under 0.15 cores, and on an
  Optimus panel it is the only zero-copy one, so selection takes it before NVENC through memory.
- **NVENC through memory** costs 1.3-4.7 ms of CPU per full-screen frame (0.1-0.3 cores at 60 fps of full motion) and adds
  9-16 ms of latency at 1440p/1600p: correct, and the last hardware choice.
- **openh264** holds 60 fps at 1080p on one core; at 1440p and up it falls behind on full-screen motion (40-57 fps). In
  screen-content mode it turns scene-change detection on whatever it is told, and with no long-term references a scene
  change is an IDR it was not asked for: the synthetic video's jump back to its first picture every 30 frames came out
  as 2 keyframes a second. A real desktop's equivalent is a window switch.
- Quick Sync spends its peak bitrate even on unchanged pictures (6-10 Mbit/s on a still scene when fed one every frame);
  the pipeline sends no frame for a still screen, so this costs only during paint-over.

Not measured yet: capture to arrival with desktop duplication on moving content (duplication of each laptop's own
screen was measured working, 0.12-0.37 ms to copy a frame on the GPU, 5-10 ms to read one back and convert it for
openh264), and across a network: the Windows firewall asks the person at the screen before a program listens on the LAN,
so every run here was on the computer's own loopback.

## Testing

```sh
cargo xwin check -p cast-win --target x86_64-pc-windows-msvc --tests --examples
cargo xwin test -p cast-win --target x86_64-pc-windows-msvc --release --no-run   # then run the test .exe on Windows
cargo xwin build -p cast-win --target x86_64-pc-windows-msvc --release --examples
```

The unit tests (cursor shapes, scancodes, the clipboard's HTML and DIB round trips, GDI's tiles, NVENC's struct layouts,
monitor ids) passed on omen, 11 of 11 (2026-11-20). The examples run on a Windows PC: `probe` (adapters, monitors, a capture and screenshot of each, every encoder's
self-test), `dupcheck` (what duplication answers per output), `encbench`, `serve` (a monitor, or `--synthetic`, served
over loopback TCP with cast-core's router) with cast-core's `viewer` example, and `pattern` (scroll, video or noise in a
window of its own that never takes focus).

## Credits

The input's handling of characters and layouts, the loopback loop and the clipboard's DIB conversions follow voxl's
Windows backend ([voxl](https://github.com/tembo/voxl), Tembo, MIT; castd's [LICENSE](../../LICENSE)). The NVENC bindings
are generated from NVIDIA's nvEncodeAPI.h as ffnvcodec ships it (MIT). openh264 is Cisco's (BSD-2-Clause), opus1 is
libopus ported to Rust (BSD-3-Clause).
