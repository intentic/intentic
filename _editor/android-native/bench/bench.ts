// The spike's yardstick: the same scenarios on every arm, on one phone, read the same way. A cold start (the system's
// own TotalTime, and the arm's SPIKE_READY: process start to a frame with rows), a fling through the long chat and a
// turn streamed under it (frames SurfaceFlinger presented for the arm's layer, and the CPU its processes used).
//
//   node _editor/android-native/bench/bench.ts --serial <adb serial> [--arms web,views,surface,flutter,compose]
//       [--scenarios start,fling,stream] [--runs 5] [--moving-runs 3] [--rows 2000] [--stream-ms 10000] [--rebuild-web]
//       [--no-compile] [--out DIR]
//
// Install the arms first (README.md, Commands). Results print as tables and land in --out (default: the system temp
// directory's intentic-android-spike/) as results-<time>.json, beside the traces and the web build.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { repoRoot } from "../../../_tools/constants/src/node.mjs";
import { Device } from "./device.ts";
import { type FrameStats, frameStats, type Latency, lostBetweenPolls, median, mergePresents } from "./frames.ts";
import { type CpuUse, cpuUse, schedConfig } from "./trace.ts";
import { serveWeb } from "./web.ts";

interface Arm {
    readonly name: string;
    readonly component: string;
    readonly about: string;
}

const ARMS: readonly Arm[] = [
    { name: `web`, component: `dev.intentic.spike/.WebConversationActivity`, about: `today's web editor in a WebView` },
    { name: `views`, component: `dev.intentic.spike/.ConversationActivity`, about: `Kotlin views, Rust core` },
    { name: `surface`, component: `dev.intentic.spike/.SurfaceConversationActivity`, about: `Rust draws the transcript (wgpu)` },
    { name: `flutter`, component: `dev.intentic.spike.flutter/.MainActivity`, about: `Flutter, Impeller` },
    { name: `compose`, component: `dev.intentic.spike.compose/.MainActivity`, about: `plain Kotlin: Compose and a Kotlin markdown library` },
];

const WEB_PORT = 8790;
const SETTLE_MS = 2500;
const STREAM_DELAY_MS = 3000;
// A frame is late in a stream only past the longest stretch the turn itself leaves with nothing to draw (frames.ts).
const STREAM_LATE_AFTER = 4.5;

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};

const pickSerial = (): string => {
    const asked = option(`serial`) ?? process.env[`ANDROID_SERIAL`];
    if (asked !== undefined) {
        return asked;
    }
    const attached = execFileSync(process.env[`ADB`] ?? `adb`, [`devices`], { encoding: `utf8` })
        .split(/\r?\n/u)
        .slice(1)
        .filter((line) => line.endsWith('	device'))
        .map((line) => line.split(`\t`)[0] ?? ``);
    if (attached.length !== 1) {
        throw new Error(`${attached.length} devices attached: name one with --serial`);
    }
    return attached[0] ?? ``;
};

const device = new Device(pickSerial());
device.followLog();
const runs = Number(option(`runs`) ?? `5`);
const rows = Number(option(`rows`) ?? `2000`);
const streamMs = Number(option(`stream-ms`) ?? `10000`);
const arms = ARMS.filter((arm) => (option(`arms`) ?? ARMS.map((known) => known.name).join(`,`)).split(`,`).includes(arm.name));
const scenarios = (option(`scenarios`) ?? `start,fling,stream`).split(`,`);
// Traces, the web build and results go outside the repository: a run leaves nothing in the tree.
const out = option(`out`) ?? join(tmpdir(), `intentic-android-spike`);
mkdirSync(out, { recursive: true });

const [width, height] = (device.shell(`wm size`).match(/(\d+)x(\d+)/u) ?? []).slice(1).map(Number);
const screen = { width: width ?? 1080, height: height ?? 2280 };
const about = {
    model: device.shell(`getprop ro.product.model`).trim(),
    android: device.shell(`getprop ro.build.version.release`).trim(),
    webview: device.shell(`dumpsys webviewupdate`).match(/Current WebView package \(name, version\): \(([^)]*)\)/u)?.[1] ?? `?`,
    screen,
};
process.stdout.write(`${about.model}, Android ${about.android}, ${screen.width}x${screen.height}, WebView ${about.webview}\n`);

