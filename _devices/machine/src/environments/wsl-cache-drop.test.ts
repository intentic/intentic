import type { HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import { DROP_COOLDOWN_MS, RECLAIM_GRACE_MS } from "./windows-memory.js";
import { DROP_SCRIPT, startCacheDrop } from "./wsl-cache-drop.js";
import { LOW_PROBE_EVERY_MS, RESTORE_AFTER_MS } from "./wsl-page-reporting.js";

const GIB = 1024 ** 3;

// rog's guest on 2026-11-26 (wsl-page-reporting.test.ts): 1.76 GiB of its free memory in blocks under 128 KiB.
const ROG_BUDDYINFO = `Node 0, zone    DMA32   8839   4046   2538   1990   1371    849    522    232      1      0      0
Node 0, zone   Normal  40264  26270  17466  13207   8012   3806   1243    164     35      0      0`;
// A guest whose free memory is almost all in large blocks: nothing stranded worth lowering the order for.
const WHOLE_BUDDYINFO = "Node 0, zone   Normal  100  100  100  100  100  100  100  100  100  100  2000";

interface FakeGuest {
    order: number;
    probes: number;
    readonly written: string[];
    // Why root's writes fail, while they do.
    refuse: string | undefined;
    readonly probe: () => Promise<string>;
    readonly asRoot: (distro: string, script: string) => Promise<void>;
}

// A WSL VM's page_reporting_order as the fakes read and write it: `order` now, `bootOrder` on its command line.
const fakeGuest = (order: number, buddyinfo = ROG_BUDDYINFO, bootOrder = 5): FakeGuest => {
    const guest: FakeGuest = {
        order,
        probes: 0,
        written: [],
        refuse: undefined,
        probe: async () => {
            guest.probes += 1;
            return `${buddyinfo}\n--\n${guest.order}\n--\nconsole=hvc0 page_reporting.page_reporting_order=${bootOrder} debug\n--\n4096\n`;
        },
        asRoot: async (_distro: string, script: string) => {
            if (guest.refuse !== undefined) {
                throw new Error(guest.refuse);
            }
            const [, expected, next] = /^grep -qx (\d+) \S+ \|\| exit 3; echo (\d+) > /.exec(script) ?? [];
            if (Number(expected) !== guest.order) {
                throw new Error("exit 3");
            }
            guest.order = Number(next);
            guest.written.push(script);
        },
    };
    return guest;
};

// No page reporting to read: the fakes the tests about drops alone run with.
const noGuest = () => ({ probe: async () => "", asRoot: async () => undefined });

// One drop under a fake clock and fake WSL: what it asked, what it dropped through, and what it said.
const harness = (
    readings: HostMemory[],
    running: string[] | undefined,
    drop: (distro: string) => Promise<void> = async () => undefined,
    guest: Pick<FakeGuest, "probe" | "asRoot"> = noGuest(),
) => {
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
        probe: guest.probe,
        asRoot: guest.asRoot,
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

// rog on 2026-11-24: Windows at 2-3 GiB of 31.4 for days, every drop giving back about 0.2 GiB.
test("drops that give back little come further apart, and Windows recovering brings the five minutes back", async () => {
    const stuck = { availableBytes: 2.4 * GIB, totalBytes: 31.4 * GIB };
    const littleBack = { availableBytes: 2.6 * GIB, totalBytes: 31.4 * GIB };
    const recovered = { availableBytes: 9 * GIB, totalBytes: 31.4 * GIB };
    // Each pass reads Windows once before and, when it drops, once after.
    // (2026-11-26) Above the floor, the first drop is deferred by RECLAIM_GRACE_MS.
    // Flow: grace → drop(little) → held → drop(little) → recovered → grace → drop(little).
    const run = harness(
        [stuck, stuck, littleBack, stuck, stuck, littleBack, recovered, stuck, stuck, littleBack],
        ["archlinux"],
    );
    // 1. First low reading: sets lowSince, deferred by grace period.
    await run.cache.pass();
    expect(run.dropped).toHaveLength(0);
    // 2. Grace period expired: drop runs, gave back little (2.4 → 2.6).
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(1);
    expect(run.lines[0]).toContain("the next drop waits 10 min");
    // 3. Within doubled cooldown (10 min): held.
    run.advance(DROP_COOLDOWN_MS);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(1);
    // 4. Doubled cooldown passed: drop, gave back little again.
    run.advance(DROP_COOLDOWN_MS);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(2);
    expect(run.lines[1]).toContain("the next drop waits 20 min");
    // 5. Recovered: cooldown and lowSince reset.
    run.advance(DROP_COOLDOWN_MS);
    await run.cache.pass();
    // 6. Low again: lowSince set fresh, grace period starts.
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(2);
    // 7. Grace period expired: drop runs with the original cooldown.
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(3);
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

// Dropping the page cache alone frees memory inside the VM that Windows never gets back: the slab goes too, and the free
// memory is compacted into the whole blocks free page reporting hands back.
test("a drop flushes first, drops cache and slab, then compacts where the kernel can", () => {
    expect(DROP_SCRIPT.startsWith("sync;")).toBe(true);
    expect(DROP_SCRIPT).toContain("echo 3 > /proc/sys/vm/drop_caches");
    expect(DROP_SCRIPT).toContain("if [ -w /proc/sys/vm/compact_memory ]; then echo 1 > /proc/sys/vm/compact_memory; fi");
});

// (2026-11-26) Above the 1.5 GiB floor, sandboxes' own cgroup reclaim runs first.
test("above the floor, the blanket drop waits for sandboxes to reclaim from their own cgroups", async () => {
    const underLow = { availableBytes: 2.5 * GIB, totalBytes: 31.4 * GIB };
    const run = harness([underLow, underLow, underLow, underLow], ["Ubuntu"]);
    // First tick: sets lowSince, deferred by grace period.
    await run.cache.pass();
    expect(run.dropped).toHaveLength(0);
    // Still within grace period.
    run.advance(30_000);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(0);
    // Grace period expired: drop runs.
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toHaveLength(1);
});

test("under the 1.5 GiB floor, the blanket drop runs immediately without grace period", async () => {
    const underFloor = { availableBytes: 1.0 * GIB, totalBytes: 32 * GIB };
    const afterDrop = { availableBytes: 7 * GIB, totalBytes: 32 * GIB };
    const run = harness([underFloor, afterDrop], ["Ubuntu"]);
    await run.cache.pass();
    // Under the floor: drops on the first tick, no grace period.
    expect(run.dropped).toHaveLength(1);
});

// (2026-11-26) Free memory stranded in blocks under the reporting order (wsl-page-reporting.ts).
const lowWindows = { availableBytes: 2.9 * GIB, totalBytes: 31.4 * GIB };
const tightWindows = { availableBytes: 4.5 * GIB, totalBytes: 31.4 * GIB };
const easyWindows = { availableBytes: 8 * GIB, totalBytes: 31.4 * GIB };

test("a low spell with a gigabyte stranded lowers the order and compacts at once, and the drop waits its cooldown from there", async () => {
    const guest = fakeGuest(5);
    const run = harness([lowWindows], ["archlinux"], undefined, guest);
    await run.cache.pass();
    // The spell's first tick, inside the sandboxes' grace: lowered and compacted, nothing dropped.
    expect(guest.order).toBe(2);
    expect(guest.written).toEqual([expect.stringContaining("compact_memory")]);
    expect(run.dropped).toEqual([]);
    expect(run.lines).toEqual([
        "Windows had 2.9 GiB of 31.4 GiB available while the WSL VM had 1.8 GiB free in blocks too small to give back (page_reporting_order 5): lowered it to 2 and compacted through archlinux, to hold until the agent stops since the VM is backed by small pages; 0.4 GiB stranded and 2.9 GiB available 0s later.",
    ]);
    expect(run.cache.guestFree()).toMatchObject({ reportingOrder: 2, loweredFrom: 5 });
    // Past the grace but inside the cooldown the lowering started: the sandboxes' reclaim, which reaches Windows now, goes first.
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toEqual([]);
    run.advance(DROP_COOLDOWN_MS - RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toEqual(["archlinux"]);
    // Held: never lowered twice, and read only every five minutes for the heartbeat.
    expect(guest.written).toHaveLength(1);
});

test("a large-page VM's own order comes back once Windows has held a fifth of its memory for ten minutes, and when the agent stops", async () => {
    // Someone set 4 by hand on a VM WSL booted at 9: 4 is what goes back.
    const guest = fakeGuest(4, ROG_BUDDYINFO, 9);
    const run = harness([lowWindows, lowWindows, easyWindows], ["archlinux"], undefined, guest);
    await run.cache.pass();
    expect(guest.order).toBe(2);
    run.advance(LOW_PROBE_EVERY_MS);
    await run.cache.pass();
    run.advance(RESTORE_AFTER_MS - 1);
    await run.cache.pass();
    expect(guest.order).toBe(2);
    run.advance(RESTORE_AFTER_MS);
    await run.cache.pass();
    expect(guest.order).toBe(4);
    expect(run.lines.at(-1)).toMatch(/^Windows has had more than a fifth of its memory for 10 min \(8\.0 GiB of 31\.4 GiB available\): put the WSL VM's page_reporting_order back from 2 to 4 through archlinux/);
    expect(run.cache.guestFree()).toMatchObject({ reportingOrder: 4 });
    expect(run.cache.guestFree()?.loweredFrom).toBeUndefined();

    const stopping = fakeGuest(5);
    const stopped = harness([lowWindows], ["archlinux"], undefined, stopping);
    await stopped.cache.pass();
    expect(stopping.order).toBe(2);
    await stopped.cache.restore();
    expect(stopping.order).toBe(5);
    expect(stopped.lines.at(-1)).toBe("the agent is stopping: put the WSL VM's page_reporting_order back from 2 to 5 through archlinux (0.4 GiB stranded before).");
    // Nothing held: stopping writes nothing.
    await stopped.cache.restore();
    expect(stopping.written).toHaveLength(2);
});

test("a small-page VM is lowered once Windows is tight, and keeps it until the agent stops however long Windows has room", async () => {
    const guest = fakeGuest(5);
    const run = harness([tightWindows, easyWindows], ["archlinux"], undefined, guest);
    await run.cache.pass();
    // Under a fifth but above the low line: lowered, standing in for the early drop.
    expect(guest.order).toBe(2);
    expect(run.dropped).toEqual([]);
    run.advance(3 * RESTORE_AFTER_MS);
    await run.cache.pass();
    run.advance(3 * RESTORE_AFTER_MS);
    await run.cache.pass();
    expect(guest.order).toBe(2);
    expect(run.cache.guestFree()).toMatchObject({ reportingOrder: 2, loweredFrom: 5 });
    await run.cache.restore();
    expect(guest.order).toBe(5);
    expect(guest.written).toHaveLength(2);
});

test("a VM that restarted with its own order is not the agent's to put back, and an earlier agent's lowered order is", async () => {
    // A large-page VM, so Windows only tight leaves the restarted VM's order alone.
    const guest = fakeGuest(5, ROG_BUDDYINFO, 9);
    const run = harness([lowWindows, tightWindows], ["archlinux"], undefined, guest);
    await run.cache.pass();
    expect(guest.order).toBe(2);
    // WSL restarted: the order reads 5 again, so the hold is dropped and nothing is written when the agent stops.
    guest.order = 5;
    run.advance(5 * 60_000);
    await run.cache.pass();
    expect(run.cache.guestFree()).toMatchObject({ reportingOrder: 5 });
    expect(run.cache.guestFree()?.loweredFrom).toBeUndefined();
    await run.cache.restore();
    expect(guest.written).toHaveLength(1);

    // An agent that was killed while holding it: the next one adopts the boot order and puts it back as it stops.
    const left = fakeGuest(2);
    const next = harness([lowWindows], ["archlinux"], undefined, left);
    await next.cache.pass();
    expect(next.cache.guestFree()).toMatchObject({ reportingOrder: 2, loweredFrom: 5 });
    await next.cache.restore();
    expect(left.order).toBe(5);
});

test("an order root cannot write leaves the drop to run as before, and is tried again only half an hour later", async () => {
    const guest = fakeGuest(5);
    guest.refuse = "Permission denied";
    const run = harness([lowWindows], ["archlinux"], undefined, guest);
    await run.cache.pass();
    expect(run.lines).toEqual(["lowering the WSL VM's page_reporting_order through archlinux failed: Permission denied"]);
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(run.dropped).toEqual(["archlinux"]);
    expect(run.lines).toHaveLength(2);
});

test("little stranded, or Windows with room, leaves the order alone", async () => {
    const whole = fakeGuest(5, WHOLE_BUDDYINFO);
    const run = harness([lowWindows], ["archlinux"], undefined, whole);
    await run.cache.pass();
    run.advance(RECLAIM_GRACE_MS);
    await run.cache.pass();
    expect(whole.written).toEqual([]);
    expect(run.dropped).toEqual(["archlinux"]);
    expect(run.cache.guestFree()).toMatchObject({ reportingOrder: 5 });

    const roomy = fakeGuest(5);
    const easy = harness([easyWindows], ["archlinux"], undefined, roomy);
    await easy.cache.pass();
    expect(easy.listed()).toBe(0);
    expect(roomy.probes).toBe(0);
    expect(easy.cache.guestFree()).toBeUndefined();
});

test("under the 1.5 GiB floor the order is lowered and the cache dropped in the same pass", async () => {
    const guest = fakeGuest(5);
    const underFloor = { availableBytes: 1.2 * GIB, totalBytes: 31.4 * GIB };
    const run = harness([underFloor], ["archlinux"], undefined, guest);
    await run.cache.pass();
    expect(guest.order).toBe(2);
    expect(run.dropped).toEqual(["archlinux"]);
    // WSL listed once for the whole pass.
    expect(run.listed()).toBe(1);
});
