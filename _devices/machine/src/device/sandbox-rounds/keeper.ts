import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import { readMachineConfig } from "../../environments/machine.js";
import { pairingSlugs } from "../../sync/swap-pause.js";
import type { LinkReading } from "../config.js";
import { type IcRun, lastLine, type Rounds, startRounds } from "./ic-rounds.js";
import { readChannelSlugs, readSwapRecords, swapsUnderway } from "./swap-records.js";
import { fleet, holdIcFlow, icInFlight, runIc } from "../tools/sandboxes.js";

// THE KEEPER: when a sandbox on this machine stops answering (Docker Desktop not started after a reboot, a container
// that stopped, a daemon whose registration gave up, a full disk), `ic sandbox fix --auto` heals what is safe to heal
// unasked and reports the rest, which it also posts to the platform itself. ic decides every fix; this keeps the clock:
// a sweep over every sandbox half a minute after start (the logon case) and every five minutes, and a fix of one
// sandbox as soon as this agent's link to it has failed for a minute, when that sandbox runs here. It never answers a
// question ic would ask a person (`--auto` applies only what needs no yes), and it never talks to the platform.

// Soon after start, when Docker Desktop is most likely still off after a reboot, but after the machine has settled.
const FIRST_SWEEP_MS = 30_000;
const SWEEP_EVERY_MS = 5 * 60_000;
// How often the keeper looks at its links: reading them costs nothing, and a minute of silence is the trigger.
const LOOK_EVERY_MS = 10_000;
// How long a link to a sandbox on this machine fails before the keeper fixes that sandbox: longer than a restart.
export const UNREACHABLE_AFTER_MS = 60_000;
// Starting Docker Desktop alone can take five minutes; past eight the run is stopped, so one hung run cannot hold the
// keeper for good.
export const FIX_DEADLINE_MS = 8 * 60_000;
// After a run that left something (needs-you, failed, no verdict), the wait before the next: 3 minutes, doubling to 20.
// (2026-10-05) The ceiling was 30 minutes, the same as the silence after which ic lets the other side of the computer
// adopt a sandbox whose keeper stopped writing its heartbeat (ic: sandbox/side.rs, `/history/.ic/keeper.json`). A
// keeper backing off from a sandbox it could not fix would have looked silent and been adopted now and then, so the
// ceiling stays well under that limit.
const BACKOFF_FIRST_MS = 3 * 60_000;
const BACKOFF_MAX_MS = 20 * 60_000;

export const backoffMs = (failures: number): number => (failures <= 0 ? 0 : Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS));

/* A "FIXED" IS NOT ALWAYS THE END OF IT. A sandbox that breaks, is restarted by ic, and breaks again a few minutes later
   used to have its ladder wiped by every "fixed", so the keeper restarted it every three minutes for as long as it kept
   breaking. ic now keeps a ledger of its own repairs (count and last time, in the sandbox's history), which is where the
   lasting memory lives; this in-memory ladder only has to stop being the thing that forgets. So the first "fixed" after
   repeated failures within the hour keeps the ladder where it was (the next failure waits longer still), and only a
   second "fixed" in a row, a "healthy", or an hour without a failure clears it. (2026-10-05) */
const REPEATED_FAILURES = 2;
const FAILURES_REMEMBERED_MS = 60 * 60_000;

// `--auto` is what makes the run safe unattended: ic applies only the fixes that need no yes and reports the others.
export const keeperFixArgs = (slug?: string): string[] => ["sandbox", "fix", ...(slug === undefined ? [] : [slug]), "--auto", "--json", "--source", "agent"];

/* WHAT `ic sandbox fix --json` SAYS: progress lines `intentic-fix: {…}` while it works, then one line per sandbox,
   `{"slug", "report"}`. Every word is read as a string, so a state, a fix or an outcome a newer ic adds is still said. */

export const FIX_PROGRESS_PREFIX = "intentic-fix:";

const FixCheckSchema = z.object({
    id: z.string(),
    label: z.string(),
    state: z.string(),
    problem: z.string().optional(),
    remedy: z.string().optional(),
    fix: z.string().optional(),
});
export type FixCheck = z.infer<typeof FixCheckSchema>;

