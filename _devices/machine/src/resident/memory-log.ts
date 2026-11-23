import { open, readdir, readFile, stat, appendFile } from "node:fs/promises";
import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";
import { sizeLabel } from "@intentic/base/format";
import { writeFileAtomic } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import type { Log } from "@intentic/local-agent";
import { MACHINE_VERSION } from "../version.js";

/* (2026-11-22) What the resident agent's own memory holds, written down every ten minutes so a question like "why does
   the agent hold 500 MB" can be answered from a day of readings rather than one look from outside. On rog the Windows
   agent held 520 MB of commit charge against under 100 MB in RAM; from outside, 374 MB of that was one block of the
   runtime's heap and 120 MB thread stacks, but not what filled the block. Each reading is what the process says of
   itself (process.memoryUsage: `rss` is the working set on Windows), the JavaScript heap as JavaScriptCore counts it
   with its most numerous kinds of object (bun:jsc heapStats, the compiled agent's runtime; absent under Node), and on
   Linux the thread count. Commit charge has no cheap reading from inside, so it stays a thing to read from outside.
   One JSON line per reading in memory.jsonl beside the log, the newest week kept; `status` shows the newest. */

const MEMORY_LOG_FIRST_MS = 60_000;
const MEMORY_LOG_EVERY_MS = 10 * 60_000;
// A week of readings at one every ten minutes.
const MEMORY_LOG_KEEP = 1008;
// Cut back to MEMORY_LOG_KEEP lines once the file passes this; a reading is under a kilobyte.
const MEMORY_LOG_TRIM_BYTES = 1024 * 1024;
// The most numerous kinds of object kept per reading: enough to see which one grows.
export const MEMORY_TOP_TYPES = 12;
// The newest line is read from the file's end, so `status` (which the tray asks often) never reads the whole week.
const TAIL_BYTES = 8192;

const JscHeapSchema = z.object({
    heapSizeBytes: z.number(),
    heapCapacityBytes: z.number(),
    extraMemoryBytes: z.number(),
    objects: z.number(),
    protectedObjects: z.number(),
    topTypes: z.record(z.string(), z.number()),
});

export const AgentMemorySchema = z.object({
    at: z.string(),
    pid: z.number(),
    version: z.string(),
    uptimeS: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    heapTotalBytes: z.number(),
    externalBytes: z.number(),
    arrayBuffersBytes: z.number(),
    threads: z.number().optional(),
    jsc: JscHeapSchema.optional(),
});
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export type JscHeap = z.infer<typeof JscHeapSchema>;

// What bun:jsc's heapStats answers, the fields read here.
const JscStatsSchema = z.object({
    heapSize: z.number(),
    heapCapacity: z.number(),
    extraMemorySize: z.number(),
    objectCount: z.number(),
    protectedObjectCount: z.number(),
    objectTypeCounts: z.record(z.string(), z.number()),
});

// Named by a variable so the build, which types this package for Node, does not look for the module; the compiled
// agent's runtime serves it, and Node (an npm install's `intentic-machine`) refuses it, which reads as no heap counts.
const JSC_MODULE = "bun:jsc";

// The one function read from bun:jsc; heapStats walks the heap, which every ten minutes affords. Its answer is parsed
// below rather than by the function schema, which would throw on a shape a later runtime changed.
const JscModuleSchema = z.object({ heapStats: z.function({ input: [], output: z.unknown() }) });

const jscHeap = async (): Promise<JscHeap | undefined> => {
    // allow(silent-catch): no such module under Node is the answer "no counts", not a failure
    const jsc = JscModuleSchema.safeParse(await import(JSC_MODULE).catch(() => undefined));
    if (!jsc.success) {
        return undefined;
    }
    const stats = JscStatsSchema.safeParse(jsc.data.heapStats());
    if (!stats.success) {
        return undefined;
    }
    const counts = Object.entries(stats.data.objectTypeCounts).sort(([, a], [, b]) => b - a);
    return {
        heapSizeBytes: stats.data.heapSize,
        heapCapacityBytes: stats.data.heapCapacity,
        extraMemoryBytes: stats.data.extraMemorySize,
        objects: stats.data.objectCount,
        protectedObjects: stats.data.protectedObjectCount,
        topTypes: Object.fromEntries(counts.slice(0, MEMORY_TOP_TYPES)),
    };
};

