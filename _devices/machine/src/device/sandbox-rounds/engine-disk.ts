import { errorMessage } from "@intentic/base/errors";
import { sizeLabel } from "@intentic/base/format";
import { parseJsonWith } from "@intentic/base/json";
import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import { readMachineConfig } from "../../environments/machine.js";
import { type IcRun, lastLine, type Rounds, startRounds } from "./ic-rounds.js";
import { runIc } from "../tools/sandboxes.js";

/* THE ENGINE'S DISK (2026-11-03). On a Windows PC every sandbox and every compose project its owner runs on the intentic
   engine writes to one disk inside the engine's distro. On rog, 2026-11-03, one sandbox's history volume (462 GB of Rust
   build output) filled it and an unrelated Postgres of the owner's PANICked on ENOSPC and stayed down, with nothing said
   anywhere: WSL's and Windows' own tools show other disks, each sandbox's disk watch can clean only its own checkouts,
   and the daily tidy came too late. So the Windows side watches it. ic does the measuring and the clearing
   (`ic engine disk`, ic's src/engine/disk.rs); this keeps the clock and tells:
   - every minute, the cheap reading (one `df` in the distro): the level, `ok`, `low` (under 10% left to write),
     `critical` (under 5%) or `full` (less than the ballast the engine's keeper holds back);
   - on each level crossed upwards, and again every RELIEVE_AGAIN_MS while it stands at critical or full, ic clears what
     is nobody's data for that level (`--relieve`: build cache and dangling images, and at full the ballast). Never a
     volume. The `updates --disk` switch turns that clearing off; the watch and the word stay;
   - on each level crossed upwards, one line to the owner in this agent's log, naming what takes the space and whose it
     is. Docker takes minutes to size every volume (more than ten on rog), so the line names the last measurement ic kept
     (`--kept`) and a fresh one is made in the background; when the line had none young enough, the fresh one is said
     when it lands. Back to ok is said once, and the next crossing is told again: a disk that hovers is said once per
     stretch, not every minute, as the sandboxes' own disk watch does. */

const FIRST_MS = 2 * 60_000;
const EVERY_MS = 60_000;
// An engine that is not this PC's, not running, or an ic that cannot read it: asked again now and then, not every minute.
const IDLE_EVERY_MS = 10 * 60_000;
// While the disk stands at critical or full, what builds and pulls leave behind meanwhile is cleared this often.
export const RELIEVE_AGAIN_MS = 15 * 60_000;
// A measurement of what takes the space older than this is measured again, and is not young enough to name unsaid.
export const CONSUMERS_STALE_MS = 6 * 60 * 60_000;
// A measurement that failed is tried again after this long: one that ran into ic's thirty minutes and was tried again
// hourly would keep the disk busy half the time it is short.
export const MEASURE_RETRY_MS = 3 * 60 * 60_000;
// The cheap reading answers in a second; a WSL that hangs must not hold the round.
const READ_DEADLINE_MS = 2 * 60_000;
// Up to three prunes, each bounded by ic at ten minutes.
const RELIEF_DEADLINE_MS = 32 * 60_000;
// ic bounds Docker's sizing at thirty minutes.
const MEASURE_DEADLINE_MS = 35 * 60_000;
// How many consumers a line names.
const NAMED = 3;

export const diskReadArgs = (): string[] => ["engine", "disk", "--json"];

// `--consumers --kept` names the last measurement and never waits for one.
export const diskActArgs = ({ relieve, tell }: { readonly relieve: boolean; readonly tell: boolean }): string[] => [
    ...diskReadArgs(),
    ...(relieve ? ["--relieve"] : []),
    ...(tell ? ["--consumers", "--kept"] : []),
];

export const diskMeasureArgs = (): string[] => [...diskReadArgs(), "--consumers", "--max-age", String(CONSUMERS_STALE_MS / 60_000)];

const LEVELS = ["ok", "low", "critical", "full"] as const;
export type DiskLevel = (typeof LEVELS)[number];
const rank = (level: DiskLevel): number => LEVELS.indexOf(level);
const worse = (a: DiskLevel, b: DiskLevel): DiskLevel => (rank(a) >= rank(b) ? a : b);

// What `ic engine disk --json` answers. `state` is ic's word (measured, notOurs, stopped, unreadable), read as a string so
// a new one is still said.
const DiskAnswerSchema = z.object({
    state: z.string(),
    reason: z.string().optional(),
    level: z.enum(LEVELS).optional(),
    totalBytes: z.number().optional(),
    availableBytes: z.number().optional(),
    consumers: z.array(z.object({ what: z.string(), bytes: z.number() })).optional(),
    consumersAt: z.number().optional(),
    consumersUnread: z.string().optional(),
    relieved: z.array(z.object({ what: z.string(), bytes: z.number() })).default([]),
    failed: z.array(z.object({ what: z.string(), reason: z.string() })).default([]),
    before: z.object({ level: z.enum(LEVELS), availableBytes: z.number() }).optional(),
});
export type DiskAnswer = z.infer<typeof DiskAnswerSchema>;

