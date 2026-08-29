import { readFile } from "node:fs/promises";
import { parsePressure } from "./loop-watchdog.js";

/* WHETHER THIS SANDBOX HAS THE MEMORY TO START ANOTHER TURN.
 *
 * The daemon has always MEASURED this and never acted on it. platform/resource-metrics.ts samples
 * memory.current, memory.max and memory.events once a minute into resource-metrics.jsonl, so the numbers that
 * describe an exhausted box were already on disk during the incident that prompted this file: a cgroup pinned
 * at its ceiling, 5.3M allocation stalls, every task inside stalled ~87% of wall-clock. Nothing read them in
 * time to refuse the work that was still arriving, so turns kept being admitted onto a box with nothing left to
 * run them with, and each new one made the box worse for the ones already there.
 *
 * A SAMPLE IS TOO OLD TO ADMIT ON, which is why this reads its own numbers rather than taking the sampler's
 * latest snapshot. A `turbo` fan-out moves a box from comfortable to pinned in seconds, and a minute-old
 * reading would wave through a whole minute of turns into a box that no longer exists. Three small reads of
 * files the kernel keeps in memory is cheap enough to do per turn, and it is the only way the answer is about
 * NOW.
 *
 * A REFUSAL HERE IS A VALUE, not an exception: it becomes turn-plan.ts's TurnRefusal, which the route renders
 * as one error frame, exactly as "no subscription connected" or "context window too small" already do. The user
 * is told the box is full and what to do about it, which is a better turn than one admitted into a livelock. */

/* THE CGROUP'S OWN FILES, ALL THREE, and the third one is the one that is easy to get wrong.
 *
 * Neither /proc/meminfo nor /proc/pressure/memory is namespaced: inside a container both report the HOST, and
 * a sandbox reading them learns about a machine it does not own. Measured on the box this was written for,
 * with the sandbox capped at 10 GiB inside a 19.5 GiB guest: /proc/pressure/memory read `total=2639873306`
 * from inside the container and `total=2639873306` from the host — the same counter — while
 * /sys/fs/cgroup/memory.pressure read `total=8364085`, which is this cgroup's own.
 *
 * That is exactly the blind spot that makes a userspace early-OOM daemon (earlyoom and friends) useless in
 * here: it polls /proc/meminfo, sees the guest's free memory, and sits idle while the cgroup it lives in
 * strangles at a ceiling it cannot see. The daemon must read the cgroup, or it is doing the same thing. */
const MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";
const MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const MEMORY_PRESSURE = "/sys/fs/cgroup/memory.pressure";

export interface MemoryHeadroom {
    // The cgroup ceiling, or undefined when this sandbox is uncapped (the hosted shape) or cgroup v2 is not
    // mounted where it is expected (a dev daemon on macOS). Both mean "this gate has nothing to say".
    readonly limitBytes: number | undefined;
    readonly usedBytes: number | undefined;
    readonly freeBytes: number | undefined;
    // Memory PSI, `full avg10`: the share of the last ten seconds in which EVERY task was stalled waiting on
    // memory. 0 on a healthy box; it was between 80 and 98 for the hour the incident lasted.
    readonly stalledPercent: number;
}

// `max` is cgroup v2's spelling for "no limit"; anything unreadable is a daemon that cannot see its own cgroup.
// Both collapse to undefined rather than to a number, so an unknown ceiling never reads as a small one.
const numericFile = async (path: string): Promise<number | undefined> => {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined || text.trim() === "max") {
        return undefined;
    }
    const parsed = Number(text.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
};

export const readMemoryHeadroom = async (): Promise<MemoryHeadroom> => {
    const [usedBytes, limitBytes, pressureText] = await Promise.all([
        numericFile(MEMORY_CURRENT),
        numericFile(MEMORY_MAX),
        readFile(MEMORY_PRESSURE, "utf8").catch(() => ""),
    ]);
    return {
        limitBytes,
        usedBytes,
        freeBytes: limitBytes === undefined || usedBytes === undefined ? undefined : Math.max(0, limitBytes - usedBytes),
        stalledPercent: parsePressure(pressureText)?.full ?? 0,
    };
};

const GIB = 1024 ** 3;

/* WHAT A TURN NEEDS FREE BEFORE IT MAY START.
 *
 * A turn is not free to admit: it spawns a provider CLI (~200 MiB measured for the Claude runtime alone) and
 * then whatever the agent decides to run, which is the part with no ceiling — the incident's turn ran a build.
 * A gibibyte is the point below which admitting one is a bet that it does nothing, and the whole reason this
 * gate exists is that the bet keeps being lost.
 *
 * AN UNATTENDED TURN IS HELD TO A HIGHER BAR, because it is the one turn nobody is waiting on. A scheduled wake
 * or a background follow-up arriving on a nearly-full box should lose to the person typing into it, and the
 * cheapest way to say that is to make it need twice the room. It is not a fairness rule, it is a triage rule:
 * refusing the unattended turn costs a retry later, refusing the interactive one costs someone their turn. */
const TURN_RESERVE_BYTES = GIB;
const UNATTENDED_RESERVE_BYTES = 2 * GIB;

