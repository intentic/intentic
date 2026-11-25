import { mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { learnedQueuePrefix, learnedSignatureOf, type LearnedPeaks } from "./learned-lines.js";

/* A LINE THAT GREW HEAVY OUTSIDE THE QUEUE QUEUES ITS NEXT RUN (2026-11-25, the shinobi-society audit): behind queue-run,
   in a pool of its own, the memory gate asked for its peak under the line's own key, with one line saying why. A line
   never learned, learned light, or anything that cannot be read runs as it would. */

const GIB = 1024 ** 3;
const QUEUE_RUN = "/usr/local/bin/queue-run";
const SIGNATURE = { key: "learned @shinobi-society: python3 tools/gen.py", command: "python3 tools/gen.py" };

const peaksOf = (peakBytes: number | undefined): LearnedPeaks => ({
    learned: async (key) => (key === SIGNATURE.key && peakBytes !== undefined ? { command: SIGNATURE.command, peakBytes, runs: 1 } : undefined),
});

const prefix = (peaks: LearnedPeaks | undefined, overrides: Partial<Parameters<typeof learnedQueuePrefix>[0]> = {}) =>
    learnedQueuePrefix({ peaks, signature: SIGNATURE, heavy: mergeHeavyRules(), queueRun: QUEUE_RUN, background: false, ...overrides });

test("a line learned at 3.5 GiB runs behind queue-run in the learned pool, asking the gate for its peak under its own key", async () => {
    const line = await prefix(peaksOf(3.5 * GIB));
    expect(line).toBe(
        [
            QUEUE_RUN,
            "--pool learned --limit 2 --wait 900 --memory-gate 120 --max-hold 0 --on-deadline run --label learned",
            "--size 3584m",
            `--key '${SIGNATURE.key}'`,
            `--command '${SIGNATURE.command}'`,
            "--note '`python3 tools/gen.py` peaked at 3.5 GiB on its last run, so it takes its turn with this sandbox'\\''s heavy commands, priced at 4.0 GiB.'",
            "-- ",
        ].join(" "),
    );
});

test("a background job takes a pool of its own, since it holds its slot as long as it runs", async () => {
    expect(await prefix(peaksOf(2 * GIB), { background: true })).toContain("--pool learned-jobs --limit 4 ");
});

test("a line never learned, or learned under a gibibyte, runs as it is", async () => {
    expect(await prefix(peaksOf(undefined))).toBe("");
    expect(await prefix(peaksOf(0.9 * GIB))).toBe("");
});

test("no queue, no table, no peaks, no signature, or peaks that cannot be read: the line runs as it is", async () => {
    const heavy = peaksOf(4 * GIB);
    expect(await prefix(heavy, { queueRun: undefined })).toBe("");
    expect(await prefix(heavy, { heavy: undefined })).toBe("");
    expect(await prefix(heavy, { heavy: mergeHeavyRules({ queue: false }) })).toBe("");
    expect(await prefix(undefined)).toBe("");
    expect(await prefix(heavy, { signature: undefined })).toBe("");
    expect(await prefix({ learned: () => Promise.reject(new Error("unreadable")) })).toBe("");
});

test("a line is named by its commands, and one that names none has no signature", () => {
    expect(learnedSignatureOf("cd /tmp && python3 gen.py | tail", undefined)).toEqual({ key: "learned @: python3 gen.py", command: "python3 gen.py" });
    expect(learnedSignatureOf("echo hi", "/tmp")).toBeUndefined();
});
