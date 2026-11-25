import type { ScannedProcess } from "../process-scan.js";
import { unqueuedBytes, watchUnqueuedPeaks } from "./unqueued-peaks.js";

/* WHAT AN AGENT'S LINE TOOK OUTSIDE THE QUEUE (2026-11-25, the shinobi-society audit): per runner, the resident memory
   and swap of its session's processes the queue does not already cover, at its peak, recorded under the line's signature
   once the runner goes, when that peak was a gibibyte or more. Every process is staged as the shared scan reports it. */

const GIB = 1024 ** 3;
const PAGE = 4096;
const GEN = "/tmp/intentic-run-Gen1";
const BUILD = "/tmp/intentic-run-Bld2";
const SIGNATURE = { key: "learned @shinobi-society: python3 tools/gen.py", command: "python3 tools/gen.py" };

const proc = (pid: number, gib: number, extra: Partial<ScannedProcess> = {}): ScannedProcess => ({
    pid,
    comm: "x",
    ppid: 1,
    pgrp: pid,
    owner: undefined,
    role: "other",
    program: undefined,
    rssPages: Math.round((gib * GIB) / PAGE),
    ...extra,
});

const harness = (texts: Record<string, string> = {}) => {
    const recorded: [string, string, number][] = [];
    let scanned: ScannedProcess[] = [];
    const watch = watchUnqueuedPeaks({
        record: async (key, command, peakBytes) => {
            recorded.push([key, command, peakBytes]);
        },
        scan: async () => scanned,
        readText: async (path) => texts[path],
        pageBytes: async () => PAGE,
        sampleMs: 0,
    });
    const look = async (now: ScannedProcess[]): Promise<void> => {
        scanned = now;
        await watch.look();
    };
    return { recorded, look, texts };
};

test("a runner's unqueued processes are summed with their swap, and those the queue covers are left out", async () => {
    const status = new Map([["/proc/11/status", "Name:\tpython3\nVmSwap:\t  524288 kB\n"]]);
    const bytes = await unqueuedBytes(
        [
            proc(10, 0.01, { runDir: GEN }),
            proc(11, 2, { runDir: GEN }),
            // cargo and its rustc, under a slot: priced and measured by the queue already.
            proc(12, 6, { runDir: GEN, queued: true }),
            proc(20, 1.5, { runDir: BUILD, queued: true }),
            proc(30, 9),
        ],
        async (path) => status.get(path),
        PAGE,
    );
    expect([...bytes]).toEqual([
        [GEN, Math.round((0.01 * GIB) / PAGE) * PAGE + 2 * GIB + 0.5 * GIB],
        [BUILD, 0],
    ]);
});

test("a heavy line's peak is recorded once its runner goes, under the signature beside it", async () => {
    const { recorded, look, texts } = harness();
    texts[`${GEN}/signature`] = JSON.stringify(SIGNATURE);
    await look([proc(10, 0.01, { runDir: GEN }), proc(11, 1, { runDir: GEN })]);
    await look([proc(10, 0.01, { runDir: GEN }), proc(11, 3.5, { runDir: GEN })]);
    // Its dir is removed as the command ends; the signature was read while it ran.
    delete texts[`${GEN}/signature`];
    await look([proc(10, 0.01, { runDir: GEN }), proc(11, 0.5, { runDir: GEN })]);
    expect(recorded).toEqual([]);
    await look([]);
    expect(recorded).toEqual([[SIGNATURE.key, SIGNATURE.command, Math.round((0.01 * GIB) / PAGE) * PAGE + 3.5 * GIB]]);
    // Recorded once.
    await look([]);
    expect(recorded).toHaveLength(1);
});

test("a light line, a covered one and one with no signature record nothing", async () => {
    const { recorded, look, texts } = harness();
    texts[`${GEN}/signature`] = JSON.stringify(SIGNATURE);
    texts[`${BUILD}/signature`] = JSON.stringify({ key: "learned @x: cargo build", command: "cargo build" });
    await look([proc(11, 0.9, { runDir: GEN }), proc(20, 8, { runDir: BUILD, queued: true }), proc(30, 4, { runDir: "/tmp/intentic-run-NoSig" })]);
    await look([]);
    expect(recorded).toEqual([]);
});

test("a signature that does not parse names no line", async () => {
    const { recorded, look, texts } = harness();
    texts[`${GEN}/signature`] = "{not json";
    await look([proc(11, 4, { runDir: GEN })]);
    await look([]);
    expect(recorded).toEqual([]);
});

test("a peak that cannot be written, or a scan that fails, is a look that measured nothing", async () => {
    let fail = true;
    const watch = watchUnqueuedPeaks({
        record: () => Promise.reject(new Error("disk full")),
        scan: async () => {
            if (fail) {
                throw new Error("procfs gone");
            }
            return [];
        },
        readText: async () => JSON.stringify(SIGNATURE),
        pageBytes: async () => PAGE,
        sampleMs: 0,
    });
    await expect(watch.look()).resolves.toBeUndefined();
    fail = false;
    await expect(watch.look()).resolves.toBeUndefined();
    watch.stop();
});
