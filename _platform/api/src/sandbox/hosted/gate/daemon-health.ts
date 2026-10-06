import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { MINUTE_MS } from "../../../durations.js";
import { execMachine, type FlyMachineDetail, getMachineDetail } from "../fly/fly.js";

/* A NEW VERSION IS KEPT ONCE ITS DAEMON SAYS IT CAME UP, not once Fly says the machine started.
 *
 * The hosted half of ic's readiness wait (_sandbox/ic/src/health.rs), asked the same way, `curl -sf` on the daemon's own
 * `/health` from inside the machine, through Fly's exec: nothing outside the machine reaches its daemon but the tunnel.
 * The wait ends well when the daemon reads ready with its state journal not open (the journal is open from the start
 * of a boot that changed stored files until that boot has converged) and the sandbox has checked in with the platform
 * since the start. It ends badly, and the gate puts the version before back, when:
 * - nothing answers within READY_BUDGET_MS of the start;
 * - the journal reads `failed` (this version could not convert the files, and put them back as they were);
 * - the journal, once seen open, is not seen committed within JOURNAL_BUDGET_MS, silence included, since silence
 *   after an open journal is netd restarting a daemon that fell over mid-conversion;
 * - the machine exits with an error, whether Fly restarts it (on-failure, three times, then stopped) or not, or reads
 *   stopped with no exit to explain it;
 * - the sandbox does not check in with the platform within the budget.
 * A stop someone asked Fly for (a suspension, an operator, the abuse watch) or a clean exit (the daemon's idle-stop)
 * says nothing about the version: when the machine stays down after one, the wait reports it interrupted, and the gate
 * leaves the version on trial for its next start. The hour meter's own stop never lands here (../hosted-meter.ts).
 *
 * Read the way ic reads it: an answer with no `boot` and no `ready` is a daemon too old to report a boot, and reads as
 * ready; one with no `state` is older than the conversion engine, and reads as closed. A daemon that answers, checked
 * in, and is still booting when the ready budget ends with its journal never open is a slow boot rather than a broken
 * one, and is kept, as ic keeps it. */

// The same probe ic runs in the container: the daemon's own health route, on the port it always listens on. Named by
// its path, like the planner's node, so nothing rests on how Fly's exec resolves a bare name.
export const DAEMON_HEALTH_COMMAND = [`/usr/bin/curl`, `-sf`, `--max-time`, `5`, `http://localhost:8787/health`] as const;
const HEALTH_EXEC_SECONDS = 10;
export const HEALTH_POLL_MS = 2_000;
export const READY_BUDGET_MS = 3 * MINUTE_MS;
export const JOURNAL_BUDGET_MS = 10 * MINUTE_MS;
// Fly states a machine passes through on its way up or down; a reading of one is a reason to look again, not a verdict.
const PASSING = new Set([`created`, `starting`, `replacing`, `stopping`, `suspending`]);

// What one answer of `/health` says, read loosely: a field of an unexpected shape is a field that is not there.
const HealthAnswerSchema = z.object({
    ready: z.boolean().optional().catch(undefined),
    boot: z.object({ ready: z.boolean().optional().catch(undefined) }).optional().catch(undefined),
    state: z.object({ journal: z.string().optional().catch(undefined) }).optional().catch(undefined),
});

export interface DaemonHealthAnswer {
    // `boot.ready`, else the top-level `ready` of a daemon older than the boot report, else true.
    readonly ready: boolean;
    readonly journal: "open" | "failed" | "closed";
}

// One answer of `/health`, or undefined when it is not one (empty, not JSON, not an object).
export const readDaemonHealth = (stdout: string): DaemonHealthAnswer | undefined => {
    const text = stdout.trim();
    if (text === ``) {
        return undefined;
    }
    let parsed: z.infer<typeof HealthAnswerSchema>;
    try {
        parsed = HealthAnswerSchema.parse(JSON.parse(text));
    } catch {
        // allow(silent-catch): not JSON or not a /health shape, which is what undefined answers
        return undefined;
    }
    const journal = parsed.state?.journal;
    return {
        ready: (parsed.boot?.ready ?? parsed.ready) !== false,
        journal: journal === `open` || journal === `failed` ? journal : `closed`,
    };
};

export type DaemonVerdict =
    | { readonly kind: `up`; readonly slow: boolean }
    | { readonly kind: `down`; readonly reason: string }
    | { readonly kind: `interrupted`; readonly reason: string };

interface DaemonMachine {
    readonly appName: string;
    readonly machineId: string;
}

// What the machine had said before the start, so only what happens after it counts. `read` is false when Fly would not
// say: then no exit can be told from an earlier one, and only the machine's state is read.
export interface DaemonBaseline {
    readonly read: boolean;
    readonly exitedAt: number | undefined;
    // It was already running: its daemon checked in when it booted, not after this start, so no check-in is waited for.
    readonly running: boolean;
}

