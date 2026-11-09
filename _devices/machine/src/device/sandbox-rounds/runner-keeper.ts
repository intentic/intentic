import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { execBounded } from "@intentic/base/process";
import type { Log } from "@intentic/local-agent";
import { icPowerArgs } from "@intentic/sandbox-contract/schemas/devices";
import { RUNNER_LINK_PATH, type RunnerLinkReading, RunnerLinkReadingSchema } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { type IcRun, lastLine } from "./ic-rounds.js";

/* THE RUNNERS' KEEPER (2026-11-09). A runner is a sandbox container this machine runs for a parent sandbox elsewhere: the
   parent dispatches turns to it over the one socket the runner dials out. The keeper left runners out of its care
   ("runners belong to a parent sandbox, which brings them back itself"), and nothing did bring them back: the parent
   cannot reach the machine's Docker, and only sees the socket go quiet. So runner-omen, put to sleep by this keeper's own
   idle sweep on 2026-10-31, read "offline" on its parent until it was removed, and runner-radarsu-omen-runner, its
   container running and its daemon answering, never dialled its parent again after 2026-11-05T10:34.

   So this machine keeps its runners the way it keeps a person's sandbox, by the one signal that matters for a runner:
   its link. Once a minute, for every runner this side of the computer keeps:
   - a container that is not running (stopped, asleep, exited) is started;
   - a running one whose link (runner-protocol.ts RUNNER_LINK_PATH, which the runner writes) has been down for ten
     minutes of this keeper watching, while its parent answers this machine, is restarted. A parent that does not answer
     the machine either is asleep, restarting or gone, and a restart would not help: the runner keeps dialling on its own.
     A runner whose parent refused it is said once and left alone (only re-pairing helps), and so is one still running
     work a restart would cut.
   After a start or restart that did not bring the link back, the next waits longer (ten minutes, doubling to four hours),
   so a parent gone for good costs a restart every few hours, not a storm. A runner from before the reading exists says
   nothing about its link, and is only kept running. */

// How often the runners are looked at: a docker read per runner, too dear for every keeper tick.
export const RUNNER_LOOK_EVERY_MS = 60_000;
// How long a runner's link may stay down, watched by this keeper, before it is restarted: past a parent's restart or update.
export const RUNNER_DOWN_RESTART_MS = 10 * 60_000;
// The longest gap between two looks that still counts as watching. Past it this machine slept (a laptop lid, Windows'
// standby), and the runner is given the whole window again to find its parent after the wake, as it does on its own.
export const RUNNER_WATCH_GAP_MS = 3 * 60_000;
// A reading older than this is a daemon that stopped writing it (it writes one a minute): hung, or not there.
export const RUNNER_READING_STALE_MS = 3 * 60_000;
// After a start or restart that did not bring the runner back: 10 minutes, doubling to 4 hours.
const RETRY_FIRST_MS = 10 * 60_000;
const RETRY_MAX_MS = 4 * 60 * 60_000;
// How long asking the parent from this machine may take.
const PARENT_ASK_MS = 10_000;

export const runnerRetryMs = (tries: number): number => (tries <= 0 ? 0 : Math.min(RETRY_FIRST_MS * 2 ** (tries - 1), RETRY_MAX_MS));

// What the keeper remembers of one runner between looks, on its own clock.
export interface RunnerWatch {
    // The look that first found its link down in the current stretch of watching; undefined while it is up.
    downSince?: number | undefined;
    lastLook?: number | undefined;
    // Starts and restarts that have not brought it back, and when the next may be made.
    tries: number;
    retryAt: number;
}

export interface RunnerKeeperState {
    dueAt: number;
    readonly watches: Map<string, RunnerWatch>;
    // The last line said per runner, so a standing verdict is said once.
    readonly said: Map<string, string>;
}

export const newRunnerKeeperState = (start: number): RunnerKeeperState => ({ dueAt: start, watches: new Map(), said: new Map() });

// What one look decides. `ask-parent` is a restart that waits on whether the parent answers this machine.
export type RunnerVerdict =
    | { readonly kind: "up" }
    | { readonly kind: "unknown" }
    | { readonly kind: "start" }
    | { readonly kind: "restart"; readonly why: string }
    | { readonly kind: "ask-parent"; readonly parent: string; readonly downForMs: number }
    | { readonly kind: "wait"; readonly why?: string };

// One look's decision, and the watch it leaves.
export interface RunnerLook {
    readonly verdict: RunnerVerdict;
    readonly watch: RunnerWatch;
}

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

