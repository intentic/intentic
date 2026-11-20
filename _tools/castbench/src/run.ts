import { sleep } from "@intentic/base/async";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type Browser, chromium, type Page } from "playwright";
import { analyze } from "./analysis.js";
import { type CastdOptions, startCastd } from "./castd.js";
import type { DecoderConfig, DecoderLog, TypingPlan } from "./client/decoder.js";
import { loadDaemon } from "./daemon.js";
import { type DisplayProbe, probeDisplay } from "./framebuffer.js";
import { type PipelineServer, startLegacy } from "./legacy.js";
import type { Link } from "./link.js";
import { startPageServer } from "./pages.js";
import { processTree, snapshotTicks, ticksBetween } from "./proc.js";
import type { RunFile, RunHost, RunResult } from "./results.js";
import { startRelay } from "./shaper.js";
import { type StageKind, startStage } from "./stage.js";
import { coresOf, round1 } from "./stats.js";

// One matrix: every workload over every link through one pipeline, on one stage and one viewer browser, each run a fresh
// page, a fresh connection (so a fresh encoder, as every viewer of today's pipeline gets) and a fresh relay.

export const WORKLOADS = ["still", "anim", "scroll", "typing", "flood"] as const;
export type Workload = (typeof WORKLOADS)[number];

// What moves on its own and so is judged for unique frames and stalls.
const MOVING: ReadonlySet<Workload> = new Set<Workload>(["anim", "scroll", "flood"]);

export interface MatrixOptions {
    readonly pipeline: "legacy" | "castd";
    readonly workloads: readonly Workload[];
    readonly links: readonly Link[];
    readonly seconds: number;
    readonly warmupSeconds: number;
    readonly queueMs: number;
    readonly size: { readonly width: number; readonly height: number };
    readonly stage: StageKind;
    readonly chromium: string;
    readonly probe: boolean;
    readonly castd?: CastdOptions;
    // Move each castd stream onto a peer connection when castd offers one (its command needs `--rtc-udp`), and measure
    // it there; the relay then carries only the socket's signalling.
    readonly peer?: boolean;
    // A directory each run's raw events are written to (the viewer's log, the probe's sightings, the window), for
    // finding where a number came from.
    readonly dump?: string | undefined;
    readonly log: (line: string) => void;
}

// The pastes a typing run ends on, and the time kept for them out of the window.
const PASTES = 3;
const PASTE_CHARS = 10_000;
const PASTE_RESERVE_S = 4;
// How long a fresh connection may take to show its first decoded frame before the run is called failed.
const FIRST_FRAME_MS = 15_000;
// How long a run asked for a peer waits for castd's hello on it.
const PEER_MS = 10_000;

// Wall-clock milliseconds at sub-millisecond resolution, on the same basis as the pages' own clock.
const clock = (): number => performance.timeOrigin + performance.now();

const hostOf = (browser: Browser): RunHost => {
    const model = /model name\s*:\s*(.+)/u.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1]?.trim() ?? "unknown";
    let ffmpeg = "unknown";
    try {
        ffmpeg = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0]?.replace(/ Copyright.*$/u, "") ?? ffmpeg;
    } catch {
        // allow(silent-catch): no ffmpeg is recorded as unknown; the legacy pipeline then fails on its own.
    }
    return { cpu: model, cores: cpus().length, kernel: release(), chromium: browser.version(), ffmpeg };
};

const openViewer = async (browser: Browser, origin: string): Promise<Page> => {
    const page = await browser.newPage();
    await page.goto(`${origin}/viewer`);
    await page.waitForFunction(() => globalThis.castbench !== undefined);
    return page;
};