const FixReportSchema = z.object({
    stage: z.string(),
    doing: z.string().optional(),
    outcome: z.string().optional(),
    checks: z.array(FixCheckSchema).default([]),
});

const FixAnswerSchema = z.object({ slug: z.string(), report: FixReportSchema });
export type FixAnswer = z.infer<typeof FixAnswerSchema>;
export type FixReport = FixAnswer["report"];

// The machine's own report, under `"slug": null`, which ic prints (and exits 1 after) when it found no sandbox to look
// at. It is a fix that ran: read as an ic that cannot fix, it held every round of the keeper back on the ladder
// (2026-10-06, omen's log every half hour since 2026-09-30).
const FixMachineSchema = z.object({ slug: z.null(), report: FixReportSchema });

// A progress line carries a report as it stands, bare or under `report`, with the sandbox it is about when ic says.
const FixProgressSchema = z.object({
    slug: z.string().optional(),
    doing: z.string().optional(),
    report: z.object({ doing: z.string().optional() }).optional(),
});
// What a progress line says: which sandbox, when ic names one, and what ic is doing now, when it is doing something.
export interface FixProgress {
    readonly slug: string | undefined;
    readonly doing: string | undefined;
}

// One line read by `schema`, or undefined for a line that is not JSON or not of that shape.
const lineAs = <T>(schema: z.ZodType<T>, text: string): T | undefined => {
    try {
        const parsed = schema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is ic's prose, which says nothing a JSON line does not
        return undefined;
    }
};

export const fixProgress = (line: string): FixProgress | undefined => {
    const trimmed = line.trim();
    const parsed = trimmed.startsWith(FIX_PROGRESS_PREFIX) ? lineAs(FixProgressSchema, trimmed.slice(FIX_PROGRESS_PREFIX.length)) : undefined;
    return parsed === undefined ? undefined : { slug: parsed.slug, doing: parsed.report?.doing ?? parsed.doing };
};

const jsonLines = (output: string): string[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"));

// The final lines of a run, one per sandbox; a progress line, prose, or JSON of another shape is none.
export const fixAnswers = (output: string): FixAnswer[] =>
    jsonLines(output)
        .map((line) => lineAs(FixAnswerSchema, line))
        .filter((answer) => answer !== undefined);

// The machine's report of a run that found no sandbox, when it printed one.
const machineAnswer = (output: string): FixReport | undefined =>
    jsonLines(output)
        .map((line) => lineAs(FixMachineSchema, line)?.report)
        .find((report) => report !== undefined);

const progressCount = (output: string): number => output.split(/\r?\n/).filter((line) => fixProgress(line) !== undefined).length;

// What one run comes to. `unavailable` is an ic that cannot fix at all: one from before `sandbox fix` (clap refuses the
// verb), or no ic, which runs nothing and prints no JSON. A run that timed out, or said anything in JSON, was a fix;
// `machine` is the machine's own report when it found no sandbox.
export type FixRunReading =
    { readonly unavailable: string } | { readonly answers: readonly FixAnswer[]; readonly machine?: FixReport };

// Why ic said no: its `error:` line where it printed one (clap's usage text follows it and ends in "try --help"), else
// its last line.
const refusalOf = (run: IcRun): string =>
    run.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^error\b/i.test(line)) ??
    lastLine(run.output)?.trim() ??
    `ic exited with ${run.code} and said nothing`;

export const readFixRun = (run: IcRun): FixRunReading => {
    const answers = fixAnswers(run.output);
    const machine = machineAnswer(run.output);
    if (run.code !== 0 && run.timedOut !== true && answers.length === 0 && machine === undefined && progressCount(run.output) === 0) {
        return { unavailable: refusalOf(run) };
    }
    return machine === undefined ? { answers } : { answers, machine };
};

// ic left the sandbox to the other side of this computer: on Windows, ic on Windows and ic in WSL drive one Docker
// engine, and only the side that created a sandbox keeps it (ic: sandbox/fix/mod.rs, side_of). This agent's run has
// nothing to do about it, ever.
const ELSEWHERE = "elsewhere";

