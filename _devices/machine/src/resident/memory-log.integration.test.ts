import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemoryReading, latestMemoryReading, MEMORY_TOP_TYPES, readAgentMemory } from "./memory-log.js";

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "memory-log-")), "memory.jsonl");

describe("the agent's memory log", () => {
    it("reads this process, with the JavaScriptCore heap under Bun and the thread count on Linux", async () => {
        const reading = await readAgentMemory(new Date("2026-11-22T10:00:00.000Z"));
        expect(reading).toMatchObject({ at: "2026-11-22T10:00:00.000Z", pid: process.pid, rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number) });
        // The suites run under Bun, whose bun:jsc this reads.
        expect(reading.jsc?.objects).toBeGreaterThan(0);
        expect(Object.keys(reading.jsc?.topTypes ?? {}).length).toBeLessThanOrEqual(MEMORY_TOP_TYPES);
        if (process.platform === "linux") {
            expect(reading.threads).toBeGreaterThan(0);
        }
    });

    it("answers the newest line, read from the end, and nothing for a missing file or a line that is not a reading", async () => {
        const path = fresh();
        expect(await latestMemoryReading(path)).toBeUndefined();
        const first = await readAgentMemory(new Date("2026-11-22T10:00:00.000Z"));
        const second = await readAgentMemory(new Date("2026-11-22T10:10:00.000Z"));
        await appendMemoryReading(path, first);
        await appendMemoryReading(path, second);
        expect((await latestMemoryReading(path))?.at).toBe("2026-11-22T10:10:00.000Z");
        writeFileSync(path, `${JSON.stringify(first)}\nhalf a li`);
        expect(await latestMemoryReading(path)).toBeUndefined();
    });

    it("cuts the file back to the newest readings once it passes its limit", async () => {
        const path = fresh();
        const base = await readAgentMemory(new Date("2026-11-22T10:00:00.000Z"));
        for (let at = 0; at < 6; at++) {
            await appendMemoryReading(path, { ...base, uptimeS: at }, { keep: 3, trimBytes: JSON.stringify(base).length * 4 });
        }
        const kept = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).uptimeS);
        expect(kept.at(-1)).toBe(5);
        expect(kept.length).toBeLessThanOrEqual(4);
        expect((await latestMemoryReading(path))?.uptimeS).toBe(5);
    });
});
