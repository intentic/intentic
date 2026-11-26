import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { errorMessage } from "@intentic/base/errors";
import { sizeLabel } from "@intentic/base/format";
import { parseJsonWith } from "@intentic/base/json";
import { execBounded } from "@intentic/base/process";
import type { Log } from "@intentic/local-agent";
import { type HostMemory, hostMemoryLowBytes } from "@intentic/sandbox-contract/schemas/hosts";
import { z } from "zod";
import { readMachineConfig } from "../../../environments/machine.js";
import { windowsMemory } from "../../../environments/windows-memory.js";
import { thisSide } from "../../../environments/wsl.js";
import { parseMeminfoAvailableMb } from "../../../resident/pause-cause.js";
import type { IcRun } from "../ic-rounds.js";
import type { ListedSandbox } from "../keeper-scope.js";
import { isRunner } from "../runner-keeper.js";
import { refusedFlag, SLEEP_DEADLINE_MS, sleepAnswers } from "../sleep.js";

/* A SANDBOX NOBODY USES, PUT TO SLEEP WHILE THE COMPUTER IS SHORT OF MEMORY (2026-11-26). rog (31.4 GiB) sat under its
   low line for hours while a second sandbox nobody had opened for 15 hours held about 1.9 GB (its daemon 664 MB, a warm
   `devin acp` 156 MB, the rest file cache). The keeper's own sleep (sleep.ts) puts a sandbox to sleep after a fixed
   stretch nobody needed it whatever the computer has; this is the same sleep, asked for one sandbox at a time because
   memory is short:
   - short is the line both sides keep (hosts.ts hostMemoryLowBytes), read where this agent can read the computer's own
     memory: Windows' side (windows-memory.ts) and a Linux host's kernel, never a WSL distro, whose meminfo is the VM's;
   - only once it has held for SHORT_FOR_MS, never on one reading, and only while the `updates --memory` switch is on;
   - quiet is the sandbox's own word, the idle-stop questions its daemon answers in its work signal (/run/intentic/
     work.json, system/quiet-watch.ts in the sandbox): nothing running, no terminal typed in, no app of it open, nothing
     it promised due soon, not kept awake by its own "Sleep when unused", and nobody at an editor connected to it. Here,
     and only here, an editor left open that nobody has been at for half an hour counts as nobody (2026-11-26, the
     owner's call): the daemon says so as `unattendedSince` beside its strict `quietSince`, from when somebody was last
     at it, and ic reads it with `--unattended`. Somebody back at the editor ends it at once, the daemon's last answer
     included; an older daemon says only `quietSince`, which is read as it is;
   - of the sandboxes this side keeps that have been quiet for QUIET_MINUTES, the one quiet longest goes first (least
     recently used), and only while another sandbox runs on this engine: never the only one;
   - ic decides it, as for every sleep: `ic sandbox sleep <slug> --idle 60 --unattended` asks the daemon again just before
     the stop, sets the alarm for what it promised, records it asleep and tells its page, so somebody opening it wakes it
     as any sleeping sandbox wakes (the wake round in sleep.ts). `--reason` puts why in the sandbox's own record of the
     stop (restart-intent.json). An ic from before the two flags is asked without both, and for an hour after: it then
     holds an open editor as somebody there;
   - at most one per look: after a sleep the next look waits SETTLE_MS and reads memory again first, so a second sandbox
     sleeps only if the computer is still short. A look that put nothing to sleep waits LOOK_AGAIN_MS.
   What it did is the keeper's line in this agent's log; why nothing could sleep is said once per stretch. */

// How long the computer stays under its low line before a sandbox is put to sleep for it: minutes, never one reading.
export const SHORT_FOR_MS = 10 * 60_000;
// How long a sandbox must have been quiet, by its own daemon's word. Twice the keeper's own default stretch.
export const QUIET_MINUTES = 60;
const QUIET_MS = QUIET_MINUTES * 60_000;
// After a sleep, how long before memory is read again and another sandbox is considered: what a stopped container
// gives back takes a while to show as Windows' own, and one sleep may be all it needed.
export const SETTLE_MS = 10 * 60_000;
// After a look that put nothing to sleep: each look reads every candidate's signal through docker and may run ic.
export const LOOK_AGAIN_MS = 5 * 60_000;
// ic's WORK_SIGNAL_STALE_MS (fix/chain.rs): an older signal is what a hung daemon left behind.
export const SIGNAL_STALE_MS = 3 * 60_000;
// A promise due within this keeps a sandbox up: ic's longest alarm lead (LEAD_CEILING_MS, ten minutes) and the shortest
// sleep worth taking (MIN_ASLEEP_MS, five). ic decides it on the sandbox's own lead; this only spares asking.
export const WAKE_SOON_MS = 15 * 60_000;
// How long an ic that refused `--unattended` and `--reason` is asked without them.
export const FLAGS_REFUSED_MS = 60 * 60_000;

