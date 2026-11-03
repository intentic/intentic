import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { execBounded, runBoundedBytes } from "@intentic/base/process";
import type { HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import type { Log } from "@intentic/local-agent";
import { cacheDropDistro, decodeWslListing, dropLine, runningDistrosFrom, shouldDropCache, windowsMemory } from "./windows-memory.js";

// The Windows side's resident agent gives the WSL VM's file cache back to Windows when Windows runs low (windows-memory.ts
// says why and when). Started by the resident agent on the Windows side only; each tick asks, and the cheap part (one
// `os.freemem()`) is all a tick with enough memory costs.

// Listing what runs boots nothing and answers in well under a second; the deadline is for a WSL service that hangs.
const LIST_TIMEOUT_MS = 10_000;
// `sync` first, so the cache dropped is clean pages only; on a busy disk that flush can take a while, never forever.
const DROP_TIMEOUT_MS = 60_000;
// How long after a drop Windows is read again: the freed pages reach Windows through the VM's free page reporting
// within a few seconds, not at once.
const SETTLE_MS = 5_000;

export interface CacheDrop {
    // Asks, and drops when due; never throws and never holds the tick: a pass already underway is left to finish.
    readonly tick: () => void;
}

interface CacheDropDeps {
    readonly read?: () => HostMemory | undefined;
    // The running distros, or undefined where WSL cannot be asked.
    readonly running?: () => Promise<string[] | undefined>;
    // Drops the cache through one distro; throws with why it did not.
    readonly drop?: (distro: string) => Promise<void>;
    readonly now?: () => number;
    readonly settleMs?: number;
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

const dropThrough = async (distro: string): Promise<void> => {
    await execBounded("wsl.exe", ["-d", distro, "-u", "root", "--", "sh", "-c", "sync; echo 1 > /proc/sys/vm/drop_caches"], {
        timeoutMs: DROP_TIMEOUT_MS,
    });
};

export const startCacheDrop = (
    log: Log,
    { read = windowsMemory, running = listRunning, drop = dropThrough, now = Date.now, settleMs = SETTLE_MS }: CacheDropDeps = {},
): CacheDrop & { readonly pass: () => Promise<void> } => {
    let lastDropAt = Number.NEGATIVE_INFINITY;
    let underway: Promise<void> | undefined;
    const attempt = async (): Promise<void> => {
        const before = read();
        if (before === undefined || !shouldDropCache(before, lastDropAt, now())) {
            return;
        }
        // Counted from the attempt, not the success: a drop that keeps failing is tried again in five minutes, not every tick.
        lastDropAt = now();
        // Never boots WSL: only a distro already running is asked, and with none running the VM holds no cache to give.
        // (A distro that stopped in the second between the listing and the drop would be started again by `wsl -d`;
        // the VM it belongs to was running a second ago, and a sandbox's docker-desktop never stops while it runs.)
        const distro = cacheDropDistro((await running()) ?? []);
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
        if (after !== undefined) {
            log(dropLine(distro, before, after, settleMs));
        }
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
    };
};