const packages = new Set(arms.map((arm) => arm.component.split(`/`)[0] ?? ``));
const installed = device.shell(`pm list packages`);
for (const pkg of packages) {
    if (!installed.includes(`package:${pkg}\n`) && !installed.endsWith(`package:${pkg}`)) {
        throw new Error(`${pkg} is not installed on ${device.serial}: see README.md, Commands`);
    }
    // Compiled ahead of time, as an install with a baseline profile is after its first runs: no arm is timed in its JIT.
    if (!args.includes(`--no-compile`)) {
        device.shell(`cmd package compile -m speed -f ${pkg}`);
    }
}

const server = arms.some((arm) => arm.name === `web`) ? await serveWeb(repoRoot(import.meta.url), out, args.includes(`--rebuild-web`)) : undefined;
if (server !== undefined) {
    device.adb([`reverse`, `tcp:${WEB_PORT}`, `tcp:${new URL(server.origin).port}`]);
}

const launch = async (arm: Arm, extras: string): Promise<{ since: number; totalTime: number; readyMs: number }> => {
    // A screen that went dark between runs would start the activity behind the lock screen: wake it first (a no-op
    // when it is on).
    device.shell(`input keyevent KEYCODE_WAKEUP`);
    const since = device.now();
    const started = device.shell(`am start -S -W -n ${arm.component} --ei rows ${rows} ${extras}`);
    const ready = await device.waitFor(new RegExp(`SPIKE_READY arm=${arm.name}\\b.* ms=(\\d+)`, `u`), since, 90_000);
    if (ready === undefined) {
        throw new Error(`${arm.name} never logged SPIKE_READY:\n${started}`);
    }
    return { since, totalTime: Number(started.match(/TotalTime: (\d+)/u)?.[1] ?? Number.NaN), readyMs: Number(ready[1]) };
};

interface Moving {
    readonly frames: FrameStats;
    readonly cpu: CpuUse;
}

interface Start {
    readonly totalTimeMs: number;
    readonly readyMs: number;
    readonly runs: readonly { readonly totalTime: number; readonly readyMs: number }[];
}

interface ArmResult {
    start?: Start;
    fling?: Moving;
    stream?: Moving;
}

const measureWhile = async (arm: Arm, name: string, traceMs: number, act: () => Promise<void>, windowMs?: number, lateAfter?: number): Promise<Moving> => {
    const layers = device.layersOf(arm.component);
    if (layers.length === 0) {
        throw new Error(`no layer for ${arm.component}`);
    }
    const trace = device.trace(schedConfig(traceMs), out, `${arm.name}-${name}`);
    const polls = device.pollLatency(layers, trace);
    await act();
    const [path, byLayer] = await Promise.all([trace, polls]);
    // The first poll answers what the layer presented before the scenario began (the start, the settle): left out.
    const began = (latencies: readonly Latency[]): number => Math.max(0, ...(latencies[0]?.presents ?? [])) + 1;
    const fromNs = (presents: readonly number[], latencies: readonly Latency[]): number =>
        Math.max(began(latencies), windowMs === undefined ? 0 : (presents.at(-1) ?? 0) - windowMs * 1e6);
    // The layer that presented most while the scenario ran is the one that moved.
    const measured = [...byLayer.values()]
        .map((latencies) => {
            const presents = mergePresents(latencies);
            const from = fromNs(presents, latencies);
            return { latencies, presents, from, count: presents.filter((at) => at >= from).length };
        })
        .reduce((best, one) => (one.count > best.count ? one : best));
    const lost = lostBetweenPolls(measured.latencies);
    if (lost > 0) {
        process.stdout.write(`warning: ${arm.name} ${name}: frames may have gone unseen between ${lost} pairs of polls\n`);
    }
    return {
        frames: frameStats(measured.presents, measured.latencies[0]?.refreshNs ?? 16_666_667, { fromNs: measured.from, lateAfter: lateAfter ?? 1.5 }),
        cpu: cpuUse(out, path, arm.component.split(`/`)[0] ?? ``, windowMs === undefined ? traceMs : windowMs + 1500, arm.name === `web`),
    };
};