// One look at one runner: what to do, and the watch it leaves. Pure over the runner's container state, its reading
// (undefined when it wrote none: an image from before it, or a daemon still booting) and the clock.
export const judgeRunner = (running: boolean, reading: RunnerLinkReading | undefined, before: RunnerWatch, now: number): RunnerLook => {
    // A gap in the watching is this machine having slept: whatever was down before it is watched afresh.
    const watched = before.lastLook !== undefined && now - before.lastLook > RUNNER_WATCH_GAP_MS ? { ...before, downSince: undefined } : before;
    const watch: RunnerWatch = { ...watched, lastLook: now };
    if (!running) {
        return now >= watch.retryAt ? { verdict: { kind: "start" }, watch } : { verdict: { kind: "wait" }, watch };
    }
    if (reading === undefined) {
        return { verdict: { kind: "unknown" }, watch: { ...watch, downSince: undefined } };
    }
    const stale = now - reading.at > RUNNER_READING_STALE_MS;
    if (reading.state === "open" && !stale) {
        return { verdict: { kind: "up" }, watch: { lastLook: now, tries: 0, retryAt: 0 } };
    }
    const downSince = watch.downSince ?? now;
    const down: RunnerWatch = { ...watch, downSince };
    const downFor = now - downSince;
    if (reading.revoked === true && !stale) {
        return { verdict: { kind: "wait", why: "its parent refused this runner's enrollment, so only removing it and adding it again from the parent brings it back" }, watch: down };
    }
    if (downFor < RUNNER_DOWN_RESTART_MS || now < watch.retryAt) {
        return { verdict: { kind: "wait" }, watch: down };
    }
    if (stale) {
        return { verdict: { kind: "restart", why: `its daemon has written nothing about its link for ${minutes(now - reading.at)}` }, watch: down };
    }
    if (reading.working > 0) {
        return { verdict: { kind: "wait", why: "its link is down, but work a restart would cut is still running on it" }, watch: down };
    }
    return { verdict: { kind: "ask-parent", parent: reading.parent, downForMs: downFor }, watch: down };
};

// The watch after a start or restart was made, whatever came of it: the next waits out the ladder, and the link is
// watched afresh from now.
const afterAttempt = (watch: RunnerWatch, now: number): RunnerWatch => {
    const tries = watch.tries + 1;
    return { ...watch, tries, retryAt: now + runnerRetryMs(tries), downSince: now };
};

// One runner as the keeper's listing has it.
export interface RunnerRow {
    readonly slug: string;
    readonly container: string;
}

// A runner's slug (ic: runner.rs SLUG_PREFIX).
export const isRunner = (slug: string): boolean => slug.startsWith("runner-");

// The runners this side of the computer keeps, from the keeper's last listing that answered. Pure.
export const keptRunners = (
    listed: readonly { readonly slug: string; readonly container?: string | undefined; readonly keptElsewhere?: string | undefined }[] | undefined,
): RunnerRow[] =>
    (listed ?? []).flatMap((row) =>
        isRunner(row.slug) && row.keptElsewhere === undefined ? [{ slug: row.slug, container: row.container ?? `intentic-sandbox-${row.slug}` }] : [],
    );

// Everything the round reads or runs, injected so its decisions are asserted without docker, a parent or an ic.
export interface RunnerKeeperSeams {
    // Whether the container runs now (undefined when docker did not answer: nothing is decided on that).
    readonly running: (container: string) => Promise<boolean | undefined>;
    // The runner's reading of its link, or undefined when it wrote none.
    readonly reading: (container: string) => Promise<RunnerLinkReading | undefined>;
    // Whether the parent answers this machine (its /health).
    readonly parentAnswers: (parent: string) => Promise<boolean>;
    readonly power: (op: "start" | "restart", slug: string) => Promise<IcRun>;
    readonly busy: ReadonlySet<string>;
    readonly hold: (slug: string) => () => void;
    readonly now: () => number;
}

const sayOnce = (state: RunnerKeeperState, slug: string, line: string, log: Log): void => {
    if (state.said.get(slug) !== line) {
        state.said.set(slug, line);
        log(line);
    }
};

const act = async (
    state: RunnerKeeperState,
    seams: RunnerKeeperSeams,
    row: RunnerRow,
    op: "start" | "restart",
    because: string,
    watch: RunnerWatch,
    log: Log,
): Promise<RunnerWatch> => {
    log(`keeper ${row.slug}: ${because}; ${op === "start" ? "starting" : "restarting"} the runner`);
    const release = seams.hold(row.slug);
    let run: IcRun;
    try {
        run = await seams.power(op, row.slug);
    } catch (error) {
        run = { code: 1, output: errorMessage(error) };
    } finally {
        release();
    }
    const after = afterAttempt(watch, seams.now());
    const next = minutes(runnerRetryMs(after.tries));
    const line =
        run.code === 0
            ? `keeper ${row.slug}: ${op === "start" ? "started" : "restarted"}; if its link is not back, the next try waits ${next}`
            : `keeper ${row.slug}: the ${op} failed (${lastLine(run.output)?.trim() ?? `ic exited with ${run.code}`}); trying again in ${next}`;
    state.said.set(row.slug, line);
    log(line);
    return after;
};