// ic's answer: its last line that reads as one.
export const diskAnswer = (output: string): DiskAnswer | undefined =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => parseJsonWith(line, DiskAnswerSchema))
        .findLast((answer) => answer !== undefined);

// A measured answer's space, or undefined for one that says nothing measurable.
interface Space {
    readonly level: DiskLevel;
    readonly totalBytes: number;
    readonly availableBytes: number;
}

const spaceOf = (answer: DiskAnswer | undefined): Space | undefined =>
    answer?.state === "measured" && answer.level !== undefined && answer.totalBytes !== undefined && answer.availableBytes !== undefined
        ? { level: answer.level, totalBytes: answer.totalBytes, availableBytes: answer.availableBytes }
        : undefined;

const leftText = (available: number, total: number): string =>
    `${sizeLabel(available)} of ${sizeLabel(total)} left to write (${Math.floor((available * 100) / Math.max(total, 1))}%)`;

const ageText = (ms: number): string => (ms < 2 * 60 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / (60 * 60_000))} h`);

// The biggest few, each with its size. Pure.
export const consumersText = (consumers: readonly { readonly what: string; readonly bytes: number }[]): string =>
    consumers
        .slice(0, NAMED)
        .map((consumer) => `${consumer.what} ${sizeLabel(consumer.bytes)}`)
        .join(", ");

// What relief did, as the rest of a sentence: what went and how much is left after, and what would not go. Pure.
const reliefText = (after: DiskAnswer): string => {
    const cleared = after.relieved.filter((step) => step.bytes > 0);
    const space = spaceOf(after);
    const went =
        cleared.length === 0
            ? ""
            : ` Cleared ${cleared.map((step) => `${step.what} ${sizeLabel(step.bytes)}`).join(", ")}${space === undefined ? "" : `: ${sizeLabel(space.availableBytes)} left`}.`;
    const stuck = after.failed.length === 0 ? "" : ` Could not clear ${after.failed.map((step) => `${step.what} (${step.reason})`).join(", ")}.`;
    return `${went}${stuck}`;
};

// The one line a level crossed is told in. `read` is the minute's reading, `after` what the relief and the kept
// measurement answered (undefined when that run failed). Pure.
export const tellLine = ({
    read,
    after,
    relieving,
    reliefOn,
    now,
}: {
    readonly read: Space;
    readonly after: DiskAnswer | undefined;
    readonly relieving: boolean;
    readonly reliefOn: boolean;
    readonly now: number;
}): string => {
    const head = `engine disk: ${read.level} — ${leftText(read.availableBytes, read.totalBytes)}.`;
    const relief = relieving && after !== undefined ? reliefText(after) : "";
    const off = reliefOn ? "" : " Clearing is off here (intentic-machine updates --disk on).";
    const consumers = after?.consumers ?? [];
    const named =
        consumers.length > 0 && after?.consumersAt !== undefined
            ? ` Biggest: ${consumersText(consumers)} (measured ${ageText(now - after.consumersAt)} ago).`
            : " What takes the space is being measured.";
    return `${head}${relief}${off}${named}`;
};

// A clearing while the level stands, said only when it did something. Pure.
export const stillLine = (level: DiskLevel, after: DiskAnswer | undefined): string | undefined => {
    const relief = after === undefined ? "" : reliefText(after);
    return relief === "" ? undefined : `engine disk: still ${level} —${relief}`;
};

export const backLine = (read: Space): string => `engine disk: back to ok — ${leftText(read.availableBytes, read.totalBytes)}.`;

// What the watch remembers between rounds. In memory: an agent restart during a stretch says its level once more.
export interface DiskWatchState {
    // The worst level told since the disk last had room; "ok" means the next crossing is told.
    told: DiskLevel;
    // The worst level cleared at in this stretch, and when it was last cleared.
    relieved: DiskLevel;
    relievedAt: number;
    // When ic's kept measurement of what takes the space was made, as last heard; when one was last tried.
    consumersAt: number | undefined;
    measureTriedAt: number;
    // A line went out with no measurement young enough: the next one is said when it lands.
    owed: boolean;
    measuring: Promise<void> | undefined;
    // The last sentence of a watch that could not watch, said once.
    unwatched: string | undefined;
}

export const newDiskWatchState = (): DiskWatchState => ({
    told: "ok",
    relieved: "ok",
    relievedAt: Number.NEGATIVE_INFINITY,
    consumersAt: undefined,
    measureTriedAt: Number.NEGATIVE_INFINITY,
    owed: false,
    measuring: undefined,
    unwatched: undefined,
});

// Whether to clear now: a level worse than any cleared at this stretch, or critical or worse and the last clearing old. Pure.
export const reliefDue = (state: DiskWatchState, level: DiskLevel, now: number): boolean =>
    level !== "ok" && (rank(level) > rank(state.relieved) || (rank(level) >= rank("critical") && now - state.relievedAt >= RELIEVE_AGAIN_MS));

// Whether to measure what takes the space in the background: none running, and the kept one old or unknown, and no
// attempt within the retry. Pure.
export const measureDue = (state: DiskWatchState, now: number): boolean =>
    state.measuring === undefined &&
    now - state.measureTriedAt >= MEASURE_RETRY_MS &&
    (state.consumersAt === undefined || now - state.consumersAt > CONSUMERS_STALE_MS);

export interface DiskWatchDeps {
    readonly run: (args: readonly string[], deadlineMs: number) => Promise<IcRun>;
    // The `updates --disk` switch, read only when a clearing would be due.
    readonly reliefOn: () => Promise<boolean>;
    readonly log: Log;
    readonly now: () => number;
}

// A run that throws (no ic at all) answers like one that failed.
const ran = async (deps: DiskWatchDeps, args: readonly string[], deadlineMs: number): Promise<IcRun> => {
    try {
        return await deps.run(args, deadlineMs);
    } catch (error) {
        return { code: 1, output: errorMessage(error) };
    }
};

const sayOnce = (state: DiskWatchState, log: Log, sentence: string): void => {
    if (state.unwatched !== sentence) {
        state.unwatched = sentence;
        log(sentence);
    }
};

const measure = async (state: DiskWatchState, deps: DiskWatchDeps): Promise<void> => {
    const run = await ran(deps, diskMeasureArgs(), MEASURE_DEADLINE_MS);
    const answer = diskAnswer(run.output);
    if (answer?.consumersAt !== undefined) {
        state.consumersAt = answer.consumersAt;
    }
    if (!state.owed || state.told === "ok") {
        return;
    }
    state.owed = false;
    const consumers = answer?.consumers ?? [];
    deps.log(
        consumers.length > 0
            ? `engine disk: what takes the space: ${consumersText(consumers)}.`
            : `engine disk: what takes the space could not be measured — ${answer?.consumersUnread ?? lastLine(run.output) ?? "no answer"}`,
    );
};

// The disk has room: back to ok is said once, and the next crossing is told and cleared again.
const settle = (state: DiskWatchState, log: Log, read: Space): void => {
    if (state.told !== "ok") {
        log(backLine(read));
    }
    state.told = "ok";
    state.relieved = "ok";
    state.owed = false;
};

// A level short of ok: cleared and told as due, in one ic run.
const actOn = async (state: DiskWatchState, deps: DiskWatchDeps, read: Space): Promise<void> => {
    const tell = rank(read.level) > rank(state.told);
    const due = reliefDue(state, read.level, deps.now());
    if (!tell && !due) {
        return;
    }
    const reliefOn = await deps.reliefOn();
    const relieve = due && reliefOn;
    if (!relieve && !tell) {
        return;
    }
    const after = diskAnswer((await ran(deps, diskActArgs({ relieve, tell }), RELIEF_DEADLINE_MS)).output);
    if (relieve) {
        state.relieved = worse(state.relieved, read.level);
        state.relievedAt = deps.now();
    }
    if (after?.consumersAt !== undefined) {
        state.consumersAt = after.consumersAt;
    }
    if (tell) {
        state.told = read.level;
        state.owed = after?.consumersAt === undefined || deps.now() - after.consumersAt > CONSUMERS_STALE_MS;
        deps.log(tellLine({ read, after, relieving: relieve, reliefOn, now: deps.now() }));
        return;
    }
    const still = stillLine(read.level, after);
    if (still !== undefined) {
        deps.log(still);
    }
};

// One look at the disk: relieve and tell as due, and measure what takes it in the background when that is old.
// Answers how long until the next look.
export const diskRound = async (state: DiskWatchState, deps: DiskWatchDeps): Promise<number> => {
    const run = await ran(deps, diskReadArgs(), READ_DEADLINE_MS);
    const answer = diskAnswer(run.output);
    const read = spaceOf(answer);
    if (read === undefined) {
        sayOnce(
            state,
            deps.log,
            answer === undefined
                ? `engine disk: ic could not read the engine's disk — ${lastLine(run.output) ?? "no output"}`
                : `engine disk: not watched — ${answer.reason ?? answer.state}`,
        );
        return IDLE_EVERY_MS;
    }
    state.unwatched = undefined;
    if (read.level === "ok") {
        settle(state, deps.log, read);
        return EVERY_MS;
    }
    await actOn(state, deps, read);
    if (measureDue(state, deps.now())) {
        state.measureTriedAt = deps.now();
        state.measuring = measure(state, deps).finally(() => {
            state.measuring = undefined;
        });
    }
    return EVERY_MS;
};

// The Windows side's watch (resident.ts starts it there alone: one engine per PC, and one watch of it).
export const startEngineDiskWatch = (log: Log): Rounds => {
    const state = newDiskWatchState();
    const deps: DiskWatchDeps = {
        run: async (args, deadlineMs) => await runIc(args, () => undefined, {}, { deadlineMs }),
        // A config that does not read throws, and the round is skipped: it may be the one holding the clearing off.
        reliefOn: async () => (await readMachineConfig()).engineDiskRelief !== false,
        log,
        now: Date.now,
    };
    let next = EVERY_MS;
    return startRounds("engine disk", log, FIRST_MS, () => next, async () => {
        next = IDLE_EVERY_MS;
        next = await diskRound(state, deps);
    });
};
