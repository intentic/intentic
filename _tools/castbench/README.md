# castbench

End-to-end benchmark of the in-editor browser's stream: what a page costs to encode, how soon its pixels are decoded, and how fast a keystroke comes back, for today's ffmpeg pipeline and for castd, checked against a baseline and the stream's budgets.

A run puts a real headful Chromium on an Xvfb display of its own, streams it through one pipeline and one link to a
headless Chromium that decodes with WebCodecs' `VideoDecoder` the way the editor's `videoSink.ts` does, and reads a
marker the page paints into its own content back off every decoded frame. Modelled on voxl's `bench/`
(tembo/voxl at 21f194f: `loadgen.c`, `nclient.py`, `shaper.py`).

```dag
{ "title": "One run", "direction": "LR",
  "nodes": [
    { "id": "page", "label": "Workload page", "note": "headful Chromium on Xvfb, paints the marker", "accent": "1" },
    { "id": "probe", "label": "Display probe", "note": "reads the marker off Xvfb's framebuffer", "accent": "neutral" },
    { "id": "pipe", "label": "Pipeline", "note": "legacy: the daemon's videocast · castd: its Unix socket", "accent": "2" },
    { "id": "relay", "label": "Relay", "note": "netd's hop, shaped to the link", "accent": "3" },
    { "id": "viewer", "label": "Viewer", "note": "headless Chromium, VideoDecoder, reads the marker", "accent": "4" }],
  "edges": [
    { "from": "page", "to": "pipe" }, { "from": "page", "to": "probe", "dashed": true },
    { "from": "pipe", "to": "relay" }, { "from": "relay", "to": "viewer" }, { "from": "viewer", "to": "relay", "dashed": true }] }
```

## What it measures

- **Workloads** (`src/pages/workload.ts`): `still`, an article that never changes; `anim`, a box sliding over it with
  the marker repainted at 60 Hz; `scroll`, a long article scrolled 6 px a frame; `typing`, a textarea, where the viewer
  types a key every 150-250 ms and ends on three 10,000-character pastes; `flood`, the whole viewport redrawn every
  frame with confetti no motion search predicts, the one workload that needs more than a 5 Mbit/s link carries, so the
  one that shows what a pipeline does when the link is the limit.
- **Pipelines.** `legacy` is today's: the daemon's own `videocast.ts`, `region.ts`, `display.ts` and `screencast.ts`,
  loaded from its source at run time (`src/daemon.ts`), so the ffmpeg command line, the access-unit split, the frame
  gate and the viewport crop are exactly what a sandbox runs, never a copy. `castd` reaches a castd over its Unix socket
  in browser-wire's media protocol and acks every decoded frame as the editor will.
- **Links.** `direct`, `10mbit-40ms` and `5mbit-60ms`, or any `<rate>mbit-<rtt>ms`. Every link goes through the relay
  (`src/shaper.ts`), a byte proxy like netd: rate-capped toward the viewer with a bounded queue (`--queue-ms`, 200 by
  default; `inf` for a bufferbloated path), half the round trip added each way. Packet loss cannot be emulated: over
  TCP a lost packet is a retransmit the kernel hides, so no userspace TCP proxy can show it.
- **Numbers per run** (`src/results.ts`): encoder, Xvfb and Chromium CPU cores from `/proc`, read only before and after
  the window so metering costs the pipeline nothing; frames per second on the wire and unique ones (a marker not seen
  before); Mbit/s; content drawn → decoded latency, split by the display probe into Chromium's share (drawn → on the X
  display) and the pipeline's (display → decoded); stalls (no new picture for 100 ms while the page moves);
  keystroke → glyph and paste → all decoded.

The marker (`src/marker.ts`) is 48 black and white 16 px blocks at the viewport's (16, 16): a 16-bit frame number, the
low 24 bits of the epoch in ms, and a CRC-8, since x11grab can catch a canvas half-written. Every process on one machine
reads the same clock, so a latency is a subtraction.

## Running it

