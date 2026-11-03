// MEASURING FRAMES ON THE GPU THAT REALLY RENDERS THE PAGE (2026-11-03). The shinobi sandbox's agents measured a
// WebGPU game inside WSL with software rendering (6-11 s a frame, "ready after 176 s") and could not see a bug that
// showed only on the owner's NVIDIA card through Chrome's D3D12 backend. This runs in the page of the owner's own
// browser: it waits for an optional condition, times N animation frames, and names the adapter and the WebGL renderer,
// so the numbers say which GPU they came from.

export interface FramesOptions {
    // Frames to time (the answer holds count intervals, so count + 1 animation frames).
    readonly count: number;
    // A JavaScript expression polled once a frame before measuring; measuring starts when it is truthy. Undefined: at once.
    readonly until: string | undefined;
    // How long `until` may take to come true.
    readonly waitMs: number;
    // How long the timing itself may take: a page at 2 fps does not hold the call for a minute per hundred frames.
    readonly measureMs: number;
}

// What the page's half answers, before any arithmetic.
export interface RawFrames {
    // Milliseconds between consecutive animation frames, in order.
    readonly intervals: readonly number[];
    // Whether `until` came true (true when there was none), and how long the page waited on it.
    readonly ready: boolean;
    readonly waitedMs: number;
    // What `until` threw the last time it was asked, when it threw.
    readonly untilError?: string;
    // No frame came for STALL_MS: the tab is hidden, or the page's main thread is stuck.
    readonly stalled: boolean;
    readonly visibility: string;
    readonly focused: boolean;
    readonly devicePixelRatio: number;
    readonly viewport: readonly [number, number];
    readonly gpu: GpuInfo;
}

// A GPU interface the page did not get, and why.
export interface GpuMissing {
    readonly found: false;
    readonly why: string;
}

export interface GpuInfo {
    // WebGPU's default adapter, or why there is none.
    readonly webgpu:
        | { readonly found: true; readonly vendor: string; readonly architecture: string; readonly device: string; readonly description: string; readonly fallback: boolean }
        | GpuMissing;
    // WebGL's unmasked renderer (on Windows, ANGLE names the backend: "Direct3D11", "D3D12", "Vulkan"), or why there is none.
    readonly webgl: { readonly found: true; readonly vendor: string; readonly renderer: string } | GpuMissing;
}

// A frame not arriving for this long ends the timing: rAF does not run in a hidden tab at all.
export const STALL_MS = 5000;

// The page's half: one async expression, every input inlined. `until` is the agent's own expression, placed in a function
// body so a syntax error in it is reported by the browser as the call's failure, before anything is measured.
export const framesScript = (options: FramesOptions): string => `(async function () {
  var until = ${options.until === undefined || options.until.trim() === "" ? "null" : `async function () { return (${options.until}); }`};
  var count = ${Math.floor(options.count)}, waitMs = ${Math.floor(options.waitMs)}, measureMs = ${Math.floor(options.measureMs)}, stallMs = ${STALL_MS};
  function frame() {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(null); }, stallMs);
      requestAnimationFrame(function (at) { clearTimeout(timer); resolve(at); });
    });
  }
  var started = performance.now(), ready = until === null, untilError, stalled = false;
  while (!ready && performance.now() - started < waitMs) {
    try { ready = Boolean(await until()); untilError = undefined; } catch (error) { untilError = String(error && error.stack || error); }
    if (!ready && (await frame()) === null) { stalled = true; break; }
  }
  var waitedMs = Math.round(performance.now() - started), intervals = [];
  if (ready && !stalled) {
    var previous = await frame(), measuring = performance.now();
    while (previous !== null && intervals.length < count && performance.now() - measuring < measureMs) {
      var at = await frame();
      if (at === null) { stalled = true; break; }
      intervals.push(Math.round((at - previous) * 100) / 100);
      previous = at;
    }
    if (previous === null) stalled = true;
  }
  var gpu = {};
  function missing(why) { return { found: false, why: why }; }
  try {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      var info = gl.getExtension('WEBGL_debug_renderer_info');
      gpu.webgl = info
        ? { found: true, vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) }
        : { found: true, vendor: String(gl.getParameter(gl.VENDOR)), renderer: String(gl.getParameter(gl.RENDERER)) };
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } else {
      gpu.webgl = missing('no WebGL context: the browser has WebGL off or blocklisted this GPU');
    }
  } catch (error) { gpu.webgl = missing('WebGL failed: ' + String(error)); }
  if (!navigator.gpu) {
    gpu.webgpu = missing(isSecureContext ? 'navigator.gpu is missing: this browser offers no WebGPU' : 'navigator.gpu is missing: the page is not a secure context (use http://localhost or https)');
  } else {
    try {
      var adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        gpu.webgpu = missing('requestAdapter() answered null: no usable GPU adapter');
      } else {
        var a = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
        gpu.webgpu = { found: true, vendor: String(a.vendor || ''), architecture: String(a.architecture || ''), device: String(a.device || ''), description: String(a.description || ''), fallback: Boolean(adapter.isFallbackAdapter || a.isFallbackAdapter) };
      }
    } catch (error) { gpu.webgpu = missing('requestAdapter() failed: ' + String(error)); }
  }
  return {
    intervals: intervals, ready: ready, waitedMs: waitedMs, untilError: untilError, stalled: stalled,
    visibility: document.visibilityState, focused: document.hasFocus(), devicePixelRatio: devicePixelRatio,
    viewport: [innerWidth, innerHeight], gpu: gpu
  };
})()`;

export interface FrameStats {
    readonly frames: number;
    // Frame times in milliseconds: the median, the 95th percentile (one frame in twenty is slower), the worst.
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly meanFps: number;
    // Frames that took more than twice the median: the hitches a player feels.
    readonly hitches: number;
}

// The nearest-rank percentile of sorted values.
const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;

const round = (value: number): number => Math.round(value * 10) / 10;

export const frameStats = (intervals: readonly number[]): FrameStats | undefined => {
    if (intervals.length === 0) {
        return undefined;
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const total = intervals.reduce((sum, ms) => sum + ms, 0);
    return {
        frames: intervals.length,
        p50Ms: round(p50),
        p95Ms: round(percentile(sorted, 95)),
        maxMs: round(sorted.at(-1) ?? 0),
        meanFps: total === 0 ? 0 : round((1000 * intervals.length) / total),
        hitches: intervals.filter((ms) => ms > 2 * p50).length,
    };
};
