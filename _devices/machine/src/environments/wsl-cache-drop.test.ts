import type { HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import { DROP_COOLDOWN_MS } from "./windows-memory.js";
import { startCacheDrop } from "./wsl-cache-drop.js";

const GIB = 1024 ** 3;

// One drop under a fake clock and fake WSL: what it asked, what it dropped through, and what it said.
const harness = (readings: HostMemory[], running: string[] | undefined, drop: (distro: string) => Promise<void> = async () => undefined) => {
    const lines: string[] = [];
    const dropped: string[] = [];
    let listed = 0;
    let clock = 1_800_000_000_000;
    const queue = [...readings];
    const cache = startCacheDrop((line) => void lines.push(line), {
        read: () => (queue.length > 1 ? queue.shift() : queue[0]),
        running: async () => {
            listed += 1;
            return running;
        },
        drop: async (distro) => {
            dropped.push(distro);
            await drop(distro);
        },
        now: () => clock,
        settleMs: 0,
    });
    return { cache, lines, dropped, listed: () => listed, advance: (ms: number) => void (clock += ms) };
};

const low = { availableBytes: 1.1 * GIB, totalBytes: 32 * GIB };
const after = { availableBytes: 7 * GIB, totalBytes: 32 * GIB };
const plenty = { availableBytes: 12 * GIB, totalBytes: 32 * GIB };

test("Windows with memory to spare never asks WSL anything", async () => {
    const run = harness([plenty], ["Ubuntu"]);
    await run.cache.pass();
    expect(run.listed()).toBe(0);
    expect(run.dropped).toEqual([]);
});

test("low Windows drops the cache once through a running distro and logs before and after", async () => {
    const run = harness([low, after, low, low, after], ["docker-desktop", "Ubuntu"]);
    await run.cache.pass();
    expect(run.dropped).toEqual(["Ubuntu"]);
    expect(run.lines).toEqual([expect.stringContaining("(1.1 GiB of 32.0 GiB available)")]);
    expect(run.lines[0]).toContain("7.0 GiB available");
    // Low again a tick later: the cooldown holds it.
    await run.cache.pass();
    expect(run.dropped).toEqual(["Ubuntu"]);
    run.advance(DROP_COOLDOWN_MS);
    await run.cache.pass();
    expect(run.dropped).toEqual(["Ubuntu", "Ubuntu"]);
});

test("with WSL not running, or not answering, nothing is dropped and nothing booted", async () => {
    for (const running of [[], undefined]) {
        const run = harness([low], running);
        await run.cache.pass();
        expect(run.listed()).toBe(1);
        expect(run.dropped).toEqual([]);
        expect(run.lines).toEqual([]);
        // The listing itself waits out the cooldown too, rather than spawning wsl.exe every tick.
        await run.cache.pass();
        expect(run.listed()).toBe(1);
    }
});

test("a drop that fails is said once and never thrown out of the tick", async () => {
    const run = harness([low], ["Ubuntu"], async () => {
        throw new Error("Access is denied.");
    });
    await run.cache.pass();
    expect(run.lines).toEqual(["Windows was low on memory, but dropping the WSL VM's file cache through Ubuntu failed: Access is denied."]);
    const reading = harness([low], undefined);
    // A reader that throws is absorbed as well.
    const broken = startCacheDrop((line) => void reading.lines.push(line), {
        read: () => {
            throw new Error("no memory reading");
        },
    });
    await broken.pass();
    expect(reading.lines).toEqual(["giving the WSL VM's file cache back to Windows failed: no memory reading"]);
});