// Linux only: one entry per thread under /proc/self/task. Windows and macOS have no reading this cheap.
const threadCount = async (): Promise<number | undefined> =>
    process.platform === "linux"
        ? // allow(silent-catch): a /proc that cannot be listed leaves the count out
          await readdir("/proc/self/task").then(
              (tasks) => tasks.length,
              () => undefined,
          )
        : undefined;

export const readAgentMemory = async (now: Date = new Date()): Promise<AgentMemory> => {
    const usage = process.memoryUsage();
    const [threads, jsc] = await Promise.all([threadCount(), jscHeap()]);
    const reading: AgentMemory = {
        at: now.toISOString(),
        pid: process.pid,
        version: MACHINE_VERSION,
        uptimeS: Math.round(process.uptime()),
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
    };
    if (threads !== undefined) {
        reading.threads = threads;
    }
    if (jsc !== undefined) {
        reading.jsc = jsc;
    }
    return reading;
};

// One line on, and the file cut back to the newest `keep` lines once it passes `trimBytes`, written whole so a reader
// never sees half a file.
export const appendMemoryReading = async (
    path: string,
    reading: AgentMemory,
    { keep = MEMORY_LOG_KEEP, trimBytes = MEMORY_LOG_TRIM_BYTES }: { readonly keep?: number; readonly trimBytes?: number } = {},
): Promise<void> => {
    await appendFile(path, `${JSON.stringify(reading)}\n`);
    if ((await stat(path)).size <= trimBytes) {
        return;
    }
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
    await writeFileAtomic(path, `${lines.slice(-keep).join("\n")}\n`);
};

// The newest reading in the file, read from its end; undefined for no file, an empty one, or a last line that is not a
// reading.
export const latestMemoryReading = async (path: string): Promise<AgentMemory | undefined> => {
    // allow(silent-catch): no memory log yet is no reading
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const { size } = await handle.stat();
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const last = buffer.toString("utf8").trimEnd().split("\n").at(-1);
        return last === undefined || last === "" ? undefined : parseJsonWith(last, AgentMemorySchema);
    } finally {
        await handle.close();
    }
};

// The status row: what is in RAM, the heap, and how old the reading is.
export const memoryLine = (reading: AgentMemory, now: number): string => {
    const minutes = Math.max(0, Math.round((now - Date.parse(reading.at)) / 60_000));
    const heap = reading.jsc === undefined ? `heap ${sizeLabel(reading.heapUsedBytes)}` : `JS heap ${sizeLabel(reading.jsc.heapSizeBytes)} of ${sizeLabel(reading.jsc.heapCapacityBytes)}`;
    const threads = reading.threads === undefined ? "" : ` · ${reading.threads} threads`;
    return `${sizeLabel(reading.rssBytes)} in RAM · ${heap}${threads} · read ${minutes === 0 ? "just now" : `${minutes} min ago`}`;
};

export interface MemoryLog {
    readonly stop: () => void;
}

// A reading a minute after the start (the agent loaded and serving), then one every ten minutes. A failing write is
// said once, and again only after one has gone through.
export const startMemoryLog = (
    path: string,
    log: Log,
    { firstMs = MEMORY_LOG_FIRST_MS, everyMs = MEMORY_LOG_EVERY_MS }: { readonly firstMs?: number; readonly everyMs?: number } = {},
): MemoryLog => {
    let failing = false;
    const take = async (): Promise<void> => {
        try {
            await appendMemoryReading(path, await readAgentMemory());
            failing = false;
        } catch (error) {
            if (!failing) {
                log(`the agent's memory reading could not be written to ${path} (${errorMessage(error)}); trying again every ${everyMs / 60_000} min`);
            }
            failing = true;
        }
    };
    let every: NodeJS.Timeout | undefined;
    const first = setTimeout(() => {
        void take();
        every = setInterval(() => void take(), everyMs);
        every.unref();
    }, firstMs);
    first.unref();
    return {
        stop: () => {
            clearTimeout(first);
            clearInterval(every);
        },
    };
};
