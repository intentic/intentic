import type { RateSummary, Summary } from "./stats.js";

// What one run measured and what a results file holds: the shape of a baseline, of `--out`, and of what `compare` reads.

export interface RunResult {
    // `legacy` (today's ffmpeg pipeline) or `castd`.
    readonly pipeline: string;
    readonly workload: string;
    readonly link: string;
    // The measured window, after the warm-up.
    readonly seconds: number;
    // The picture the viewer decoded, in pixels.
    readonly picture: { readonly width: number; readonly height: number } | null;
    // CPU cores: the encoder (ffmpeg, every one the run started; or castd), the X server, and the workload's Chromium.
    readonly encoderCores: number | null;
    readonly xvfbCores: number | null;
    readonly chromiumCores: number | null;
    // Video frames decoded per second: what the wire carried, changed or not.
    readonly framesPerSec: number | null;
    // Frames per second that showed a marker not seen before: what a person sees move.
    readonly uniqueFps: RateSummary;
    readonly mbps: number | null;
    // Content drawn → decoded, read off the marker: the whole path a picture takes.
    readonly latencyMs: Summary;
    // Content drawn → on the X display, read off the framebuffer: Chromium's own share, before any pipeline sees it.
    readonly displayMs: Summary;
    // On the X display → decoded: the pipeline's share (capture, encode, wire, decode).
    readonly pipelineMs: Summary;
    // Gaps of more than STALL_MS between new pictures while the page kept drawing, and the longest gap.
    readonly stalls: number | null;
    readonly maxGapMs: number | null;
    // A keystroke sent → its glyph decoded; → the page receiving it; a 10,000-character paste sent → all of it decoded.
    readonly keyMs: Summary;
    readonly keyInputMs: Summary;
    readonly pasteMs: Summary;
    // Keystrokes and pastes whose echo never came within their deadline.
    readonly inputMissed: number;
    // Decoded frames whose marker failed its check (a torn capture), decoder errors, keyframes, and encoder starts (one
    // per connection, plus one per keyframe restart).
    readonly markerErrors: number;
    readonly decodeErrors: number;
    readonly keyframes: number;
    readonly encoderStarts: number | null;
    // Which way castd's stream reached the viewer: its socket, or a peer connection (`--peer`). Absent from a run
    // recorded before peers existed, which was the socket.
    readonly carrier?: "socket" | "peer";
}

export interface RunHost {
    readonly cpu: string;
    readonly cores: number;
    readonly kernel: string;
    readonly chromium: string;
    readonly ffmpeg: string;
}

export interface RunFile {
    readonly recordedAt: string;
    readonly host: RunHost;
    // The machine's 1-, 5- and 15-minute load averages as the matrix began and ended: a timing taken on a busy shared
    // machine says so here rather than passing for a calm one.
    readonly load: { readonly before: readonly number[]; readonly after: readonly number[] };
    // The flags the matrix ran with, so a later run can repeat them; a null queue is the unbounded one.
    readonly settings: { readonly seconds: number; readonly warmupSeconds: number; readonly queueMs: number | null; readonly size: string; readonly stage: string };
    readonly runs: readonly RunResult[];
}
