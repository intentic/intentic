import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import { type IcRun, lastLine, newRoundState, type RoundState, type Rounds, runRound, startRounds, ticksToSkip } from "./ic-rounds.js";
import { readSwapRecords, type SwapRecord } from "./swap-records.js";
import { icInFlight, runIc } from "../tools/sandboxes.js";

// THE PROBATION WATCH: `ic sandbox watch` finishes or undoes a swap that was interrupted (the agent restarted, the
// machine rebooted between parking the old container and starting the new one) and judges a new version on probation,
// going back to the previous one by itself when the new one keeps crashing. ic decides all of it; this keeps the clock.
// Every minute it asks about the sandboxes whose record says a swap is in flight or on probation; once, shortly after
// start (a reboot mid-swap leaves exactly that), and every ten minutes regardless, it asks about every sandbox.

// A swap's outcome matters within minutes: the sandbox is down until the watch acts.
const WATCH_EVERY_MS = 60_000;
// Soon after start, when an interrupted swap is most likely waiting, but after the machine's docker has come up.
const SWEEP_FIRST_MS = 30_000;
const SWEEP_EVERY_MS = 10 * 60_000;

export const watchArgs = (slug?: string): string[] => ["sandbox", "watch", ...(slug === undefined ? [] : [slug]), "--json"];

// The sandboxes this minute's watch asks about: each whose record names a phase, except one a flow of this process is
// touching, which is that flow's to finish.
export const watchTargets = (records: readonly SwapRecord[], busy: ReadonlySet<string>): string[] =>
    records.filter((record) => record.phase !== undefined && !busy.has(record.slug)).map((record) => record.slug);

// One line of `ic sandbox watch --json`. `action` is ic's word (none, watching, restored, rolled-back, kept, busy), read
// as a string so one a newer ic adds is still reported.
const WatchAnswerSchema = z.object({ slug: z.string(), action: z.string(), reason: z.string().optional() });
export type WatchAnswer = z.infer<typeof WatchAnswerSchema>;

const watchAnswer = (line: string): WatchAnswer | undefined => {
    try {
        const parsed = WatchAnswerSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is ic's progress prose, which says nothing a line below does not
        return undefined;
    }
};

export const watchAnswers = (output: string): WatchAnswer[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map(watchAnswer)
        .filter((answer) => answer !== undefined);

// The two answers that describe a standing state rather than something the watch did: said when they begin, not every
// minute they last.
const STANDING = new Set(["watching", "busy"]);

// What is worth a line: everything but "none", a standing answer only when it is news for that sandbox. `last` is the
// previous answer per slug, updated here.
export const watchNews = (answers: readonly WatchAnswer[], last: Map<string, string>): string[] =>
    answers.flatMap((answer) => {
        const before = last.get(answer.slug);
        last.set(answer.slug, answer.action);
        if (answer.action === "none" || (STANDING.has(answer.action) && before === answer.action)) {
            return [];
        }
        return [`probation watch ${answer.slug}: ${answer.action}${answer.reason === undefined ? "" : ` — ${answer.reason}`}`];
    });

// The sweep over every sandbox, when it is due and nothing of this process holds a sandbox (ic would wait for that
// flow's lock and hold the minute's watch with it). Pure, so the cadence is asserted without a clock.
export const sweepDue = (dueAt: number, now: number, busy: ReadonlySet<string>): boolean => now >= dueAt && busy.size === 0;

interface WatchState {
    readonly slugs: RoundState;
    readonly last: Map<string, string>;
    sweepDueAt: number;
    // Sweeps failed in a row: each one waits longer for the next, as a failing slug does (an ic without `watch` would
    // otherwise say so every ten minutes for good).
    sweepFailures: number;
}

// One minute's watch. `sweeps` is whether this environment runs the sweep at all (every environment does, over its own
// sandboxes; see resident.ts).
export const runWatchRound = async (
    state: WatchState,
    records: readonly SwapRecord[],
    watch: (slug: string | undefined) => Promise<IcRun>,
    log: Log,
    { now, sweeps, busy = icInFlight }: { readonly now: number; readonly sweeps: boolean; readonly busy?: ReadonlySet<string> },
): Promise<void> => {
    if (sweeps && sweepDue(state.sweepDueAt, now, busy)) {
        const run = await watch(undefined);
        state.sweepFailures = run.code === 0 ? 0 : state.sweepFailures + 1;
        state.sweepDueAt = now + SWEEP_EVERY_MS * (1 + ticksToSkip(state.sweepFailures));
        if (run.code !== 0) {
            log(
                `probation watch: the sweep over every sandbox failed (attempt ${state.sweepFailures}, next in ${(SWEEP_EVERY_MS * (1 + ticksToSkip(state.sweepFailures))) / 60_000} minutes) — ${lastLine(run.output) ?? "no output"}`,
            );
        }
        for (const line of watchNews(watchAnswers(run.output), state.last)) {
            log(line);
        }
        return;
    }
    const said = (_slug: string, run: IcRun): string | undefined => {
        const lines = watchNews(watchAnswers(run.output), state.last);
        return lines.length === 0 ? undefined : lines.join("\n");
    };
    await runRound(state.slugs, watchTargets(records, busy), { name: "probation watch", run: watch, said }, log, busy);
};

export const newWatchState = (now: number): WatchState => ({ slugs: newRoundState(), last: new Map(), sweepDueAt: now + SWEEP_FIRST_MS, sweepFailures: 0 });

// Every minute, the first one half a minute after start so the first sweep lands then.
export const startProbationWatch = (log: Log, { sweeps }: { readonly sweeps: boolean }): Rounds => {
    const state = newWatchState(Date.now());
    return startRounds(
        "probation watch",
        log,
        SWEEP_FIRST_MS,
        () => WATCH_EVERY_MS,
        async () =>
            await runWatchRound(
                state,
                await readSwapRecords(),
                async (slug) => await runIc(watchArgs(slug), () => undefined),
                log,
                { now: Date.now(), sweeps },
            ),
    );
};
