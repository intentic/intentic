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
// After a run that left something (needs-you, failed, no verdict), the wait before the next: 3 minutes, doubling to 30.
const BACKOFF_FIRST_MS = 3 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export const backoffMs = (failures: number): number => (failures <= 0 ? 0 : Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS));

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

// The final lines of a run, one per sandbox; a progress line, prose, or JSON of another shape is none.
export const fixAnswers = (output: string): FixAnswer[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => lineAs(FixAnswerSchema, line))
        .filter((answer) => answer !== undefined);

const progressCount = (output: string): number => output.split(/\r?\n/).filter((line) => fixProgress(line) !== undefined).length;

// What one run comes to. `unavailable` is an ic that cannot fix at all: one from before `sandbox fix` (clap refuses the
// verb), or no ic, which runs nothing and prints no JSON. A run that timed out, or said anything in JSON, was a fix.
export type FixRunReading = { readonly unavailable: string } | { readonly answers: readonly FixAnswer[] };

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
    if (run.code !== 0 && run.timedOut !== true && answers.length === 0 && progressCount(run.output) === 0) {
        return { unavailable: refusalOf(run) };
    }
    return { answers };
};

// Nothing left to do about it: the keeper waits only after anything else.
export const settled = (answer: FixAnswer): boolean => answer.report.outcome === "healthy" || answer.report.outcome === "fixed";

// ic's exit code for "a restart or a sign-out of this computer finishes it", which no fix can do by itself.
const EXIT_RESTART = 4;

// What is left on one sandbox, in ic's words: each check that warns or fails, and who can close it.
const leftLine = (slug: string, check: FixCheck): string => {
    const what = `${check.label}: ${check.problem ?? check.state}`;
    if (check.fix === "consent") {
        return `${what} (needs your yes: \`intentic-machine sandbox fix ${slug}\`)`;
    }
    return check.remedy === undefined ? what : `${what} (${check.remedy})`;
};

