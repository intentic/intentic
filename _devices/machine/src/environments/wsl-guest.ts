import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { execBounded } from "@intentic/base/process";
import type { GuestFreeMemory, HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import type { Log } from "@intentic/local-agent";
import { cacheDropDistro } from "./windows-memory.js";
import {
    adoptHold,
    GUEST_PROBE_SCRIPT,
    type GuestProbe,
    guestFreeOf,
    LOWERED_ORDER,
    loweredLine,
    type OrderHold,
    orderScript,
    parseGuestProbe,
    probeDue,
    restoredLine,
    restoreStep,
    shouldLowerOrder,
    strandedOf,
} from "./wsl-page-reporting.js";

/* The WSL VM's own side of giving memory back (wsl-page-reporting.ts says why): the guest read through a distro already
   running, and the page_reporting_order the agent holds lowered while Windows is short. Never boots WSL: only a distro
   in `wsl.exe --list --running` is asked. (A distro that stopped in the second between the listing and the call would be
   started again by `wsl -d`; the VM it belongs to was running a second ago, and a sandbox's docker-desktop never stops
   while it runs.) wsl-cache-drop.ts runs it on the resident agent's tick, beside the drop. */

// Reading /proc answers in about 100 ms through wsl.exe (rog, 2026-11-26); writing the order and compacting in a second
// or two.
const PROBE_TIMEOUT_MS = 10_000;
const ORDER_TIMEOUT_MS = 30_000;
// After the order could not be lowered (a distro whose root cannot write it), drops go on as before for this long.
const LOWER_RETRY_MS = 30 * 60_000;

/** A script run as root through one distro; throws with why it did not. */
export const asRootThrough = async (distro: string, script: string, timeoutMs: number = ORDER_TIMEOUT_MS): Promise<void> => {
    await execBounded("wsl.exe", ["-d", distro, "-u", "root", "--", "sh", "-c", script], { timeoutMs });
};

/** GUEST_PROBE_SCRIPT's output through one distro, as its own user: /proc needs no root. */
export const probeThrough = async (distro: string): Promise<string> =>
    (await execBounded("wsl.exe", ["-d", distro, "--", "sh", "-c", GUEST_PROBE_SCRIPT], { timeoutMs: PROBE_TIMEOUT_MS })).stdout;

export interface GuestDeps {
    readonly read: () => HostMemory | undefined;
    // The running distros, or undefined where WSL cannot be asked.
    readonly running: () => Promise<string[] | undefined>;
    // GUEST_PROBE_SCRIPT's output through one distro, as its own user; throws with why it could not.
    readonly probe: (distro: string) => Promise<string>;
    // A script run as root through one distro (the order's writes); throws with why it did not.
    readonly asRoot: (distro: string, script: string) => Promise<void>;
    readonly now: () => number;
    readonly settleMs: number;
}

// The guest as last read: the probe, when, and through which distro.
export interface Probed {
    readonly probe: GuestProbe;
    readonly at: number;
    readonly distro: string;
}

interface GuestState {
    latest: Probed | undefined;
    lastProbeAt: number;
    hold: OrderHold | undefined;
    lowerRetryAt: number;
    // Each failure to read the guest is said once until a read works again.
    probeFailing: boolean;
    // The distro listed this pass, so a pass lists WSL once whatever it does.
    listing: Promise<string | undefined> | undefined;
}

interface Guest extends GuestDeps {
    readonly log: Log;
    readonly state: GuestState;
}

const firstLine = (message: string): string => message.split("\n")[0] ?? "";
const strandedOrUnread = (probe: GuestProbe | undefined): number | undefined => (probe === undefined ? undefined : strandedOf(probe));

const distroNow = async (guest: Guest): Promise<string | undefined> => {
    guest.state.listing ??= guest.running().then((distros) => cacheDropDistro(distros ?? []));
    return await guest.state.listing;
};

// One read of the guest through `distro`, kept as the latest, the hold brought in line with the order it reads.
const readThrough = async (guest: Guest, distro: string): Promise<GuestProbe | undefined> => {
    const { state } = guest;
    try {
        const probe = parseGuestProbe(await guest.probe(distro));
        state.probeFailing = false;
        if (probe !== undefined) {
            state.latest = { probe, at: guest.now(), distro };
            state.hold = adoptHold(state.hold, probe);
        }
        return probe;
    } catch (error) {
        if (!state.probeFailing) {
            guest.log(`reading the WSL VM's free memory through ${distro} failed: ${firstLine(errorMessage(error))}`);
        }
        state.probeFailing = true;
        return undefined;
    }
};

// Lowers the order from what `before` read and compacts, logging what it gave back; false where it could not.
const lower = async (guest: Guest, distro: string, before: GuestProbe, windows: HostMemory): Promise<boolean> => {
    try {
        await guest.asRoot(distro, orderScript(before.order, LOWERED_ORDER, true));
    } catch (error) {
        guest.state.lowerRetryAt = guest.now() + LOWER_RETRY_MS;
        guest.log(`Windows was low on memory, but lowering the WSL VM's page_reporting_order through ${distro} failed: ${firstLine(errorMessage(error))}`);
        return false;
    }
    guest.state.hold = { from: before.order };
    await sleep(guest.settleMs);
    const afterWindows = guest.read() ?? windows;
    const after = await readThrough(guest, distro);
    guest.log(loweredLine(distro, before.order, { windows, strandedBytes: strandedOf(before) }, { windows: afterWindows, strandedBytes: strandedOrUnread(after) }, guest.settleMs));
    return true;
};

// Puts the kernel's order back where the agent holds it lowered; `stopping` skips the reads around it.
const putBack = async (guest: Guest, why: "stopping" | "recovered", windows: HostMemory): Promise<void> => {
    const { state } = guest;
    const distro = state.hold === undefined ? undefined : await distroNow(guest);
    if (distro === undefined) {
        return;
    }
    // Read again just before: an order someone else set, or a VM restarted with its own, is not the agent's (adoptHold).
    const before = why === "stopping" ? state.latest?.probe : await readThrough(guest, distro);
    const held = state.hold;
    if (held === undefined) {
        return;
    }
    try {
        await guest.asRoot(distro, orderScript(LOWERED_ORDER, held.from, false));
    } catch (error) {
        // Tried again once Windows has held its fifth another RESTORE_AFTER_MS, rather than every tick.
        state.hold = { from: held.from };
        guest.log(`putting the WSL VM's page_reporting_order back to ${held.from} through ${distro} failed: ${firstLine(errorMessage(error))}`);
        return;
    }
    state.hold = undefined;
    const beforeFigures = { windows, strandedBytes: strandedOrUnread(before) };
    if (why === "stopping") {
        guest.log(restoredLine(distro, held.from, why, beforeFigures));
        return;
    }
    await sleep(guest.settleMs);
    const afterWindows = guest.read() ?? windows;
    const after = await readThrough(guest, distro);
    guest.log(restoredLine(distro, held.from, why, beforeFigures, { windows: afterWindows, strandedBytes: strandedOrUnread(after) }, guest.settleMs));
};

export interface GuestSide {
    // A new pass: WSL is listed again the first time this pass needs it.
    readonly begin: () => void;
    // The distro to act through, listed once a pass: undefined where nothing runs.
    readonly distroNow: () => Promise<string | undefined>;
    // The kernel's order put back once Windows has held over a fifth of its memory long enough (restoreStep).
    readonly restoreIfDue: (windows: HostMemory) => Promise<void>;
    // The guest read when due (probeDue), else as last read: undefined where nothing runs or could be read.
    readonly guest: (windows: HostMemory, lowSince: number | undefined) => Promise<Probed | undefined>;
    // Lowers the order when shouldLowerOrder says so; true when it did.
    readonly lowerIfDue: (windows: HostMemory, probed: Probed | undefined, dropDue: boolean) => Promise<boolean>;
    // The heartbeat's figure for the latest read.
    readonly guestFree: () => GuestFreeMemory | undefined;
    // Puts the order back if held: the agent is stopping.
    readonly stop: (windows: HostMemory | undefined) => Promise<void>;
}

export const guestSide = (log: Log, deps: GuestDeps): GuestSide => {
    const guest: Guest = {
        ...deps,
        log,
        state: { latest: undefined, lastProbeAt: Number.NEGATIVE_INFINITY, hold: undefined, lowerRetryAt: Number.NEGATIVE_INFINITY, probeFailing: false, listing: undefined },
    };
    const { state, now } = guest;
    return {
        begin: () => {
            state.listing = undefined;
        },
        distroNow: async () => await distroNow(guest),
        restoreIfDue: async (windows) => {
            const step = restoreStep(state.hold, windows, now());
            state.hold = step.hold;
            if (step.restore) {
                await putBack(guest, "recovered", windows);
            }
        },
        guest: async (windows, lowSince) => {
            if (!probeDue(windows, lowSince, state.hold, state.lastProbeAt, now())) {
                return state.latest;
            }
            state.lastProbeAt = now();
            state.latest = undefined;
            const distro = await distroNow(guest);
            if (distro !== undefined) {
                await readThrough(guest, distro);
            }
            return state.latest;
        },
        lowerIfDue: async (windows, probed, dropDue) =>
            probed !== undefined && now() >= state.lowerRetryAt && shouldLowerOrder(windows, probed.probe, state.hold, dropDue) && (await lower(guest, probed.distro, probed.probe, windows)),
        guestFree: () => (state.latest === undefined ? undefined : guestFreeOf(state.latest.probe, state.latest.at, state.hold)),
        stop: async (windows) => {
            state.listing = undefined;
            if (state.hold !== undefined && windows !== undefined) {
                await putBack(guest, "stopping", windows);
            }
        },
    };
};