// Where the daemon writes its work signal (the sandbox's workload/work-signal.ts; ic's fix/chain.rs WORK_SIGNAL).
const WORK_SIGNAL_PATH = "/run/intentic/work.json";
const SIGNAL_READ_MS = 20_000;

// The fields of the work signal this reads; the daemon writes more (its boot's facts), which are left out.
const WorkSignalSchema = z.object({
    liveTurns: z.number().int().nonnegative(),
    at: z.number(),
    quietSince: z.number().optional(),
    unattendedSince: z.number().optional(),
    nextWakeAt: z.number().optional(),
    personAt: z.number().optional(),
    activeAt: z.number().optional(),
    keepAwake: z.boolean().optional(),
});
export type WorkSignal = z.infer<typeof WorkSignalSchema>;

// The signal out of the file's text, undefined for none or one that does not read. Pure.
export const workSignalOf = (text: string | undefined): WorkSignal | undefined => (text === undefined ? undefined : parseJsonWith(text.trim(), WorkSignalSchema));

const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))} min`;

// Since when nobody has needed the sandbox, as the sleep for memory reads it: an editor left alone for half an hour
// counts as nobody (ic's `for_unattended`). Pure.
const quietOf = (signal: WorkSignal): number | undefined => signal.unattendedSince ?? signal.quietSince;

// Whether that quiet stands only because an editor left open counts as nobody: still connected, so no strict streak. Pure.
const leftOpen = (signal: WorkSignal): boolean => signal.quietSince === undefined && signal.unattendedSince !== undefined;

// Why a sandbox stays up whatever memory is left, or undefined when it may sleep: ic's own verdict (sleep.rs
// sleep_verdict), read off the same signal, so a sandbox ic would refuse is not asked. Pure.
export const stayUp = (signal: WorkSignal | undefined, now: number): string | undefined => {
    if (signal === undefined) {
        return "its daemon says nothing of its work";
    }
    if (now - signal.at > SIGNAL_STALE_MS) {
        return "its daemon's work signal is stale";
    }
    if (signal.liveTurns > 0) {
        return "something is running in it";
    }
    if (signal.keepAwake === true) {
        return "it is kept awake (its own Sleep when unused setting, or a receiver that must stay up)";
    }
    const quiet = quietOf(signal);
    if (quiet === undefined) {
        return "it is in use (somebody at an editor within the last half hour, or work of its own still going)";
    }
    // Without the figure, which moves every look: a standing reason is said once (nothingSaid).
    if (now - quiet < QUIET_MS) {
        return `it was used within the last ${QUIET_MINUTES} min`;
    }
    if (signal.nextWakeAt !== undefined && signal.nextWakeAt - now <= WAKE_SOON_MS) {
        return "something it scheduled is due soon";
    }
    return undefined;
};

// The sandboxes awake on this engine that are a person's (a runner is never slept: nothing would wake it).
const awakePeople = (listed: readonly ListedSandbox[]): ListedSandbox[] =>
    listed.filter((row) => row.running === true && row.asleep !== true && !isRunner(row.slug));

// Of those, the ones this side keeps: the only ones its ic may put to sleep, and whose signals are read. Pure.
const ownAwake = (listed: readonly ListedSandbox[]): ListedSandbox[] => awakePeople(listed).filter((row) => row.keptElsewhere === undefined);

export interface Candidate {
    readonly slug: string;
    // Since when nobody has needed it, an editor left alone counting as nobody (quietOf).
    readonly quietSince: number;
    // The last moment a person did something here since its boot, or was here for a daemon that does not say; 0 for none.
    readonly activeAt: number;
    // Whether an editor is still open on it, untouched.
    readonly leftOpen: boolean;
}

export interface Choice {
    // Who may sleep, least recently used first.
    readonly order: readonly Candidate[];
    // Who stays up, and why.
    readonly kept: readonly { readonly slug: string; readonly why: string }[];
    // Whether only one sandbox runs on this engine, which is never put to sleep.
    readonly only: boolean;
}

// Who may sleep for memory, in the order to ask: the one quiet longest first, then the one a person used longest ago.
// Every sandbox awake on the engine counts toward "never the only one", the other side's included: they share the
// memory. Pure.
export const choose = (listed: readonly ListedSandbox[], signals: ReadonlyMap<string, WorkSignal | undefined>, busy: ReadonlySet<string>, now: number): Choice => {
    if (awakePeople(listed).length < 2) {
        return { order: [], kept: [], only: true };
    }
    const order: Candidate[] = [];
    const kept: { slug: string; why: string }[] = [];
    for (const { slug } of ownAwake(listed)) {
        const signal = signals.get(slug);
        const why = busy.has(slug) ? "another ic run is working on it" : stayUp(signal, now);
        const quiet = signal === undefined ? undefined : quietOf(signal);
        if (why !== undefined || signal === undefined || quiet === undefined) {
            kept.push({ slug, why: why ?? "it is in use" });
            continue;
        }
        order.push({ slug, quietSince: quiet, activeAt: signal.activeAt ?? signal.personAt ?? 0, leftOpen: leftOpen(signal) });
    }
    order.sort((a, b) => a.quietSince - b.quietSince || a.activeAt - b.activeAt || a.slug.localeCompare(b.slug));
    return { order, kept, only: false };
};

/* THE STREAK AND THE PACE. */

export interface MemorySleepState {
    // When the computer went under its low line, undefined while it is not (or could not be read).
    shortSince: number | undefined;
    // When the next look may run: after a sleep, SETTLE_MS; after a look that slept nothing, LOOK_AGAIN_MS.
    nextLookAt: number;
    // Until when ic is asked without `--unattended` and `--reason`, having refused them.
    flagsRefusedUntil: number;
    // The last thing said per subject, so a standing reason is said once per stretch.
    readonly said: Map<string, string>;
}

export const newMemorySleepState = (): MemorySleepState => ({ shortSince: undefined, nextLookAt: 0, flagsRefusedUntil: 0, said: new Map() });

export const isShort = (memory: HostMemory): boolean => memory.availableBytes < hostMemoryLowBytes(memory.totalBytes);

// One reading into the streak, answering how long the computer has been short (undefined: it is not). A reading that
// could not be taken ends the streak: nothing is put to sleep on a guess.
export const noteReading = (state: MemorySleepState, memory: HostMemory | undefined, now: number): number | undefined => {
    if (memory === undefined || !isShort(memory)) {
        state.shortSince = undefined;
        return undefined;
    }
    state.shortSince ??= now;
    return now - state.shortSince;
};

// Whether to look for a sandbox to put to sleep now: short for SHORT_FOR_MS, and the look's own pace allows it. Pure.
export const lookDue = (state: Pick<MemorySleepState, "nextLookAt">, shortForMs: number | undefined, now: number): boolean =>
    shortForMs !== undefined && shortForMs >= SHORT_FOR_MS && now >= state.nextLookAt;

/* WHAT IS SAID. */

const shortText = (memory: HostMemory, shortForMs: number): string =>
    `this computer has had less than ${sizeLabel(hostMemoryLowBytes(memory.totalBytes))} of memory available for ${minutes(shortForMs)} (${sizeLabel(memory.availableBytes)} of ${sizeLabel(memory.totalBytes)} now)`;

const leftOpenText = (candidate: Pick<Candidate, "leftOpen">): string => (candidate.leftOpen ? " (an editor is still open on it, untouched)" : "");

// The keeper's line for a sandbox it put to sleep for memory: which, why, and that opening it wakes it. Pure.
export const sleptLine = (candidate: Candidate, memory: HostMemory, shortForMs: number, now: number, alarmAt?: number): string =>
    `keeper ${candidate.slug}: put to sleep to give memory back: ${shortText(memory, shortForMs)}, and nobody had used ${candidate.slug} for ${minutes(now - candidate.quietSince)}${leftOpenText(candidate)}, longer than any other sandbox here. It starts again when somebody opens it${
        alarmAt === undefined ? "" : `, or ahead of what it has scheduled at ${new Date(alarmAt).toISOString()}`
    }.`;

// Why, for the sandbox's own record of the stop (ic's `--reason`, which it says as "put to sleep because …"). Pure.
export const sleepReason = (memory: HostMemory, shortForMs: number, candidate: Pick<Candidate, "leftOpen">): string =>
    `this computer was short of memory (${sizeLabel(memory.availableBytes)} of ${sizeLabel(memory.totalBytes)} available, under its ${sizeLabel(hostMemoryLowBytes(memory.totalBytes))} low line, for ${minutes(shortForMs)}) and nobody had used this sandbox longer than any other there${leftOpenText(candidate)}; opening it wakes it`;

// The line for a look that put nothing to sleep, and the key it is said once under: its reasons without the figures,
// which move every look.
export interface NothingSaid {
    readonly key: string;
    readonly line: string;
}

// Pure.
export const nothingSaid = (memory: HostMemory, shortForMs: number, choice: Pick<Choice, "kept" | "only">): NothingSaid => {
    const why = choice.only
        ? "only one sandbox runs on it, and that one is never put to sleep"
        : choice.kept.length === 0
          ? "this side keeps no sandbox that is awake"
          : choice.kept.map(({ slug, why: reason }) => `${slug}: ${reason}`).join("; ");
    return { key: why, line: `keeper: ${shortText(memory, shortForMs)}, but no sandbox here can sleep to give it back (${why}).` };
};

/* THE LOOK. */

// With a reason, this release's two flags: an editor left alone counts as nobody, and why goes in the record. Without,
// the line an ic from before them takes, which holds an open editor as somebody there.
export const memorySleepArgs = (slug: string, reason: string | undefined): string[] => [
    "sandbox",
    "sleep",
    slug,
    "--idle",
    String(QUIET_MINUTES),
    "--json",
    "--source",
    "agent",
    ...(reason === undefined ? [] : ["--unattended", "--reason", reason]),
];

export interface MemorySleepSeams {
    // The `updates --memory` switch.
    readonly enabled: () => Promise<boolean>;
    // The computer's own memory, undefined where this side cannot read it.
    readonly memory: () => Promise<HostMemory | undefined>;
    // A container's work signal as its file reads, undefined when it would not say.
    readonly signal: (container: string) => Promise<string | undefined>;
    // `ic sandbox sleep <slug> --idle 60`, with `--unattended --reason` unless the reason is undefined (memorySleepArgs).
    readonly sleep: (slug: string, reason: string | undefined) => Promise<IcRun>;
}

// What the keeper lends a look: its listing, the slugs a flow of this process touches, its hold, and its clock.
export interface MemoryLookDeps {
    readonly listing: () => Promise<readonly ListedSandbox[]>;
    readonly busy: ReadonlySet<string>;
    readonly hold: (slug: string) => () => void;
    readonly now: () => number;
}

export interface MemorySlept {
    readonly slug: string;
    // When the alarm its sleep set is for, undefined when it set none.
    readonly alarmAt: number | undefined;
}

const sayOnce = (state: MemorySleepState, key: string, said: string, line: string, log: Log): void => {
    if (state.said.get(key) !== said) {
        state.said.set(key, said);
        log(line);
    }
};

// One ask of ic for one sandbox, held as the keeper holds its own; an ic that refuses the flags is asked again at once
// without them, and plainly for FLAGS_REFUSED_MS.
const ask = async (state: MemorySleepState, seams: MemorySleepSeams, deps: MemoryLookDeps, slug: string, reason: string): Promise<IcRun> => {
    const release = deps.hold(slug);
    const sleep = async (given: string | undefined): Promise<IcRun> =>
        await seams.sleep(slug, given).catch((error: Error): IcRun => ({ code: 127, output: errorMessage(error) }));
    try {
        const reasoned = deps.now() >= state.flagsRefusedUntil;
        const run = await sleep(reasoned ? reason : undefined);
        if (!reasoned || !refusedFlag(run)) {
            return run;
        }
        state.flagsRefusedUntil = deps.now() + FLAGS_REFUSED_MS;
        return await sleep(undefined);
    } finally {
        release();
    }
};

// Every candidate's signal, read through docker in parallel: a handful of `cat`s, once per look.
const readSignals = async (seams: MemorySleepSeams, rows: readonly ListedSandbox[]): Promise<Map<string, WorkSignal | undefined>> =>
    new Map(
        await Promise.all(
            rows.map(async ({ slug, container }) => {
                // allow(silent-catch): a container that will not say is one with no signal, which stayUp keeps awake
                const text = await seams.signal(container ?? `intentic-sandbox-${slug}`).catch(() => undefined);
                return [slug, workSignalOf(text)] as const;
            }),
        ),
    );

// One pass, run on the keeper's tick: the reading, and when the streak has held and the pace allows, one look that puts
// at most one sandbox to sleep. Answers the sandbox it put to sleep.
export const runMemorySleep = async (state: MemorySleepState, seams: MemorySleepSeams, deps: MemoryLookDeps, log: Log): Promise<MemorySlept | undefined> => {
    // allow(silent-catch): a switch that does not read holds this off; the keeper's own switch says a machine.json fault
    const on = await seams.enabled().catch(() => false);
    // allow(silent-catch): a reading that fails is none, which ends the streak (noteReading)
    const memory = on ? await seams.memory().catch(() => undefined) : undefined;
    const shortFor = noteReading(state, memory, deps.now());
    if (memory === undefined || shortFor === undefined) {
        state.said.delete(":memory");
        return undefined;
    }
    if (!lookDue(state, shortFor, deps.now())) {
        return undefined;
    }
    state.nextLookAt = deps.now() + LOOK_AGAIN_MS;
    // allow(silent-catch): a listing that fails is Docker being down; the next look asks again
    const listed = await deps.listing().catch(() => undefined);
    if (listed === undefined) {
        return undefined;
    }
    const signals = await readSignals(
        seams,
        ownAwake(listed).filter((row) => !deps.busy.has(row.slug)),
    );
    const choice = choose(listed, signals, deps.busy, deps.now());
    const kept = [...choice.kept];
    for (const candidate of choice.order) {
        const run = await ask(state, seams, deps, candidate.slug, sleepReason(memory, shortFor, candidate));
        const answer = sleepAnswers(run.output).find((said) => said.slug === candidate.slug);
        if (answer === undefined) {
            // No answer about it: an ic without the verb, or one that failed before it got there. Said once, tried next look.
            const why = run.output.split(/\r?\n/).findLast((line) => line.trim() !== "")?.trim() ?? `ic exited with ${run.code}`;
            sayOnce(state, ":ic", why, `keeper: this machine's ic could not put ${candidate.slug} to sleep to give memory back (${why}).`, log);
            return undefined;
        }
        state.said.delete(":ic");
        if (answer.slept) {
            const now = deps.now();
            state.nextLookAt = now + SETTLE_MS;
            state.said.delete(":memory");
            log(sleptLine(candidate, memory, shortFor, now, answer.wakeAt));
            return { slug: candidate.slug, alarmAt: answer.wakeAt };
        }
        kept.push({ slug: candidate.slug, why: `ic left it awake: ${answer.why ?? "no reason given"}` });
    }
    const said = nothingSaid(memory, shortFor, { kept, only: choice.only });
    sayOnce(state, ":memory", said.key, said.line, log);
    return undefined;
};