// The line one sandbox's verdict is logged as. "fixed" says only that: what was done was said as it happened.
export const verdictLine = (answer: FixAnswer): string => {
    const outcome = answer.report.outcome ?? answer.report.stage;
    const left = settled(answer) ? [] : answer.report.checks.filter((check) => check.state === "fail" || check.state === "warn");
    return `keeper ${answer.slug}: ${outcome}${left.length === 0 ? "" : ` — ${left.map((check) => leftLine(answer.slug, check)).join("; ")}`}`;
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

// The sandboxes this machine hosts, for the resident's "is anything left to serve": the listing when Docker answers (it
// alone knows a removed sandbox is gone), else this environment's records, which are all there is while Docker is down.
export const hostedSlugs = async (listing: () => Promise<readonly string[]>, records: () => Promise<readonly string[]>): Promise<string[]> => {
    // allow(silent-catch): a listing that fails is Docker being down, which is exactly when the records answer instead
    const listed = await listing().catch(() => undefined);
    return people(listed ?? (await records()));
};

/* THE ROUND. */

// Everything the keeper reads or runs, injected so its decisions are asserted without timers, links or an ic.
export interface KeeperSeams {
    // The switch (`intentic-machine sandbox keeper on|off`), re-read every round.
    readonly enabled: () => Promise<boolean>;
    // `ic sandbox fix`, for one sandbox or, with none named, every one this environment's ic knows.
    readonly fix: (slug: string | undefined, onLine: (line: string) => void) => Promise<IcRun>;
    // `ic sandbox list --json`'s slugs, which throws while Docker is down; and the slugs of ic's records.
    readonly listing: () => Promise<readonly string[]>;
    readonly records: () => Promise<readonly string[]>;
    // The sandboxes a swap is moving right now (ic's cutover records): the probation watch's, never the keeper's.
    readonly swapping: () => Promise<readonly string[]>;
    readonly links: () => readonly LinkView[];
    // The link URLs this agent has reached over loopback (connection.ts).
    readonly loopback: ReadonlySet<string>;
    // Whether the probation watch is running ic right now: the keeper waits for it rather than racing it.
    readonly watching: () => boolean;
    // The slugs a flow of this process is touching, and how the keeper marks the ones its own run may touch.
    readonly busy: ReadonlySet<string>;
    readonly hold: (slug: string) => () => void;
    // The clock, read after a run as well as before it: a wait is measured from when the run ended.
    readonly now: () => number;
}

interface Wait {
    readonly failures: number;
    readonly until: number;
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
    // The last listing that answered, kept while Docker is down.
    listed: readonly string[];
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
    listed: [],
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
    state.waits.set(slug, { failures, until: now + backoffMs(failures) });
    return backoffMs(failures);
};

// One sandbox's verdict. Settled resets its wait to a sweep's length (a link that stays down after ic found nothing
// wrong is not this machine's to fix, and is not asked about every ten seconds); anything else doubles it. The line is
// said when it is news.
const noteAnswer = (state: KeeperState, answer: FixAnswer, log: Log, now: number): void => {
    const line = verdictLine(answer);
    if (settled(answer)) {
        state.waits.set(answer.slug, { failures: 0, until: now + SWEEP_EVERY_MS });
        // "fixed" is always news; a standing "healthy" is said once.
        if (answer.report.outcome === "fixed") {
            state.said.set(answer.slug, line);
            log(line);
        } else {
            sayOnce(state, answer.slug, line, log);
        }
        return;
    }
    const wait = waitAfter(state, answer.slug, now);
    if (state.said.get(answer.slug) !== line) {
        state.said.set(answer.slug, line);
        log(`${line} — looking again in ${minutes(wait)}`);
    }
};

// Whether the run left nothing to wait out: false for an unavailable ic, or any sandbox it could not settle.
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
    for (const answer of reading.answers) {
        noteAnswer(state, answer, log, now);
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
    return !unanswered && reading.answers.every(settled);
};

// One run of `ic sandbox fix`, the only one in flight: every sandbox it may touch is marked for its length, so the
// other rounds leave them alone and this agent does not restart under it. What ic is doing is said as it happens.
const runFix = async (state: KeeperState, seams: KeeperSeams, slug: string | undefined, touches: readonly string[], log: Log): Promise<IcRun> => {
    state.fixing = true;
    const releases = touches.map((touched) => seams.hold(touched));
    const doings = new Set<string>();
    const onLine = (line: string): void => {
        const progress = fixProgress(line);
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
        for (const release of releases) {
            release();
        }
        state.fixing = false;
    }
};

// Every sandbox, when the sweep is due: its cadence stretches on the same ladder while a sweep leaves something.
const sweep = async (state: KeeperState, seams: KeeperSeams, known: ReadonlySet<string>, log: Log): Promise<void> => {
    // allow(silent-catch): a listing that fails is Docker being down; the last one that answered still names this machine's sandboxes
    state.listed = await seams.listing().catch(() => state.listed);
    const touches = [...new Set([...known, ...state.listed])];
    const run = await runFix(state, seams, undefined, touches, log);
    const now = seams.now();
    const clean = noteRun(state, run, undefined, log, now);
    state.sweepFailures = clean ? 0 : state.sweepFailures + 1;
    state.sweepDueAt = now + Math.max(SWEEP_EVERY_MS, backoffMs(state.sweepFailures));
};

// The first sandbox of this machine whose link has failed for a minute and that nothing is waiting out.
const dueTarget = async (
    state: KeeperState,
    seams: KeeperSeams,
    links: readonly LinkView[],
    known: ReadonlySet<string>,
    now: number,
): Promise<string | undefined> => {
    const candidates = unreachableHere(links, known, seams.loopback, now).filter(
        (slug) => !seams.busy.has(slug) && (state.waits.get(slug)?.until ?? 0) <= now,
    );
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
    const known = new Set([...(await seams.records()), ...state.listed]);
    const now = seams.now();
    if (now >= state.sweepDueAt && seams.busy.size === 0) {
        await sweep(state, seams, known, log);
        return;
    }
    const target = await dueTarget(state, seams, links, known, now);
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

export const keeperOn = async (): Promise<boolean> => (await readMachineConfig()).sandboxKeeper !== false;

export const machineKeeperSeams = ({ links, loopback, watching }: KeeperWiring): KeeperSeams => ({
    enabled: keeperOn,
    fix: async (slug, onLine) => await runIc(keeperFixArgs(slug), onLine, {}, { deadlineMs: FIX_DEADLINE_MS }),
    listing: async () => (await fleet()).map((box) => box.slug),
    records: async () => await readChannelSlugs(),
    swapping: async () => swapsUnderway(await readSwapRecords(), Date.now()),
    links,
    loopback,
    watching,
    busy: icInFlight,
    // A fix may restart a container, so it is held as a flow that moves one.
    hold: (slug) => holdIcFlow(slug, { moves: true }),
    now: Date.now,
});

export const startKeeper = (log: Log, wiring: KeeperWiring): Rounds => {
    const state = newKeeperState(Date.now());
    const seams = machineKeeperSeams(wiring);
    return startRounds("keeper", log, FIRST_SWEEP_MS, () => LOOK_EVERY_MS, async () => await runKeeperRound(state, seams, log));
};