export const baselineOf = async (config: Config, machine: DaemonMachine): Promise<DaemonBaseline> => {
    // allow(silent-catch): an unreadable machine leaves no baseline, which `read: false` says to the wait
    const detail = await getMachineDetail(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
    return { read: detail !== undefined, exitedAt: detail?.exitedAt, running: detail?.state === `started` };
};

// What the wait has learned so far.
interface Seen {
    answered: boolean;
    // Some answer said the journal was open; the budget is the journal's from then on.
    journalSeen: boolean;
    // The newest answer said it still is (silence keeps the last word).
    converting: boolean;
    ready: boolean;
    checkedIn: boolean;
}

const minutes = (ms: number): number => Math.round(ms / MINUTE_MS);

/* HOW THE MACHINE ENDED SINCE THE START, in the owner's words; undefined while it runs or is on its way. An exit nobody
 * asked for that was not clean is a crash, whether or not Fly has restarted it. A stop someone asked for, or a clean
 * exit, ends the wait only if the machine stays down (Fly restarts a running machine to apply a config, which is no
 * verdict at all). */
const endOf = (baseline: DaemonBaseline, detail: FlyMachineDetail): DaemonVerdict | undefined => {
    const exited = baseline.read && detail.exitedAt !== undefined && detail.exitedAt !== baseline.exitedAt;
    const asked = detail.requestedStop || (detail.exitCode === 0 && !detail.oomKilled);
    if (exited && !asked) {
        return {
            kind: `down`,
            reason: detail.oomKilled ? `it ran out of memory as it started` : `it exited with status ${detail.exitCode ?? `unknown`} as it started`,
        };
    }
    if (detail.state === `started` || PASSING.has(detail.state)) {
        return undefined;
    }
    return exited
        ? { kind: `interrupted`, reason: `the machine was stopped while its new version was starting` }
        : { kind: `down`, reason: `its machine reads ${detail.state} before the new version was ready` };
};

// Asks the daemon once; undefined when nothing readable answered (a refused exec, curl's failure, a netd answering 503).
const askHealth = async (config: Config, machine: DaemonMachine): Promise<DaemonHealthAnswer | undefined> => {
    // allow(silent-catch): an exec Fly refuses is one more poll with no answer; the budget decides what silence means
    const answer = await execMachine(config.hosted.flyApiToken, machine.appName, machine.machineId, DAEMON_HEALTH_COMMAND, HEALTH_EXEC_SECONDS).catch(
        () => undefined,
    );
    return answer === undefined || answer.exitCode !== 0 ? undefined : readDaemonHealth(answer.stdout);
};

// One look at the machine and its daemon; a verdict when this look decides one.
const look = async (config: Config, machine: DaemonMachine, baseline: DaemonBaseline, seen: Seen): Promise<DaemonVerdict | undefined> => {
    // allow(silent-catch): an unreadable machine is one more poll; its daemon's silence is judged by the budget
    const detail = await getMachineDetail(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
    const ended = detail === undefined ? undefined : endOf(baseline, detail);
    if (ended !== undefined || detail?.state !== `started`) {
        return ended;
    }
    const answer = await askHealth(config, machine);
    if (answer === undefined) {
        return undefined;
    }
    if (answer.journal === `failed`) {
        return { kind: `down`, reason: `it could not convert this sandbox's stored files, and put them back as they were` };
    }
    seen.answered = true;
    seen.converting = answer.journal === `open`;
    seen.journalSeen ||= seen.converting;
    seen.ready = answer.ready && !seen.converting;
    return undefined;
};

// The budget ended with no verdict: what it ran out waiting for, or a slow boot that is kept.
const budgetSpent = (seen: Seen): DaemonVerdict => {
    if (seen.converting) {
        return { kind: `down`, reason: `it was still converting this sandbox's stored files after ${minutes(JOURNAL_BUDGET_MS)} minutes` };
    }
    if (!seen.answered) {
        return { kind: `down`, reason: `its daemon did not answer within ${minutes(READY_BUDGET_MS)} minutes of starting` };
    }
    if (!seen.checkedIn) {
        return { kind: `down`, reason: `it did not check in with the platform within ${minutes(READY_BUDGET_MS)} minutes of starting` };
    }
    return { kind: `up`, slow: true };
};

/* WAITS FOR THE DAEMON THE GATE JUST STARTED. `checkedIn` answers whether the sandbox has checked in since the start
 * (gate-row.ts); without it, as without a row to read, no check-in is waited for. Bounded by the clock and by a count of
 * looks both, so a stubbed sleep cannot spin it. */
export const awaitDaemon = async (
    config: Config,
    machine: DaemonMachine,
    baseline: DaemonBaseline,
    checkedIn: (() => Promise<boolean>) | undefined,
): Promise<DaemonVerdict> => {
    const started = Date.now();
    const seen: Seen = { answered: false, journalSeen: false, converting: false, ready: false, checkedIn: checkedIn === undefined || baseline.running };
    const budget = (): number => (seen.journalSeen ? JOURNAL_BUDGET_MS : READY_BUDGET_MS);
    for (let attempt = 0; attempt < Math.ceil(budget() / HEALTH_POLL_MS) && Date.now() - started < budget(); attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll is sequential by definition
        const verdict = await look(config, machine, baseline, seen);
        if (verdict !== undefined) {
            return verdict;
        }
        if (!seen.checkedIn && checkedIn !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            seen.checkedIn = await checkedIn();
        }
        if (seen.ready && seen.checkedIn) {
            return { kind: `up`, slow: false };
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        await delay(HEALTH_POLL_MS);
    }
    return budgetSpent(seen);
};