/* AS THIS AGENT RUNS IT. */

// The memory switch, on unless machine.json says `memorySleep: false` (`intentic-machine updates --memory off`).
const memorySleepOn = async (): Promise<boolean> => (await readMachineConfig()).memorySleep !== false;

// MemAvailable and the total, from a Linux kernel's /proc/meminfo; undefined for one that does not say. Pure.
export const linuxMemoryOf = (meminfo: string, totalBytes: number): HostMemory | undefined => {
    const availableMb = parseMeminfoAvailableMb(meminfo);
    return availableMb === undefined ? undefined : { availableBytes: availableMb * 1024 * 1024, totalBytes };
};

// The computer's own memory: Windows' on its side, the kernel's on a Linux host. A WSL distro reads the VM's, not the
// computer's, and a Mac's free memory leaves out what it would give back (hosts.ts), so neither is read.
const hostMemory = async (): Promise<HostMemory | undefined> => {
    const side = await thisSide();
    if (side === "windows") {
        return windowsMemory();
    }
    if (side !== "native" || process.platform !== "linux") {
        return undefined;
    }
    // allow(silent-catch): a kernel without /proc/meminfo has no reading, and nothing sleeps on a guess
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => undefined);
    return meminfo === undefined ? undefined : linuxMemoryOf(meminfo, totalmem());
};

export const machineMemorySleepSeams = (runIc: (args: readonly string[], deadlineMs: number) => Promise<IcRun>): MemorySleepSeams => ({
    enabled: memorySleepOn,
    memory: hostMemory,
    signal: async (container) => {
        // allow(silent-catch): an exec that fails (a container stopping, an image from before the signal) is no signal
        const read = await execBounded("docker", ["exec", container, "cat", WORK_SIGNAL_PATH], { timeoutMs: SIGNAL_READ_MS }).catch(() => undefined);
        return read?.stdout;
    },
    sleep: async (slug, reason) => await runIc(memorySleepArgs(slug, reason), SLEEP_DEADLINE_MS),
});