const runOne = async (context: {
    readonly options: MatrixOptions;
    readonly workload: Workload;
    readonly link: Link;
    readonly pipeline: PipelineServer;
    readonly viewer: Browser;
    readonly origin: string;
    readonly probe: DisplayProbe | undefined;
    readonly xvfbPid: number;
    readonly chromiumPid: number | undefined;
}): Promise<RunResult> => {
    const { options, workload, link, pipeline } = context;
    const relay = await startRelay(pipeline.target, link, { queueMs: options.queueMs });
    const viewer = await openViewer(context.viewer, context.origin);
    const startsBefore = pipeline.starts();
    try {
        const config: DecoderConfig = { url: pipeline.url(relay.port), protocol: pipeline.protocol, peer: options.peer === true };
        await viewer.evaluate((given) => globalThis.castbench!.start(given), config);
        await viewer.waitForFunction(() => globalThis.castbench?.firstFrame() === true, undefined, { timeout: FIRST_FRAME_MS });
        if (options.peer === true) {
            // The window is measured on the peer, or, where castd offered none or it never opened, says it was not.
            // allow(silent-catch): a peer that never opened leaves the run on the socket, which `carrier` records.
            await viewer.waitForFunction(() => globalThis.castbench?.carrier() === "peer", undefined, { timeout: PEER_MS }).catch(() => undefined);
        }
        await sleep(options.warmupSeconds * 1000);
        context.probe?.reset();
        const browserPids = (): number[] => (context.chromiumPid === undefined ? [] : processTree(context.chromiumPid).map((stat) => stat.pid));
        const before = { encoder: snapshotTicks(pipeline.encoderPids()), xvfb: snapshotTicks([context.xvfbPid]), browser: snapshotTicks(browserPids()) };
        const from = clock();
        if (workload === "typing") {
            const plan: TypingPlan = { keysUntil: from + Math.max(1, options.seconds - PASTE_RESERVE_S) * 1000, pastes: PASTES, pasteChars: PASTE_CHARS };
            await viewer.evaluate((given) => globalThis.castbench!.typing(given), plan);
            await sleep(Math.max(0, from + options.seconds * 1000 - clock()));
        } else {
            await sleep(options.seconds * 1000);
        }
        const to = clock();
        const after = { encoder: snapshotTicks(pipeline.encoderPids()), xvfb: snapshotTicks([context.xvfbPid]), browser: snapshotTicks(browserPids()) };
        const seconds = (to - from) / 1000;
        // Today's encoders are this process's children, restarted for keyframes; castd is one long-lived process.
        const encoderTicks = ticksBetween(before.encoder, after.encoder, options.pipeline === "legacy");
        const xvfbTicks = ticksBetween(before.xvfb, after.xvfb, false);
        const browserTicks = ticksBetween(before.browser, after.browser, false);
        const firstSeen = context.probe === undefined ? undefined : new Map(context.probe.firstSeen());
        const log: DecoderLog = await viewer.evaluate(() => globalThis.castbench!.stop());
        if (options.dump !== undefined) {
            mkdirSync(options.dump, { recursive: true });
            const raw = { window: { from, to }, firstSeen: [...(firstSeen ?? new Map<number, number>())], log };
            writeFileSync(join(options.dump, `${options.pipeline}-${workload}-${link.name}.json`), JSON.stringify(raw));
        }
        const startsAfter = pipeline.starts();
        // A castd already running, with no pid given, is not ours to meter.
        const metered = options.pipeline === "legacy" || options.castd?.command !== undefined || options.castd?.pid !== undefined;
        return {
            pipeline: options.pipeline,
            workload,
            link: link.name,
            seconds: round1(seconds),
            encoderCores: metered ? coresOf(0, encoderTicks, seconds) : null,
            xvfbCores: coresOf(0, xvfbTicks, seconds),
            chromiumCores: context.chromiumPid === undefined ? null : coresOf(0, browserTicks, seconds),
            encoderStarts: startsBefore === null || startsAfter === null ? null : startsAfter - startsBefore,
            carrier: log.carrier,
            ...analyze(log, { from, to }, { moving: MOVING.has(workload), firstSeen }),
        };
    } finally {
        // allow(silent-catch): a viewer page already gone at the end of a run is the state asked for.
        await viewer.close().catch(() => undefined);
        await relay.close();
        // The encoder a connection started stops with it; the next run's meter must not catch this one's tail.
        const deadline = Date.now() + 3000;
        while (options.pipeline === "legacy" && pipeline.encoderPids().length > 0 && Date.now() < deadline) {
            await sleep(50);
        }
    }
};

const summaryLine = (result: RunResult): string =>
    [
        `${result.pipeline} ${result.workload} ${result.link}${result.carrier === "peer" ? " (peer)" : ""}:`,
        `encoder ${result.encoderCores ?? "—"} cores, Xvfb ${result.xvfbCores ?? "—"},`,
        `${result.framesPerSec ?? "—"} frames/s (${result.uniqueFps.mean ?? "—"} unique), ${result.mbps ?? "—"} Mbit/s,`,
        `drawn→decoded p50 ${result.latencyMs.p50 ?? "—"} p99 ${result.latencyMs.p99 ?? "—"} ms`,
        result.workload === "typing" ? `, key p50 ${result.keyMs.p50 ?? "—"} p99 ${result.keyMs.p99 ?? "—"} ms, paste ${result.pasteMs.max ?? "—"} ms` : "",
        result.stalls === null ? "" : `, ${result.stalls} stalls`,
    ].join(" ");

export const runMatrix = async (options: MatrixOptions): Promise<RunFile> => {
    const loadBefore = loadavg().map((value) => Math.round(value * 10) / 10);
    const daemon = await loadDaemon();
    const pages = await startPageServer();
    const cleanups: (() => Promise<void> | void)[] = [() => pages.close()];
    try {
        const stage = await startStage(daemon, { kind: options.stage, size: options.size, chromium: options.chromium, framebuffer: options.probe });
        cleanups.unshift(() => stage.close());
        options.log(`stage ${stage.display.name}: picture ${stage.region.width}x${stage.region.height} at ${stage.region.x},${stage.region.y}`);
        const pipeline =
            options.pipeline === "legacy" ? await startLegacy(daemon, stage) : await startCastd(options.castd ?? { session: "castbench" }, stage);
        cleanups.unshift(() => pipeline.close());
        const viewer = await chromium.launch({ headless: true, executablePath: options.chromium, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
        cleanups.unshift(() => viewer.close());
        const probe = stage.framebuffer === undefined ? undefined : probeDisplay(stage.framebuffer, stage.region, clock);
        if (probe !== undefined) {
            cleanups.unshift(() => probe.stop());
        }
        const runs: RunResult[] = [];
        for (const workload of options.workloads) {
            for (const link of options.links) {
                await stage.show(`${pages.origin}/workload/${workload}`);
                const result = await runOne({
                    options,
                    workload,
                    link,
                    pipeline,
                    viewer,
                    origin: pages.origin,
                    probe,
                    xvfbPid: stage.xvfbPid,
                    chromiumPid: stage.chromiumPid,
                });
                options.log(summaryLine(result));
                runs.push(result);
            }
        }
        return {
            recordedAt: new Date().toISOString(),
            host: hostOf(viewer),
            load: { before: loadBefore, after: loadavg().map((value) => Math.round(value * 10) / 10) },
            settings: {
                seconds: options.seconds,
                warmupSeconds: options.warmupSeconds,
                queueMs: Number.isFinite(options.queueMs) ? options.queueMs : null,
                size: `${options.size.width}x${options.size.height}`,
                stage: options.stage,
            },
            runs,
        };
    } finally {
        for (const cleanup of cleanups) {
            // allow(silent-catch): teardown goes on past a part already gone, so nothing a later part holds is left running.
            await Promise.resolve(cleanup()).catch(() => undefined);
        }
    }
};