// One run of one scenario on one arm. Runs go round the arms, starting one arm later each round, so a phone warming
// up over the session (its battery temperature is recorded) does not land on whichever arm comes last.
const flingOnce = async (arm: Arm): Promise<Moving> => {
    await launch(arm, ``);
    await sleep(SETTLE_MS);
    const swipes = 8;
    const gapMs = 700;
    return measureWhile(arm, `fling`, swipes * gapMs + 1500, async () => {
        await sleep(500);
        for (let swipe = 0; swipe < swipes; swipe += 1) {
            const x = Math.round(screen.width / 2);
            device.shell(`input swipe ${x} ${Math.round(screen.height * 0.3)} ${x} ${Math.round(screen.height * 0.8)} 60`);
            await sleep(gapMs);
        }
    });
};

const streamOnce = async (arm: Arm): Promise<Moving> => {
    const { since } = await launch(arm, `--ez stream true --ei streamDelayMs ${STREAM_DELAY_MS} --ei streamMs ${streamMs}`);
    return measureWhile(
        arm,
        `stream`,
        STREAM_DELAY_MS + streamMs + 1500,
        async () => {
            const done = await device.waitFor(new RegExp(`SPIKE_STREAM_DONE arm=${arm.name}\\b`, `u`), since, STREAM_DELAY_MS + streamMs + 30_000);
            if (done === undefined) {
                throw new Error(`${arm.name} never logged SPIKE_STREAM_DONE`);
            }
        },
        streamMs,
        STREAM_LATE_AFTER,
    );
};

/** Each figure is the median over runs; the busiest threads are those of the run whose CPU time is the median. */
const medianMoving = (moving: readonly Moving[]): Moving => {
    const of = (pick: (one: Moving) => number): number => median(moving.map(pick));
    const cpuMs = of((one) => one.cpu.totalMs);
    const middle = moving.toSorted((a, b) => Math.abs(a.cpu.totalMs - cpuMs) - Math.abs(b.cpu.totalMs - cpuMs))[0];
    return {
        frames: {
            frames: of((one) => one.frames.frames),
            fps: of((one) => one.frames.fps),
            p50Ms: of((one) => one.frames.p50Ms),
            p95Ms: of((one) => one.frames.p95Ms),
            p99Ms: of((one) => one.frames.p99Ms),
            maxMs: of((one) => one.frames.maxMs),
            janky: of((one) => one.frames.janky),
            jankPct: of((one) => one.frames.jankPct),
            maxAtMs: of((one) => one.frames.maxAtMs),
        },
        cpu: { totalMs: cpuMs, corePct: of((one) => one.cpu.corePct), threads: middle?.cpu.threads ?? [] },
    };
};

const temperature = (): number => Number(device.shell(`dumpsys battery`).match(/temperature: (\d+)/u)?.[1] ?? Number.NaN) / 10;
const temperatures: number[] = [temperature()];
const movingRuns = Number(option(`moving-runs`) ?? `3`);
const starts = new Map<string, { totalTime: number; readyMs: number }[]>();
const flings = new Map<string, Moving[]>();
const streams = new Map<string, Moving[]>();
const rounds = async (count: number, each: (arm: Arm, run: number) => Promise<void>): Promise<void> => {
    for (let run = 0; run < count; run += 1) {
        for (let at = 0; at < arms.length; at += 1) {
            const arm = arms[(at + run) % arms.length];
            if (arm !== undefined) {
                await each(arm, run);
                device.shell(`am force-stop ${arm.component.split(`/`)[0]}`);
            }
        }
    }
    temperatures.push(temperature());
};

