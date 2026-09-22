import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "bun:test";

const entrypoint = readFileSync(fileURLToPath(new URL("../docker-entrypoint.sh", import.meta.url)), "utf8");

/* The heap and the memory.high brake are sized from what the box HAS, and an owner's cap past the engine never binds. */
describe(`entrypoint memory sizing`, () => {
    const GIB = 1024 ** 3;
    // The WSL guest's MemTotal behind a 20 GB .wslconfig, in KiB.
    const GUEST_KIB = 20_479_632;
    const sizing = entrypoint.slice(entrypoint.indexOf("heap_mb=1536"), entrypoint.indexOf("exec node"));
    // The sizing lines run against a staged memory.max, memory.high and meminfo; answers the heap and the brake written.
    const size = (memoryMax: string, engineKib: number): { heapMb: number; high: string } => {
        const dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
        writeFileSync(join(dir, "memory.max"), `${memoryMax}\n`);
        writeFileSync(join(dir, "memory.high"), "max\n");
        writeFileSync(join(dir, "meminfo"), `MemTotal:       ${engineKib} kB\nMemFree:          812344 kB\n`);
        const script = sizing
            .replaceAll("/sys/fs/cgroup/memory.max", join(dir, "memory.max"))
            .replaceAll("/sys/fs/cgroup/memory.high", join(dir, "memory.high"))
            .replaceAll("/proc/meminfo", join(dir, "meminfo"));
        const run = spawnSync("sh", ["-ec", `${script}\necho "$heap_mb"`], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
        return { heapMb: Number(run.stdout.trim()), high: readFileSync(join(dir, "memory.high"), "utf8").trim() };
    };
    // The script's own integer order: divide by 100, then take the percentage.
    const brake = (bytes: number): string => String(Math.floor(bytes / 100) * 90);

    it(`sizes from the cap where the cap binds`, () => {
        expect(size(String(16 * GIB), GUEST_KIB)).toEqual({ heapMb: 3072, high: brake(16 * GIB) });
    });

    it(`sizes from the engine where the cap is past it`, () => {
        expect(size(String(64 * GIB), GUEST_KIB).high).toBe(brake(GUEST_KIB * 1024));
        // A small engine under a big cap: a quarter of the engine's 4 GiB, not of the 64 nobody has.
        expect(size(String(64 * GIB), 4 * 1024 * 1024)).toEqual({ heapMb: 1024, high: brake(4 * GIB) });
    });

    it(`leaves an uncapped box on the middle heap and unbraked`, () => {
        expect(size("max", GUEST_KIB)).toEqual({ heapMb: 1536, high: "max" });
    });
});
