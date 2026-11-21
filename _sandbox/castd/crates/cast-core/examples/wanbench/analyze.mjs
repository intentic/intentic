// Reads wanbench reports (run.sh's --out files) and prints one line per run: capture-to-glass latency percentiles,
// pictures shown a second, freezes (a gap over 200 ms between two pictures shown, the content moving all along) per
// minute, keyframes the server sent, and what it sent against the cap in each step of the cap schedule.
//
//   node analyze.mjs report.json... [--json]
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith(`--`));
const asJson = process.argv.includes(`--json`);

const pct = (sorted, p) => (sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]);
const mean = (v) => (v.length === 0 ? Number.NaN : v.reduce((a, b) => a + b, 0) / v.length);
const r = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// Gaps over 200 ms between two pictures shown, the run's start and end included, and the time they took.
const freezeStats = (times, seconds) => {
  const edges = [0, ...times, seconds * 1000];
  const gaps = edges.slice(1).map((t, i) => t - edges[i]).filter((gap) => gap > 200);
  return { count: gaps.length, ms: gaps.reduce((a, b) => a + b, 0) };
};

// Each step of the cap schedule, its first two seconds left out of the rates (the controller's reaction shows in the
// step's latency instead).
const capSteps = (report, frames, seconds) => {
  const caps = report.caps ?? [];
  const server = report.server ?? [];
  return caps.map((cap, i) => {
    const end = caps[i + 1]?.at ?? seconds;
    const inStep = server.filter((s) => s.t >= cap.at + 2 && s.t < end);
    const shown = frames
      .filter((f) => f[2] / 1000 >= cap.at && f[2] / 1000 < end)
      .map((f) => f[1])
      .sort((a, b) => a - b);
    return {
      capKbps: cap.kbps,
      sentKbps: r(mean(inStep.map((s) => s.sent_kbps))),
      targetKbps: r(mean(inStep.map((s) => s.target_kbps))),
      p50: r(pct(shown, 0.5), 1),
      p95: r(pct(shown, 0.95), 1),
    };
  });
};

// What the browser's own WebRTC said over the measurement (the track), or the page's decoder (the channel).
const browserStats = (page) => {
  if (!page.track) {
    return { decodeErrors: page.dc.decodeErrors, keyAsks: page.dc.keyAsks };
  }
  const s0 = page.statsStart ?? {};
  const s1 = page.statsEnd ?? {};
  const delta = (key) => (s1[key] ?? 0) - (s0[key] ?? 0);
  return {
    nacks: delta(`nackCount`),
    plis: delta(`pliCount`),
    lost: delta(`packetsLost`),
    freezes: delta(`freezeCount`),
    dropped: delta(`framesDropped`),
    jitterBufferMs: r((1000 * delta(`jitterBufferDelay`)) / Math.max(1, delta(`jitterBufferEmittedCount`)), 1),
    decoder: s1.decoderImplementation,
  };
};

const analyze = (file) => {
  const report = JSON.parse(readFileSync(file, `utf8`));
  const page = report.page;
  const frames = page.frames.filter((f) => Number.isFinite(f[1]));
  const seconds = page.seconds;
  const lat = frames.map((f) => f[1]).sort((a, b) => a - b);
  const freezes = freezeStats(frames.map((f) => f[2]).sort((a, b) => a - b), seconds);
  const server = report.server ?? [];
  return {
    file: file.split(`/`).at(-1),
    mode: page.track ? `track` : `dc`,
    shown: frames.length,
    fps: r(frames.length / seconds, 1),
    p50: r(pct(lat, 0.5), 1),
    p95: r(pct(lat, 0.95), 1),
    p99: r(pct(lat, 0.99), 1),
    freezesPerMin: r((freezes.count * 60) / seconds, 1),
    frozenPct: r((100 * freezes.ms) / (seconds * 1000), 1),
    keyframes: server.length > 0 ? server.at(-1).keyframes - server[0].keyframes : null,
    sentKbps: r(mean(server.map((s) => s.sent_kbps))),
    // How much of the run the track's packets went out twice, and the loss the policy read (the last it read).
    copies: r(mean(server.filter((s) => s.copies != null).map((s) => Number(s.copies))), 2),
    lossPct: r(100 * (server.findLast((s) => s.loss != null)?.loss ?? Number.NaN), 2),
    steps: capSteps(report, frames, seconds),
    browser: browserStats(page),
  };
};

const rows = files.map(analyze);
if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) {
    const steps = row.steps.map((s) => `${s.capKbps}:${s.sentKbps}/${s.targetKbps} (${s.p50}/${s.p95})`).join(` `);
    console.log(
      `${row.file.padEnd(28)} ${row.mode.padEnd(5)} p50 ${row.p50} p95 ${row.p95} p99 ${row.p99} ms | ${row.fps} fps | freezes ${row.freezesPerMin}/min (${row.frozenPct}% frozen) | key ${row.keyframes} | sent ${row.sentKbps} kbps | copies ${row.copies} (loss ${row.lossPct}%) | ${steps} | ${JSON.stringify(row.browser)}`,
    );
  }
}