// Nothing left to do about it: the keeper waits only after anything else.
export const settled = (answer: Pick<FixAnswer, "report">): boolean =>
    answer.report.outcome === "healthy" || answer.report.outcome === "fixed" || answer.report.outcome === ELSEWHERE;

// ic's exit code for "a restart or a sign-out of this computer finishes it", which no fix can do by itself.
const EXIT_RESTART = 4;

// What is left on one sandbox (or on the machine, with no slug), in ic's words: each check that warns or fails, and who
// can close it.
const leftLine = (slug: string | undefined, check: FixCheck): string => {
    const what = `${check.label}: ${check.problem ?? check.state}`;
    if (check.fix === "consent") {
        return `${what} (needs your yes: \`intentic-machine sandbox fix${slug === undefined ? "" : ` ${slug}`}\`)`;
    }
    return check.remedy === undefined ? what : `${what} (${check.remedy})`;
};

// The line one sandbox's verdict is logged as. "fixed" says only that: what was done was said as it happened.
export const verdictLine = (answer: FixAnswer): string => {
    if (answer.report.outcome === ELSEWHERE) {
        return `keeper ${answer.slug}: ${answer.report.doing ?? "left to the other side of this computer, whose machine agent keeps it."}`;
    }
    const outcome = answer.report.outcome ?? answer.report.stage;
    const left = settled(answer) ? [] : answer.report.checks.filter((check) => check.state === "fail" || check.state === "warn");
    return `keeper ${answer.slug}: ${outcome}${left.length === 0 ? "" : ` — ${left.map((check) => leftLine(answer.slug, check)).join("; ")}`}`;
};

// The line a machine's report is logged as, when a run found no sandbox and left something on the machine.
const machineLine = (report: FixReport): string => {
    const left = report.checks.filter((check) => check.state === "fail" || check.state === "warn");
    return `keeper: this machine: ${report.outcome ?? report.stage}${left.length === 0 ? "" : ` — ${left.map((check) => leftLine(undefined, check)).join("; ")}`}`;
};

/* WHICH SANDBOXES RUN HERE. A link names its sandbox by URL; ic knows it by slug. */

// The slug a link's sandbox has on this machine, when it runs here: whichever of its possible slugs this environment's
// ic knows (a record, the last listing), else, for a sandbox this agent reached over loopback, its hostname's first
// label, which is what ic names a sandbox with a public hostname (sync/swap-pause.ts, pairingSlugs).
export const localSlugOf = (sandboxUrl: string, known: ReadonlySet<string>, loopback: boolean): string | undefined => {
    const slugs = pairingSlugs(sandboxUrl);
    return slugs.find((slug) => known.has(slug)) ?? (loopback ? slugs[0] : undefined);
};

// One link as the resident agent holds it: its sandbox's URL and what its socket is doing.
export interface LinkView {
    readonly url: string;
    readonly reading: LinkReading;
}

// The sandboxes of this machine whose link has failed for at least UNREACHABLE_AFTER_MS, by slug, in link order.
export const unreachableHere = (links: readonly LinkView[], known: ReadonlySet<string>, loopback: ReadonlySet<string>, now: number): string[] =>
    links.flatMap(({ url, reading }) => {
        const since = reading.state === "open" ? undefined : reading.outage?.since;
        const slug = since !== undefined && now - since >= UNREACHABLE_AFTER_MS ? localSlugOf(url, known, loopback.has(url)) : undefined;
        return slug === undefined ? [] : [slug];
    });

// The slugs whose link is up now: whatever the keeper was waiting out for them is over.
const answeringSlugs = (links: readonly LinkView[]): string[] => links.filter(({ reading }) => reading.state === "open").flatMap(({ url }) => pairingSlugs(url));

// Runners belong to a parent sandbox, which brings them back itself.
const people = (slugs: readonly string[]): string[] => slugs.filter((slug) => !slug.startsWith("runner-"));

// One row of `ic sandbox list --json` as far as the keeper reads it: which sandbox, and the other side of this computer
// that keeps it, when another does (`keptElsewhere`, absent for this side's own and from an older ic).
export interface ListedSandbox {
    readonly slug: string;
    readonly keptElsewhere?: string | undefined;
}