From a full checkout, with Bun (the legacy pipeline imports the daemon's TypeScript): `pnpm --filter @intentic/castbench
castbench -- <command>`, or `bun --conditions=@intentic/src src/cli.ts <command>` here. It needs Xvfb, ffmpeg and
Playwright's Chromium (`CASTBENCH_CHROMIUM` to use another). One run holds one Xvfb, one headful and one headless
Chromium, about 0.8 GB. Time anything you keep under `quiet --`, which waits for a calm machine.

```sh
castbench run                                                  # today's pipeline, every workload × the three links
castbench run --workload anim,typing --link direct --seconds 6 # a quick look
castbench run --out run.json --compare                         # a run, then its table against baselines/legacy.json and budgets.json
castbench compare run.json [--baseline other.json] [--strict]  # a saved run; --strict exits 1 on a failed budget
castbench run --dump /tmp/raw                                  # each run's raw events too: the viewer's log, the probe's sightings
castbench run --pipeline castd --castd-command 'castd --display {display} --socket {socket} …'  # castd started per matrix
castbench run --pipeline castd --castd-socket /run/intentic/cast/own.sock --castd-token … --castd-pid …  # one already running
castbench run --pipeline castd --stage daemon \
  --castd-command 'bun --conditions=@intentic/src src/cli.ts stub-castd --display {display} --socket {socket} --region {region}'
castbench run --pipeline castd --peer --castd-command 'castd … --rtc-udp 127.0.0.1:0'  # the stream on a peer connection
castbench edge                                                 # the edge hairpin, against SANDBOX_PUBLIC_URL
castbench edge --door https://ingress.example                  # and split it into the edge's front door and its tunnel
```

`--stage daemon` (legacy's default) lays the window out as a sandbox does: a 2560x1600 screen, the window in its
bottom-right corner, the picture its viewport. `--stage window` (castd's default) makes the screen the picture, Chromium
in kiosk mode filling it. `stub-castd` is a stand-in that speaks the media wire with the daemon's ffmpeg behind it: it
proves the adapter and the viewer's media path, and its numbers mean nothing. `--peer` has the viewer open a peer
connection to castd where castd's hello offers one, as the editor's `mediaRtc.ts` does, and measure the run on it; the
relay then carries only the socket's signalling, and each result says which carrier it was measured on (`carrier`).

## Baseline and budgets

`baselines/legacy.json` is today's pipeline on every workload and link, recorded by hand on a sandbox (CI has no Xvfb
and no steady clock to time against) with `quiet -- castbench run --out baselines/legacy.json`. Each results file
records its host and the machine's load as it began and ended, and the comparison prints both. `budgets.json` holds the
approved budgets as one-directional claims, each with its reason; `--compare` judges a run against them and, being a
lab, fails nothing unless `--strict` asks it to.

`castbench edge` answers what the hairpin costs: a sandbox on the owner's own computer is reached through the cloud
edge unless the editor's loopback shortcut is allowed and answering, so every frame and keystroke goes out and back. A
browser view socket needs a ticket only a signed-in member can mint, so from inside the sandbox it times what it can
reach without one: netd's vitals on loopback and through the edge on one kept-alive connection (the transport alone,
Node never answers them), the browser view socket's refused upgrade on both (a round trip through Node), and a TCP
connect to the edge. Given the edge's own door (`--door`, else the one netd's tunnel dials, read off netd's remembered
config), it also times the door's `/health`, which the edge answers with no tunnel in it, and reports the tunnel's share
of the hairpin as the vitals' time less the door's.

2026-11-20 on this sandbox, whose edge is the owner's own ingress on the same computer behind a Cloudflare Tunnel: 36.4
ms at p50 (54.2 at p99) through the edge against 0.2 on loopback; the door alone 18.5 ms, the TCP connect to Cloudflare
8.3, so the tunnel's share was 17.9 ms. Every hop of ours answers in under a millisecond on loopback (the ingress its own
`/health` in 0.05 ms, netd its vitals in 0.3) and none waits on Nagle; the time is the path's: the browser's request
crosses the computer's link to Cloudflare's Warsaw edge, then Cloudflare's to cloudflared on the same computer, and the
tunnel netd dials goes out through Cloudflare and back too, so one round trip crosses that link four times. From a
second network (4.0 ms to Cloudflare) the door took 16.4 ms and the vitals 32.0. A keystroke's echo on castd's socket
over a link of the edge's p50 round trip (`100mbit-38ms`) took 43.4-43.5 ms at p50 against 4.5-5.5 direct; on a peer
connection over loopback UDP, 4.6-5.1.

2026-11-20, what the first baseline found (12 s runs at load 5-8 on a 16-core host): today's pipeline spends 0.19-0.24
cores whatever the page does, a still page included, and sees at most 30 fps. Its own share of the latency, display to
decoded, is 41-55 ms on the direct link because a frame waits for the 30 fps capture and then for the next frame's
delimiter before `splitAccessUnits` lets it go (ffmpeg hands over each access unit whole, so that wait is one full frame
interval). On the 5 Mbit/s link with the page needing more (`flood`), nothing in it pushes back: the frame gate never
trips, the kernel's socket buffers fill, and pictures arrive 1.9 s late at p50. The castd worker's build of the same day
met every budget in `budgets.json` on the same host, its latency then mostly Chromium's own present (about 18 ms).

2026-11-19: a package of its own rather than a lab of `perf`, whose baselines are recorded only by its CI workflow on
CI's runners and whose tracks count work in the editor; this one times a sandbox's media plane and can only run where
Xvfb and Chromium do.

## Key files

- [src/run.ts](src/run.ts) — one matrix: stage, pipeline, relay and viewer per run, and the window each is measured in.
- [src/daemon.ts](src/daemon.ts) — the daemon's own cast modules, loaded from source so the legacy column is today's code.
- [src/client/decoder.ts](src/client/decoder.ts) — the viewer: both wires, VideoDecoder, the marker read off decoded luma, typing.
- [src/analysis.ts](src/analysis.ts) — raw events to numbers: new pictures, latencies, stalls, keystrokes.
- [src/shaper.ts](src/shaper.ts) — the relay and its bottleneck, beside the arithmetic in `src/link.ts`.
- [budgets.json](budgets.json) — the stream's budgets, judged by `src/compare.ts`.
