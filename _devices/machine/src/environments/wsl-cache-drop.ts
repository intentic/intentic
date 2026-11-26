import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { runBoundedBytes } from "@intentic/base/process";
import { type GuestFreeMemory, HOST_LOW_FLOOR_BYTES, type HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import type { Log } from "@intentic/local-agent";
import {
    decodeWslListing,
    DROP_COOLDOWN_MS,
    dropLine,
    lowSpellSince,
    nextDropCooldown,
    recoveredFromTight,
    runningDistrosFrom,
    shouldDropCache,
    windowsMemory,
} from "./windows-memory.js";
import { asRootThrough, type GuestDeps, type GuestSide, guestSide, probeThrough } from "./wsl-guest.js";

// The Windows side's resident agent gives the WSL VM's memory back to Windows when Windows runs low: it lowers the VM's
// page_reporting_order while free memory sits stranded in blocks too small to report (wsl-page-reporting.ts says why,
// wsl-guest.ts does it), and drops the VM's file cache (windows-memory.ts says why and when). Started by the resident
// agent on the Windows side only; each tick asks, and the cheap part (one `os.freemem()`) is all a tick with enough
// memory costs.

// Listing what runs boots nothing and answers in well under a second; the deadline is for a WSL service that hangs.
const LIST_TIMEOUT_MS = 10_000;
// `sync` first, so the cache dropped is clean pages only; on a busy disk that flush can take a while, never forever.
const DROP_TIMEOUT_MS = 60_000;
// How long after a drop Windows is read again: the freed pages reach Windows through the VM's free page reporting
// within a few seconds, not at once.
const SETTLE_MS = 5_000;
// When the agent stops, putting the order back gets this long, whatever wsl.exe does.
const STOP_RESTORE_MS = 15_000;

export interface CacheDrop {
    // Asks, and drops when due; never throws and never holds the tick: a pass already underway is left to finish.
    readonly tick: () => void;
    // The guest's free memory as last read, for the heartbeat: undefined until read, and where nothing could be.
    readonly guestFree: () => GuestFreeMemory | undefined;
    // Puts the kernel's page_reporting_order back where the agent holds it lowered: when the agent stops. Never throws.
    readonly restore: () => Promise<void>;
}

interface CacheDropDeps extends Partial<Pick<GuestDeps, "read" | "running" | "probe" | "asRoot" | "now" | "settleMs">> {
    // Drops the cache through one distro; throws with why it did not.
    readonly drop?: (distro: string) => Promise<void>;
}

const listRunning = async (): Promise<string[] | undefined> => {
    // WSL_UTF8 asks a new wsl.exe for UTF-8; an old one ignores it and writes UTF-16LE, which the decoder tells apart.
    const listed = await runBoundedBytes("wsl.exe", ["--list", "--running", "--quiet"], {
        timeoutMs: LIST_TIMEOUT_MS,
        env: { ...process.env, WSL_UTF8: "1" },
        maxStdoutBytes: 64 * 1024,
    });
    if (listed.spawnError !== undefined || listed.timedOut) {
        return undefined;
    }
    // With nothing running, wsl.exe says so and exits non-zero on some builds: that is "none", not "cannot ask".
    return runningDistrosFrom(decodeWslListing(listed.stdout.bytes));
};

// The page cache and the reclaimable slab (dentries, inodes: most of a gigabyte after a sync walks a big tree), then the
// free memory compacted. The VM hands pages back to Windows through free page reporting, which reports only whole free
// blocks of a few megabytes: cache dropped from pages scattered among ones still in use frees memory inside the VM that
// Windows never sees. On marta (2026-11-22) the page cache alone had given back 0-0.7 GiB a drop; all three together
// took the VM from 8.7 to 4.9 GiB resident within 20 s. A kernel without compaction has no compact_memory: skipped.
export const DROP_SCRIPT =
    "sync; echo 3 > /proc/sys/vm/drop_caches; if [ -w /proc/sys/vm/compact_memory ]; then echo 1 > /proc/sys/vm/compact_memory; fi";

const dropThrough = async (distro: string): Promise<void> => {
    await asRootThrough(distro, DROP_SCRIPT, DROP_TIMEOUT_MS);
};

// The agent stopping: the order put back if held, after a pass underway, bounded by STOP_RESTORE_MS.
const restoreOnStop = async (log: Log, guest: GuestSide, underway: Promise<void> | undefined, read: () => HostMemory | undefined): Promise<void> => {
    const settled = async (): Promise<void> => {
        await underway;
        await guest.stop(read());
    };
    try {
        await Promise.race([settled(), sleep(STOP_RESTORE_MS)]);
    } catch (error) {
        log(`putting the WSL VM's page_reporting_order back failed: ${errorMessage(error)}`);
    }
};

export const startCacheDrop = (
    log: Log,
    {
        read = windowsMemory,
        running = listRunning,
        drop = dropThrough,
        probe = probeThrough,
        asRoot = asRootThrough,
        now = Date.now,
        settleMs = SETTLE_MS,
    }: CacheDropDeps = {},
): CacheDrop & { readonly pass: () => Promise<void> } => {
    let lastDropAt = Number.NEGATIVE_INFINITY;
    // How long the next drop under the low line waits: longer after each drop that gave Windows little (nextDropCooldown).
    let cooldownMs = DROP_COOLDOWN_MS;
    let underway: Promise<void> | undefined;
    // (2026-11-26) When the host first went under the low line this spell: sandboxes' own cgroup reclaim has
    // RECLAIM_GRACE_MS from here before the blanket drop runs (above the floor).
    let lowSince: number | undefined;
    const guest = guestSide(log, { read, running, probe, asRoot, now, settleMs });

    const dropNow = async (before: HostMemory): Promise<void> => {
        const distro = await guest.distroNow();
        if (distro === undefined) {
            return;
        }
        try {
            await drop(distro);
        } catch (error) {
            log(`Windows was low on memory, but dropping the WSL VM's file cache through ${distro} failed: ${errorMessage(error)}`);
            return;
        }
        await sleep(settleMs);
        const after = read();
        const previous = cooldownMs;
        cooldownMs = nextDropCooldown(cooldownMs, after === undefined ? undefined : after.availableBytes - before.availableBytes);
        if (after !== undefined) {
            log(dropLine(distro, before, after, settleMs, cooldownMs > previous ? cooldownMs : undefined));
        }
    };

    const attempt = async (): Promise<void> => {
        guest.begin();
        const before = read();
        if (before === undefined) {
            return;
        }
        if (recoveredFromTight(before)) {
            cooldownMs = DROP_COOLDOWN_MS;
        }
        // The spell starts before the first drop is considered, so the sandboxes' grace runs from its first tick.
        lowSince = lowSpellSince(before, lowSince, now());
        await guest.restoreIfDue(before);
        const probed = await guest.guest(before, lowSince);
        const dropDue = shouldDropCache(before, lastDropAt, now(), cooldownMs, lowSince);
        // Stranded memory first: lowering the order and compacting gives it back without throwing any sandbox's cache
        // away, and lets the sandboxes' own reclaim reach Windows. Above the floor it stands in for the drop, which then
        // waits its cooldown from here; under the floor, where Windows froze, the drop runs as well.
        if ((await guest.lowerIfDue(before, probed, dropDue)) && before.availableBytes >= HOST_LOW_FLOOR_BYTES) {
            lastDropAt = now();
            return;
        }
        if (!dropDue) {
            return;
        }
        // Counted from the attempt, not the success: a drop that keeps failing is tried again in five minutes, not every tick.
        lastDropAt = now();
        // Never boots WSL: only a distro already running is asked, and with none running the VM holds no cache to give.
        await dropNow(before);
    };
    // Whatever goes wrong is said and absorbed here: this runs beside the resident agent's tick, which it must never end.
    const pass = async (): Promise<void> => {
        try {
            await attempt();
        } catch (error) {
            log(`giving the WSL VM's file cache back to Windows failed: ${errorMessage(error)}`);
        }
    };
    return {
        pass,
        tick: () => {
            if (underway !== undefined) {
                return;
            }
            underway = pass().finally(() => {
                underway = undefined;
            });
        },
        guestFree: guest.guestFree,
        restore: async () => await restoreOnStop(log, guest, underway, read),
    };
};

let given: CacheDrop | undefined;

/** Starts this process's cache drop and order hold: the resident agent, on Windows' own side. */
export const giveWslMemoryBack = (log: Log): CacheDrop => (given ??= startCacheDrop(log));

/** The heartbeat's `guestFree`: undefined anywhere but a resident agent on Windows' own side, and until it read the guest. */
export const guestFreeMemory = (): GuestFreeMemory | undefined => given?.guestFree();