/* WHOSE SANDBOXES THE KEEPER LOOKS AFTER (2026-10-05). On Windows, ic on Windows and ic in each WSL distro list every
   sandbox on the one Docker engine, but only the side that created a sandbox keeps it, and every environment runs a
   keeper. So each keeper sweeps only while its environment keeps a sandbox of its own: one the listing names without
   `keptElsewhere` (a sandbox the other side has stopped keeping is listed without it once ic adopts it, so adoption
   reaches this side by the same rule), or one this environment's ic still holds a record of that sits in ic's trash.
   And a slug with no container and no trash entry is gone: a dead link or a leftover record naming it is not a reason
   to run `ic sandbox fix` on it every few minutes for ever, which is what rog did for sandbox-2e8d89d75865. Absence
   proves nothing until Docker has answered, though: until a listing has, the records are all there is, and the logon
   case (Docker Desktop off after a reboot) is exactly when the keeper must still run. */
export interface KeeperScope {
    // The sandboxes this environment keeps, which are what a sweep is for; and those of them with a container, which are
    // what ic acts on and what a sweep holds up front (none while no listing has answered: ic names what it acts on).
    readonly own: readonly string[];
    readonly running: readonly string[];
    // Whether a slug still exists on this engine (a container, or an entry in ic's trash); always true while no listing
    // has answered, since nothing can be told then.
    readonly present: (slug: string) => boolean;
    // The listed sandboxes another side keeps: never this keeper's to fix.
    readonly elsewhere: ReadonlySet<string>;
}

// Pure over the last listing that answered (undefined while none has), this environment's records, and the slugs in
// ic's trash (undefined when they could not be read, which counts as none: on doubt, nothing is acted on).
export const keeperScope = (
    listed: readonly ListedSandbox[] | undefined,
    records: readonly string[],
    trashed: readonly string[] | undefined,
): KeeperScope => {
    if (listed === undefined) {
        return { own: people(records), running: [], present: () => true, elsewhere: new Set() };
    }
    const containers = new Set(listed.map((row) => row.slug));
    const binned = new Set(trashed ?? []);
    const mine = listed.filter((row) => row.keptElsewhere === undefined).map((row) => row.slug);
    const recordedInTrash = records.filter((slug) => !containers.has(slug) && binned.has(slug));
    return {
        own: people([...new Set([...mine, ...recordedInTrash])]),
        running: people(mine),
        present: (slug) => containers.has(slug) || binned.has(slug),
        elsewhere: new Set(listed.filter((row) => row.keptElsewhere !== undefined).map((row) => row.slug)),
    };
};

// The sandboxes this machine hosts and this environment keeps, for the resident's "is anything left to serve": the
// listing when Docker answers (it alone knows a removed sandbox is gone, and which side keeps the rest), else this
// environment's records, which are all there is while Docker is down.
export const hostedSlugs = async (listing: () => Promise<readonly ListedSandbox[]>, records: () => Promise<readonly string[]>): Promise<string[]> => {
    // allow(silent-catch): a listing that fails is Docker being down, which is exactly when the records answer instead
    const listed = await listing().catch(() => undefined);
    return people(listed === undefined ? await records() : listed.filter((row) => row.keptElsewhere === undefined).map((row) => row.slug));
};

// ic's trash on this engine, read off the marker volume each removal leaves (`intentic-trashed-<unix seconds>-<slug>`,
// ic: sandbox/trash.rs), which is the one place ic writes it down. Pure.
export const trashedFrom = (volumes: string): string[] =>
    volumes
        .split(/\r?\n/)
        .map((name) => /^intentic-trashed-\d+-(.+)$/.exec(name.trim())?.[1])
        .filter((slug): slug is string => slug !== undefined);

const exec = promisify(execFile);

// Throws when docker does not answer: an unread trash is not an empty one.
const readTrashed = async (): Promise<string[]> => {
    const { stdout } = await exec("docker", ["volume", "ls", "--format", "{{.Name}}", "--filter", "name=intentic-trashed-"], {
        timeout: 20_000,
        windowsHide: true,
    });
    return trashedFrom(stdout);
};

