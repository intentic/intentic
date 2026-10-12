import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginExitRecord, previousExit, readExitRecordSync, recordExit, recordStopFor, stampAlive } from "./last-exit.js";

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "last-exit-")), "last-exit.json");

test("a start reads what the agent before left, then holds a record of its own that its exit closes", async () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify({ pid: 7, version: "1.0.0", startedAt: "2026-10-10T00:00:00.000Z", reason: "watchdog", at: "2026-10-10T01:00:00.000Z" }));
    const said = await beginExitRecord(process.pid, "1.1.0", { path, now: Date.parse("2026-10-11T00:00:00Z"), uptimeMs: 1_000 });
    expect(said).toContain("pid 7");
    expect(said).toContain("watchdog killed it");
    expect(previousExit()).toBe(said);
    expect(readExitRecordSync(path)).toMatchObject({ pid: process.pid, version: "1.1.0", reason: "running" });
    await stampAlive(path, Date.parse("2026-10-11T00:05:00Z"));
    expect(readExitRecordSync(path)?.aliveAt).toBe("2026-10-11T00:05:00.000Z");
    recordExit("stopped", "signal SIGTERM", { path, at: new Date("2026-10-11T00:06:00Z") });
    expect(readExitRecordSync(path)).toMatchObject({ reason: "stopped", detail: "signal SIGTERM", aliveAt: "2026-10-11T00:05:00.000Z" });
});

// An update stops the agent from outside, and on Windows the agent runs nothing then: the stopper's word is the one kept.
test("a stop recorded from outside is not overwritten by the signal that carries it out, nor by another process", async () => {
    const path = fresh();
    await beginExitRecord(process.pid, "1.1.0", { path });
    recordStopFor(process.pid, "update", "for the update to 1.2.0", { path });
    recordExit("stopped", "signal SIGTERM", { path });
    expect(readExitRecordSync(path)).toMatchObject({ reason: "update", detail: "for the update to 1.2.0" });
    // A stopper naming another pid leaves this record alone.
    const other = fresh();
    await beginExitRecord(process.pid, "1.1.0", { path: other });
    recordStopFor(process.pid + 1, "restart", "by hand", { path: other });
    expect(JSON.parse(readFileSync(other, "utf8"))).toMatchObject({ reason: "running" });
});