// One runner: looked at, and started or restarted when its verdict says so.
const keepRunner = async (state: RunnerKeeperState, seams: RunnerKeeperSeams, row: RunnerRow, log: Log): Promise<void> => {
    const running = await seams.running(row.container);
    if (running === undefined) {
        return;
    }
    const reading = running ? await seams.reading(row.container) : undefined;
    const now = seams.now();
    const { verdict, watch } = judgeRunner(running, reading, state.watches.get(row.slug) ?? { tries: 0, retryAt: 0 }, now);
    state.watches.set(row.slug, watch);
    switch (verdict.kind) {
        case "up":
            if (state.said.has(row.slug)) {
                state.said.delete(row.slug);
                log(`keeper ${row.slug}: the runner is linked to its parent again`);
            }
            return;
        case "unknown":
            return;
        case "wait":
            if (verdict.why !== undefined) {
                sayOnce(state, row.slug, `keeper ${row.slug}: ${verdict.why}`, log);
            }
            return;
        case "start":
            state.watches.set(row.slug, await act(state, seams, row, "start", "the runner's container is not running (asleep, stopped or exited)", watch, log));
            return;
        case "restart":
            state.watches.set(row.slug, await act(state, seams, row, "restart", verdict.why, watch, log));
            return;
        case "ask-parent": {
            const answers = await seams.parentAnswers(verdict.parent);
            if (!answers) {
                sayOnce(
                    state,
                    row.slug,
                    `keeper ${row.slug}: its link to ${verdict.parent} is down, and that sandbox does not answer this machine either (asleep, restarting or gone); the runner keeps dialling it`,
                    log,
                );
                return;
            }
            const because = `its link to ${verdict.parent} has been down for ${minutes(verdict.downForMs)} while that sandbox answers this machine`;
            state.watches.set(row.slug, await act(state, seams, row, "restart", because, watch, log));
            return;
        }
    }
};

// Every runner this side keeps, once a minute, one at a time; a runner a flow of this process is touching (its own
// removal, an update) is left alone, and one that left the listing takes its watch with it.
export const runRunnerRound = async (state: RunnerKeeperState, seams: RunnerKeeperSeams, rows: readonly RunnerRow[], log: Log): Promise<void> => {
    if (seams.now() < state.dueAt) {
        return;
    }
    state.dueAt = seams.now() + RUNNER_LOOK_EVERY_MS;
    const here = new Set(rows.map((row) => row.slug));
    for (const slug of [...state.watches.keys(), ...state.said.keys()]) {
        if (!here.has(slug)) {
            state.watches.delete(slug);
            state.said.delete(slug);
        }
    }
    for (const row of rows) {
        if (!seams.busy.has(row.slug)) {
            await keepRunner(state, seams, row, log);
        }
    }
};

/* THE SEAMS AS THIS MACHINE HAS THEM. */

const DOCKER_READ_MS = 15_000;

const containerRunning = async (container: string): Promise<boolean | undefined> => {
    try {
        const { stdout } = await execBounded("docker", ["inspect", "--format", "{{.State.Running}}", container], { timeoutMs: DOCKER_READ_MS });
        return stdout.trim() === "true";
    } catch {
        // allow(silent-catch): a docker that does not answer decides nothing; the next look asks again
        return undefined;
    }
};

const linkReading = async (container: string): Promise<RunnerLinkReading | undefined> => {
    try {
        const { stdout } = await execBounded("docker", ["exec", container, "cat", RUNNER_LINK_PATH], { timeoutMs: DOCKER_READ_MS });
        return parseJsonWith(stdout.trim(), RunnerLinkReadingSchema);
    } catch {
        // allow(silent-catch): no reading is an image from before it, or a daemon still booting: the link is not judged
        return undefined;
    }
};

// Any answer from the parent's daemon: a sandbox asleep or gone answers its address with an error, or nothing.
const parentAnswersFromHere = async (parent: string): Promise<boolean> => {
    try {
        const response = await fetch(new URL("/health", parent), { signal: AbortSignal.timeout(PARENT_ASK_MS), redirect: "manual" });
        await response.body?.cancel();
        return response.ok;
    } catch {
        // allow(silent-catch): unreachable is the answer
        return false;
    }
};

export const machineRunnerSeams = (
    runIc: (args: readonly string[]) => Promise<IcRun>,
    busy: ReadonlySet<string>,
    hold: (slug: string) => () => void,
): RunnerKeeperSeams => ({
    running: containerRunning,
    reading: linkReading,
    parentAnswers: parentAnswersFromHere,
    power: async (op, slug) => await runIc(icPowerArgs(op, slug)),
    busy,
    hold,
    now: Date.now,
});