/* THE ROUND. */

// Everything the keeper reads or runs, injected so its decisions are asserted without timers, links or an ic.
export interface KeeperSeams {
    // The switch (`intentic-machine sandbox keeper on|off`), re-read every round.
    readonly enabled: () => Promise<boolean>;
    // `ic sandbox fix`, for one sandbox or, with none named, every one this environment's ic knows.
    readonly fix: (slug: string | undefined, onLine: (line: string) => void) => Promise<IcRun>;
    // `ic sandbox list --json`'s rows, which throws while Docker is down; the slugs of ic's records; and the slugs in
    // ic's trash on this engine, which throws when docker does not answer (asked only when a record names a sandbox the
    // listing does not).
    readonly listing: () => Promise<readonly ListedSandbox[]>;
    readonly records: () => Promise<readonly string[]>;
    readonly trashed: () => Promise<readonly string[]>;
    // The sandboxes a swap is moving right now (ic's cutover records): the probation watch's, never the keeper's.
    readonly swapping: () => Promise<readonly string[]>;
    readonly links: () => readonly LinkView[];
    // The link URLs this agent has reached over loopback (connection.ts).
    readonly loopback: ReadonlySet<string>;
    // Whether the probation watch is running ic right now: the keeper waits for it rather than racing it.
    readonly watching: () => boolean;
    // The slugs a flow of this process is touching, and how the keeper marks the ones its own run acts on.
    readonly busy: ReadonlySet<string>;
    readonly hold: (slug: string) => () => void;
    // The clock, read after a run as well as before it: a wait is measured from when the run ended.
    readonly now: () => number;
}

interface Wait {
    readonly failures: number;
    readonly until: number;
    // When the last of those failures was, and whether a "fixed" has already been let through without clearing them.
    readonly failedAt?: number;
    readonly fixedOnce?: boolean;
}

export interface KeeperState {
    sweepDueAt: number;
    sweepFailures: number;
    // An ic that cannot fix: every run waits this out, doubling as a failing sandbox does.
    unavailable: Wait;
    // Per sandbox, the wait before it is fixed again for a failing link.
    readonly waits: Map<string, Wait>;
    // The last line said per sandbox (and per machine-wide subject, `:ic` and the like, which no slug can spell), so a
    // standing verdict is said once per stretch.
    readonly said: Map<string, string>;
    // The last listing that answered, kept while Docker is down; undefined until one has. ic's trash as read with it,
    // undefined when it could not be read.
    listed: readonly ListedSandbox[] | undefined;
    trashed: readonly string[] | undefined;
    // Only one fix at a time, whoever asks.
    fixing: boolean;
    // The switch as last read, so turning it off or on is said once.
    on: boolean | undefined;
}

export const newKeeperState = (start: number): KeeperState => ({
    sweepDueAt: start + FIRST_SWEEP_MS,
    sweepFailures: 0,
    unavailable: { failures: 0, until: 0 },
    waits: new Map(),
    said: new Map(),
    listed: undefined,
    trashed: undefined,
    fixing: false,
    on: undefined,
});

// Says `line` under `key` unless it is what was said there last.
const sayOnce = (state: KeeperState, key: string, line: string, log: Log): void => {
    if (state.said.get(key) !== line) {
        state.said.set(key, line);
        log(line);
    }
};

const readSwitch = async (state: KeeperState, seams: KeeperSeams, log: Log): Promise<boolean> => {
    let on: boolean;
    try {
        on = await seams.enabled();
        state.said.delete(":switch");
    } catch (error) {
        // A switch that cannot be read may be the one holding the keeper off: nothing runs until it reads again.
        sayOnce(state, ":switch", `keeper: not running while machine.json does not read — ${errorMessage(error)}`, log);
        on = false;
    }
    if (state.on === undefined && !on) {
        log("keeper: off on this machine. `intentic-machine sandbox keeper on` turns it on.");
    } else if (state.on !== undefined && on !== state.on) {
        log(on ? "keeper: switched on, looking at this machine's sandboxes now." : "keeper: switched off. `intentic-machine sandbox keeper on` turns it back on.");
    }
    if (on && state.on === false) {
        state.sweepDueAt = seams.now();
    }
    state.on = on;
    return on;
};

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