/* THE STALL BACKSTOP, and on the boxes this daemon actually runs on it is the signal that matters.
 *
 * Every sandbox the run contract creates carries an unbounded swap allowance (@intentic/sandbox-run — measured
 * 2026-08-25, even a no-swap cgroup never got the loud OOM kill; a node-heavy tree is mostly reclaimable
 * file-backed pages, so the failure is the slow one either way). A box under memory pressure does not run out,
 * it GRINDS: `freeBytes` can look survivable while nothing in the container is actually progressing. `full
 * avg10` is what names that state. Twenty percent is well clear of the noise a healthy box makes (0,
 * essentially always) and far below the eighty-plus a genuinely stalled one sits at, so it catches the grind
 * early without firing on a momentary reclaim spike. */
const STALL_REFUSAL_PERCENT = 20;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export type TurnAdmission = { readonly admit: true } | { readonly admit: false; readonly message: string };

/* The verdict, as a pure function of a reading, so the policy is tested without a cgroup to stand in.
 *
 * AN UNKNOWN CEILING ADMITS. A daemon that cannot read its own cgroup (the hosted shape, a dev run on macOS,
 * cgroup v1) knows nothing about how full it is, and a gate that refuses on ignorance would take every turn on
 * every one of those. The measured case is the only one this gate has standing to speak about. */
export const admitTurn = (headroom: MemoryHeadroom, unattended: boolean = false): TurnAdmission => {
    const { freeBytes, limitBytes, usedBytes } = headroom;
    if (freeBytes === undefined || limitBytes === undefined || usedBytes === undefined) {
        return { admit: true };
    }
    /* THE STALL CHECK LIVES INSIDE THE MEASURED CASE, deliberately, even though a pressure reading is available
     * without a ceiling. At the root cgroup — a dev daemon on a laptop, the hosted shape — memory.pressure IS
     * the whole machine's, so gating on it would refuse a developer's turn because something else on their
     * laptop was busy, and would make this daemon's own test suite refuse turns whenever the suite itself made
     * the machine work. Neither is a sandbox running out of room, which is the only thing this gate is entitled
     * to have an opinion about. */
    if (headroom.stalledPercent >= STALL_REFUSAL_PERCENT) {
        return {
            admit: false,
            message: `The sandbox is out of memory and is spending ${Math.round(headroom.stalledPercent)}% of its time waiting for it. Let a running task finish, or close some agent sessions, then send again.`,
        };
    }
    const reserve = unattended ? UNATTENDED_RESERVE_BYTES : TURN_RESERVE_BYTES;
    if (freeBytes >= reserve) {
        return { admit: true };
    }
    const used = `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    return {
        admit: false,
        message: unattended
            ? `Not enough sandbox memory to start a background turn (${used}). It will run once the box has room; nothing is lost.`
            : `Not enough sandbox memory to start this turn (${used}). Close some agent sessions or let a running task finish, then send again. Raise the ceiling with SANDBOX_MEMORY if this machine has room to spare.`,
    };
};

/* WAITING INSTEAD OF REFUSING, for work someone asked for but nobody needs THIS second.
 *
 * A turn is refused outright because its requester is standing there to hear the refusal and try again. The
 * pre-push check is the other shape: the owner clicked push and walked away, so a refusal has no reader — but
 * STARTING the suite onto a pinned box is how the 2026-08-25 freeze happened, a whole-monorepo test run
 * admitted into a cgroup with nothing left, six minutes of daemon event-loop stall, every session sharing the
 * box down with it. The right move is neither: hold the work until the box can actually run it, and say so in
 * the log the whole time.
 *
 * THE WAIT IS BOUNDED, and on exhaustion the work RUNS ANYWAY. This gate exists to dodge a transient peak
 * (another suite draining, an agent's build finishing), not to hand whatever is hogging the box a veto over
 * the owner's push. With the cap machine-sized and swap under it, a run started into lingering pressure now
 * degrades instead of freezing — the wait buys the good case, the deadline caps the bad one.
 *
 * `read` is injectable for the same reason admitTurn is a pure function of a reading: the policy is tested
 * without a cgroup to stand in. */
export interface HeadroomWait {
    readonly admitted: boolean;
    readonly waitedMs: number;
    // The last refusal's wording, for the log line of a run that starts on an exhausted deadline.
    readonly message?: string;
}

const WAIT_INTERVAL_MS = 5_000;
const WAIT_DEADLINE_MS = 5 * 60_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
    });

export const waitForMemoryHeadroom = async (
    options: {
        readonly signal?: AbortSignal;
        readonly intervalMs?: number;
        readonly deadlineMs?: number;
        readonly read?: () => Promise<MemoryHeadroom>;
    } = {},
): Promise<HeadroomWait> => {
    const { signal, intervalMs = WAIT_INTERVAL_MS, deadlineMs = WAIT_DEADLINE_MS, read = readMemoryHeadroom } = options;
    const startedAt = Date.now();
    // Held to the unattended bar: the caller is queued work, and it should lose to the person typing.
    let verdict = admitTurn(await read(), true);
    if (verdict.admit) {
        // The common case pays one reading and reports no wait: a box with room never brushes the interval.
        return { admitted: true, waitedMs: 0 };
    }
    // oxlint-disable-next-line no-unmodified-loop-condition -- `signal.aborted` is flipped by the AbortController, not by this loop; the rule cannot see the external writer.
    while (!verdict.admit && Date.now() - startedAt < deadlineMs && signal?.aborted !== true) {
        await sleep(intervalMs, signal);
        verdict = admitTurn(await read(), true);
    }
    const waitedMs = Date.now() - startedAt;
    return verdict.admit ? { admitted: true, waitedMs } : { admitted: false, waitedMs, message: verdict.message };
};