try {
    if (scenarios.includes(`start`)) {
        await rounds(runs, async (arm, run) => {
            const { totalTime, readyMs } = await launch(arm, ``);
            starts.set(arm.name, [...(starts.get(arm.name) ?? []), { totalTime, readyMs }]);
            process.stdout.write(`start ${run + 1}/${runs} ${arm.name}: TotalTime ${totalTime}, rows drawn ${readyMs}\n`);
            await sleep(SETTLE_MS);
        });
    }
    if (scenarios.includes(`fling`)) {
        await rounds(movingRuns, async (arm, run) => {
            const one = await flingOnce(arm);
            flings.set(arm.name, [...(flings.get(arm.name) ?? []), one]);
            process.stdout.write(`fling ${run + 1}/${movingRuns} ${arm.name}: ${JSON.stringify(one)}\n`);
        });
    }
    if (scenarios.includes(`stream`)) {
        await rounds(movingRuns, async (arm, run) => {
            const one = await streamOnce(arm);
            streams.set(arm.name, [...(streams.get(arm.name) ?? []), one]);
            process.stdout.write(`stream ${run + 1}/${movingRuns} ${arm.name}: ${JSON.stringify(one)}\n`);
        });
    }
} finally {
    device.close();
    await server?.close();
    if (server !== undefined) {
        device.adb([`reverse`, `--remove`, `tcp:${WEB_PORT}`]);
    }
}

const results = new Map<string, ArmResult>(
    arms.map((arm) => {
        const result: ArmResult = {};
        const armStarts = starts.get(arm.name);
        if (armStarts !== undefined) {
            result.start = { totalTimeMs: median(armStarts.map((one) => one.totalTime)), readyMs: median(armStarts.map((one) => one.readyMs)), runs: armStarts };
        }
        const armFlings = flings.get(arm.name);
        if (armFlings !== undefined) {
            result.fling = medianMoving(armFlings);
        }
        const armStreams = streams.get(arm.name);
        if (armStreams !== undefined) {
            result.stream = medianMoving(armStreams);
        }
        return [arm.name, result];
    }),
);

const file = join(out, `results-${new Date().toISOString().replaceAll(`:`, `-`)}.json`);
writeFileSync(
    file,
    `${JSON.stringify({ about, rows, runs, movingRuns, streamMs, temperatures, results: Object.fromEntries(results), raw: { flings: Object.fromEntries(flings), streams: Object.fromEntries(streams) } }, null, 2)}\n`,
);

const table = (title: string, header: readonly string[], line: (result: ArmResult) => readonly (number | string)[] | undefined): void => {
    const lines = arms.flatMap((arm) => {
        const cells = line(results.get(arm.name) ?? {});
        return cells === undefined ? [] : [`| ${arm.name} | ${cells.join(` | `)} |`];
    });
    if (lines.length > 0) {
        process.stdout.write(`\n${title}\n\n| arm | ${header.join(` | `)} |\n|${` --- |`.repeat(header.length + 1)}\n${lines.join(`\n`)}\n`);
    }
};
table(`Cold start (median of ${runs}, ms)`, [`TotalTime`, `rows drawn`], ({ start }) => (start === undefined ? undefined : [start.totalTimeMs, start.readyMs]));
const movingRow = (moving: Moving | undefined): readonly (number | string)[] | undefined => {
    if (moving === undefined) {
        return undefined;
    }
    const { frames, cpu } = moving;
    return [frames.frames, frames.fps, frames.p95Ms, frames.p99Ms, frames.maxMs, frames.jankPct, cpu.totalMs, cpu.corePct, cpu.threads.join(`, `)];
};
const MOVING_HEADER = [`frames`, `fps`, `p95 ms`, `p99 ms`, `max ms`, `late %`, `CPU ms`, `core %`, `busiest threads`];
process.stdout.write(`\nbattery temperature by scenario: ${temperatures.join(` → `)} °C\n`);
table(`Fling (median of ${movingRuns}): frames presented and CPU used`, MOVING_HEADER, ({ fling }) => movingRow(fling));
table(`Stream (median of ${movingRuns}): frames presented and CPU used`, MOVING_HEADER, ({ stream }) => movingRow(stream));
process.stdout.write(`\n${file}\n`);