// The wait after a sandbox's n-th unsettled run in a row, said with the line that begins it.
const waitAfter = (state: KeeperState, slug: string, now: number): number => {
    const failures = (state.waits.get(slug)?.failures ?? 0) + 1;
    state.waits.set(slug, { failures, until: now + backoffMs(failures), failedAt: now });
    return backoffMs(failures);
};

// Whether a "fixed" clears a sandbox's ladder (see REPEATED_FAILURES): not the first one after repeated failures within
// the hour. Pure.
export const fixedClears = (wait: Pick<Wait, "failures" | "failedAt" | "fixedOnce"> | undefined, now: number): boolean =>
    wait === undefined ||
    wait.failures < REPEATED_FAILURES ||
    wait.fixedOnce === true ||
    wait.failedAt === undefined ||
    now - wait.failedAt > FAILURES_REMEMBERED_MS;

// One sandbox's verdict; answers whether it cleared the sandbox's ladder. Settled resets its wait to a sweep's length (a
// link that stays down after ic found nothing wrong is not this machine's to fix, and is not asked about every ten
// seconds), unless it is a "fixed" that does not clear (fixedClears), which keeps the ladder; anything else doubles it.
// The line is said when it is news.
const noteAnswer = (state: KeeperState, answer: FixAnswer, log: Log, now: number): boolean => {
    const line = verdictLine(answer);
    if (settled(answer)) {
        const held = state.waits.get(answer.slug);
        const fixed = answer.report.outcome === "fixed";
        if (fixed && held !== undefined && !fixedClears(held, now)) {
            const wait = Math.max(SWEEP_EVERY_MS, backoffMs(held.failures));
            state.waits.set(answer.slug, { ...held, until: now + wait, fixedOnce: true });
            state.said.set(answer.slug, line);
            log(`${line} — after ${held.failures} failures within the hour, so the next look waits ${minutes(wait)}`);
            return false;
        }
        state.waits.set(answer.slug, { failures: 0, until: now + SWEEP_EVERY_MS });
        // "fixed" is always news; a standing "healthy" is said once.
        if (fixed) {
            state.said.set(answer.slug, line);
            log(line);
        } else {
            sayOnce(state, answer.slug, line, log);
        }
        return true;
    }
    const wait = waitAfter(state, answer.slug, now);
    if (state.said.get(answer.slug) !== line) {
        state.said.set(answer.slug, line);
        log(`${line} — looking again in ${minutes(wait)}`);
    }
    return false;
};

// Whether the run left nothing to wait out: false for an unavailable ic, or any sandbox it could not settle or whose
// "fixed" kept its ladder.
const noteRun = (state: KeeperState, run: IcRun, asked: string | undefined, log: Log, now: number): boolean => {
    const reading = readFixRun(run);
    if ("unavailable" in reading) {
        const failures = state.unavailable.failures + 1;
        state.unavailable = { failures, until: now + backoffMs(failures) };
        // Said once per reason, not at every wait: an ic from before `sandbox fix` stays that way until it is updated.
        if (state.said.get(":ic") !== reading.unavailable) {
            state.said.set(":ic", reading.unavailable);
            log(`keeper: this machine's ic cannot fix sandboxes (${reading.unavailable}); trying again in ${minutes(backoffMs(failures))}, and less often after that`);
        }
        return false;
    }
    state.unavailable = { failures: 0, until: 0 };
    state.said.delete(":ic");
    const cleared = reading.answers.map((answer) => noteAnswer(state, answer, log, now));
    // A run that found no sandbox still says how the machine stands: what it left is said once, and waited out.
    const machineSettled = reading.machine === undefined || settled({ report: reading.machine });
    if (reading.machine !== undefined && !machineSettled) {
        sayOnce(state, ":machine", machineLine(reading.machine), log);
    } else {
        state.said.delete(":machine");
    }
    if (run.code === EXIT_RESTART) {
        sayOnce(state, ":restart", "keeper: this computer needs a restart or a sign-out to finish what ic started.", log);
    } else {
        state.said.delete(":restart");
    }
    const unanswered = asked !== undefined && !reading.answers.some((answer) => answer.slug === asked);
    if (unanswered) {
        const wait = waitAfter(state, asked, now);
        state.said.delete(asked);
        log(`keeper ${asked}: ic gave no verdict (${lastLine(run.output)?.trim() ?? "no output"}) — looking again in ${minutes(wait)}`);
    }
    return !unanswered && machineSettled && cleared.every(Boolean);
};

