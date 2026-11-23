import { type AgentMemory, memoryLine } from "./memory-log.js";

const MB = 1024 * 1024;

const reading = (extra: Partial<AgentMemory> = {}): AgentMemory => ({
    at: "2026-11-22T10:00:00.000Z",
    pid: 4242,
    version: "1.431.0",
    uptimeS: 3600,
    rssBytes: 95 * MB,
    heapUsedBytes: 20 * MB,
    heapTotalBytes: 30 * MB,
    externalBytes: 4 * MB,
    arrayBuffersBytes: MB,
    ...extra,
});

describe("memoryLine", () => {
    const now = Date.parse("2026-11-22T10:04:00.000Z");

    it("says what is in RAM, the JavaScript heap as JavaScriptCore counts it, and how old the reading is", () => {
        const jsc = { heapSizeBytes: 22 * MB, heapCapacityBytes: 31 * MB, extraMemoryBytes: 2 * MB, objects: 1000, protectedObjects: 3, topTypes: { Object: 400 } };
        expect(memoryLine(reading({ jsc }), now)).toBe("95.0 MB in RAM · JS heap 22.0 MB of 31.0 MB · read 4 min ago");
    });

    it("falls back to the runtime's own heap figure under Node, and adds the thread count where there is one", () => {
        expect(memoryLine(reading({ threads: 23 }), Date.parse("2026-11-22T10:00:20.000Z"))).toBe("95.0 MB in RAM · heap 20.0 MB · 23 threads · read just now");
    });
});