// One run of `ic sandbox fix`, the only one in flight. The sandboxes it acts on are held for its length, so the other
// rounds leave them alone: the ones it was pointed at, and any other ic names as it works. What ic is doing is said as
// it happens.
const runFix = async (state: KeeperState, seams: KeeperSeams, slug: string | undefined, touches: readonly string[], log: Log): Promise<IcRun> => {
    state.fixing = true;
    const releases = new Map(touches.map((touched) => [touched, seams.hold(touched)] as const));
    const doings = new Set<string>();
    const onLine = (line: string): void => {
        const progress = fixProgress(line);
        if (progress?.slug !== undefined && !releases.has(progress.slug)) {
            releases.set(progress.slug, seams.hold(progress.slug));
        }
        const doing = progress?.doing;
        const about = progress?.slug ?? slug;
        const said = `keeper${about === undefined ? "" : ` ${about}`}: ${doing ?? ""}`;
        if (doing !== undefined && !doings.has(said)) {
            doings.add(said);
            log(said);
        }
    };
    try {
        return await seams.fix(slug, onLine);
    } catch (error) {
        // runIc throws when this machine has no ic at all: the same as an ic without the verb, waited out the same way.
        return { code: 127, output: errorMessage(error) };
    } finally {
        for (const release of releases.values()) {
            release();
        }
        state.fixing = false;
    }
};

// The listing again, and ic's trash with it when a record names a sandbox the listing does not: what a sweep decides on,
// and what the links are judged by until the next. A listing that fails keeps the last one that answered.
const relist = async (state: KeeperState, seams: KeeperSeams, records: readonly string[]): Promise<void> => {
    // allow(silent-catch): a listing that fails is Docker being down; the last one that answered (and the trash read with it) still stands
    const listed = await seams.listing().catch(() => undefined);
    if (listed === undefined) {
        return;
    }
    state.listed = listed;
    const containers = new Set(listed.map((row) => row.slug));
    // allow(silent-catch): a trash that cannot be read is none (keeperScope): no record is taken for a sandbox on a guess
    state.trashed = records.some((slug) => !containers.has(slug)) ? await seams.trashed().catch(() => undefined) : [];
};

// Every sandbox this environment keeps, when the sweep is due: its cadence stretches on the same ladder while a sweep
// leaves something. An environment that keeps none has nothing to sweep (KeeperScope says why), and says so once.
const sweep = async (state: KeeperState, seams: KeeperSeams, scope: KeeperScope, log: Log): Promise<void> => {
    if (scope.own.length === 0) {
        sayOnce(state, ":none", "keeper: this environment keeps no sandbox of its own, so there is nothing to sweep.", log);
        state.sweepDueAt = seams.now() + SWEEP_EVERY_MS;
        return;
    }
    state.said.delete(":none");
    const run = await runFix(state, seams, undefined, scope.running, log);
    const now = seams.now();
    const clean = noteRun(state, run, undefined, log, now);
    state.sweepFailures = clean ? 0 : state.sweepFailures + 1;
    state.sweepDueAt = now + Math.max(SWEEP_EVERY_MS, backoffMs(state.sweepFailures));
};

// The first sandbox of this machine whose link has failed for a minute, that still exists here and is this side's, and
// that nothing is waiting out. A gone one is said once and left alone.
const dueTarget = async (
    state: KeeperState,
    seams: KeeperSeams,
    links: readonly LinkView[],
    known: ReadonlySet<string>,
    scope: KeeperScope,
    log: Log,
    now: number,
): Promise<string | undefined> => {
    const here = unreachableHere(links, known, seams.loopback, now).filter((slug) => {
        if (!scope.present(slug)) {
            sayOnce(state, slug, `keeper ${slug}: its link is down, but this engine has no container and no trash entry for it, so there is nothing here to fix.`, log);
            return false;
        }
        return !scope.elsewhere.has(slug);
    });
    const candidates = here.filter((slug) => !seams.busy.has(slug) && (state.waits.get(slug)?.until ?? 0) <= now);
    if (candidates.length === 0) {
        return undefined;
    }
    const swapping = new Set(await seams.swapping());
    return candidates.find((slug) => !swapping.has(slug));
};

// One look. Nothing while a fix already runs, the probation watch is running ic, the switch is off, or an ic that
// cannot fix is being waited out; else the sweep when it is due and nothing of this process holds a sandbox, else a fix
// of the first sandbox of this machine whose link has failed for a minute.
export const runKeeperRound = async (state: KeeperState, seams: KeeperSeams, log: Log): Promise<void> => {
    if (state.fixing || seams.watching() || !(await readSwitch(state, seams, log)) || seams.now() < state.unavailable.until) {
        return;
    }
    const links = seams.links();
    for (const slug of answeringSlugs(links)) {
        state.waits.delete(slug);
    }
    const records = await seams.records();
    const sweepDue = seams.now() >= state.sweepDueAt && seams.busy.size === 0;
    if (sweepDue) {
        await relist(state, seams, records);
    }
    const scope = keeperScope(state.listed, records, state.trashed);
    if (sweepDue) {
        await sweep(state, seams, scope, log);
        if (scope.own.length > 0) {
            return;
        }
    }
    const known = new Set([...records, ...(state.listed ?? []).map((row) => row.slug)]);
    const target = await dueTarget(state, seams, links, known, scope, log, seams.now());
    if (target !== undefined) {
        const run = await runFix(state, seams, target, [target], log);
        noteRun(state, run, target, log, seams.now());
    }
};

// The seams as the resident agent has them: its links and what it reached over loopback, the probation watch's round.
export interface KeeperWiring {
    readonly links: () => readonly LinkView[];
    readonly loopback: ReadonlySet<string>;
    readonly watching: () => boolean;
}

// How the keeper holds a sandbox its run acts on: as a flow that does not move a container (machineKeeperSeams says why).
export const KEEPER_HOLD = { moves: false } as const;

export const keeperOn = async (): Promise<boolean> => (await readMachineConfig()).sandboxKeeper !== false;

export const machineKeeperSeams = ({ links, loopback, watching }: KeeperWiring): KeeperSeams => ({
    enabled: keeperOn,
    fix: async (slug, onLine) => await runIc(keeperFixArgs(slug), onLine, {}, { deadlineMs: FIX_DEADLINE_MS }),
    listing: async () => (await fleet()).map(({ slug, keptElsewhere }) => ({ slug, keptElsewhere })),
    records: async () => await readChannelSlugs(),
    trashed: readTrashed,
    swapping: async () => swapsUnderway(await readSwapRecords(), Date.now()),
    links,
    loopback,
    watching,
    busy: icInFlight,
    /* HELD AS FIXING, NOT AS MOVING (2026-10-05). The other rounds leave a held sandbox alone, which a fix needs; an
       agent restart (auto-upgrade, Update and Restart) waits only for a flow that MOVES a container. A fix used to be
       held as one, over every slug it might touch, and rog put off its agent upgrade seven times "while" eight
       sandboxes, one with no container and two in the trash, were "mid-swap". A fix starts or restarts a container at
       most. On POSIX ic outlives an agent restart (a process group of its own); on Windows a restart ends the run, and
       the next sweep starts it again. The one step of a fix an agent restart must never land in, finishing an
       interrupted cutover, is written in ic's own cutover record, which every restart already waits for
       (swap-records.ts). */
    hold: (slug) => holdIcFlow(slug, KEEPER_HOLD),
    now: Date.now,
});

export const startKeeper = (log: Log, wiring: KeeperWiring): Rounds => {
    const state = newKeeperState(Date.now());
    const seams = machineKeeperSeams(wiring);
    return startRounds("keeper", log, FIRST_SWEEP_MS, () => LOOK_EVERY_MS, async () => await runKeeperRound(state, seams, log));
};
