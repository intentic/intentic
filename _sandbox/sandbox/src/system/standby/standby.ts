import { readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeFileAtomic } from "@intentic/base/fs";
import { join } from "node:path";
import { type ActiveHost, ActiveHostSchema, type Takeover, TakeoverSchema } from "@intentic/api-contract/ingress";
import type { Logger } from "pino";
import { z } from "zod";

/* ONE ACTIVE HOST PER SANDBOX, THE DAEMON'S SIDE (2026-11-11). The platform names the copy that runs a sandbox (api
 * active-host.ts) and tells every announcing copy whether it is that one. Two files on /history/.ic, shared with `ic`
 * (its sandbox/takeover.rs), carry it across restarts:
 *
 * - `takeover.json`, which ic writes when a person says this machine runs the sandbox (a move here, `ic sandbox claim`):
 *   sent with every announce until one is accepted, then deleted. While it waits, this copy is never on standby.
 * - `standby.json`, `{v:1, since, activeHost, activeEpoch}`, written when the platform answers `active: false`: this
 *   copy is not the one. A daemon that boots with it (and no takeover waiting) stays on standby: no tunnel (netd stands
 *   down), no schedulers, restores, resumes, automations or workspace apps; loopback, /health and ic's access stay.
 *   `ic sandbox fix` reads it too, settles the sandbox as `elsewhere` and holds it stopped.
 *
 * Entering or leaving standby restarts the daemon (netd starts it again) rather than stopping and starting every
 * scheduler in place: the boot already decides what starts, in one order, and a dozen subsystems with their own
 * teardowns would each need an undo that nothing else exercises. A restart is the one path that is tested every day.
 * An announce that fails (the platform unreachable, a refusal) never puts a copy on standby: only an explicit
 * `active: false` does. */

const TAKEOVER_FILE = ".ic/takeover.json";
const STANDBY_FILE = ".ic/standby.json";

const StandbyRecordSchema = z.object({
    v: z.literal(1),
    since: z.number(),
    activeHost: ActiveHostSchema.optional(),
    activeEpoch: z.number().optional(),
});
export type StandbyRecord = z.infer<typeof StandbyRecordSchema>;

// One of the two files read through its own schema; a file that is missing, unreadable or not that shape is none.
const readParsed = async <T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> => {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch {
        // allow(silent-catch): a file that is missing or unreadable is no record, which leaves this copy as it always was
        return undefined;
    }
    try {
        const parsed = schema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): half a file, or not JSON, is no record either
        return undefined;
    }
};

// The takeover ic left for this copy, or none; a malformed one is none.
const readTakeover = async (historyRoot: string): Promise<Takeover | undefined> => {
    return await readParsed(join(historyRoot, TAKEOVER_FILE), TakeoverSchema);
};

// The same, read at once: the announce reads it before every attempt, and an hourly read of a file this small never waits
// on anything worth a turn of the event loop.
export const readTakeoverNow = (historyRoot: string): Takeover | undefined => {
    if (historyRoot === "") {
        return undefined;
    }
    let text: string;
    try {
        text = readFileSync(join(historyRoot, TAKEOVER_FILE), "utf8");
    } catch {
        // allow(silent-catch): no marker, or one that cannot be read, is no takeover: this copy announces as it always did
        return undefined;
    }
    try {
        const parsed = TakeoverSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): half a marker is none; ic writes it whole and renames it into place
        return undefined;
    }
};

export const removeTakeover = async (historyRoot: string): Promise<void> => {
    await rm(join(historyRoot, TAKEOVER_FILE), { force: true });
};

export const readStandby = async (historyRoot: string): Promise<StandbyRecord | undefined> => {
    return await readParsed(join(historyRoot, STANDBY_FILE), StandbyRecordSchema);
};

// Atomically, so ic never reads half of one.
export const writeStandby = async (historyRoot: string, record: StandbyRecord): Promise<void> => {
    await mkdir(join(historyRoot, ".ic"), { recursive: true });
    await writeFileAtomic(join(historyRoot, STANDBY_FILE), `${JSON.stringify(record)}\n`, 0o644);
};

export const clearStandby = async (historyRoot: string): Promise<void> => {
    await rm(join(historyRoot, STANDBY_FILE), { force: true });
};

// Whether this boot is a standby copy's: the record says so and no takeover waits to be announced.
export const standbyAtBoot = async (historyRoot: string): Promise<StandbyRecord | undefined> =>
    (await readTakeover(historyRoot)) === undefined ? await readStandby(historyRoot) : undefined;

// The record a booting daemon holds itself to, said in its log; none for a daemon that does not own the container
// (`historyRoot` empty).
export const standbyForBoot = async (historyRoot: string, logger: Pick<Logger, "warn">): Promise<StandbyRecord | undefined> => {
    const standby = historyRoot === "" ? undefined : await standbyAtBoot(historyRoot);
    holdStandby(standby);
    if (standby !== undefined) {
        logger.warn({ activeHost: standby.activeHost }, `boot: ${standbyNotice(standby.activeHost)}; nothing starts work on its own`);
    }
    return standby;
};

/* THE STANDING THIS PROCESS BOOTED INTO. Read once at boot (standbyForBoot) and never changed while it runs: leaving or
 * entering standby restarts the daemon. Held here rather than on the services, which are built before the record is read,
 * for the two readers that need it: the turn gate (admitUnlessStandby, agent/run/stream-agent.ts) and `/info` (standbyInfo). */
let booted: StandbyRecord | undefined;

// For a test, or the boot: what the rest of this process reads as its standing.
export const holdStandby = (record: StandbyRecord | undefined): void => {
    booted = record;
};

// The one gate every turn passes (agent/run/stream-agent.ts): refused with the active host's name while this copy is on
// standby, else admitted as the execution domain says.

export const admitUnlessStandby = async <T>(execution: { readonly admit: () => Promise<T> }): Promise<T> => {
    if (booted !== undefined) {
        throw new Error(standbyRefusal(booted));
    }
    return await execution.admit();
};

// The code a refused admission's frame carries, by its sentence: `standby` for this copy standing down (every turn, a
// send, a released queue or a resume, passes the gate: nothing ran, so the words are owed), the domain's otherwise.
export const refusalCodeOf = (message: string): "standby" | "agent-domain-refused" =>
    message.startsWith(STANDBY_PREFIX) ? "standby" : "agent-domain-refused";

// What `/info` says of it: the active host in words, and since when this copy stood down.
export const standbyInfo = (record: StandbyRecord | undefined = booted): { host: string; since: string } | undefined =>
    record === undefined ? undefined : { host: hostWords(record.activeHost), since: new Date(record.since).toISOString() };

// The sentence a refused turn ends with.
export const standbyRefusal = (record: StandbyRecord): string =>
    `${standbyNotice(record.activeHost)}, so no turn starts here. Open the sandbox there, or run \`ic sandbox claim\` on this machine to run it here.`;

// How the active host is named to a person: its machine and side.
export const hostWords = (host: ActiveHost | undefined): string =>
    host === undefined ? "another machine" : host.os === undefined ? host.host : `${host.host} (${host.os})`;

// What an accepted announce asks of this copy: to go on standby, to leave it, or nothing. Absent `active` (an older
// platform, a copy it cannot place) is nothing, whichever way this copy runs now. Pure.
export const standbyTurn = (active: boolean | undefined, onStandby: boolean): "enter" | "leave" | undefined => {
    if (active === false && !onStandby) {
        return "enter";
    }
    return active === true && onStandby ? "leave" : undefined;
};

// The one line every surface shows a standby copy by.
const STANDBY_PREFIX = "This copy is on standby: ";
export const standbyNotice = (host: ActiveHost | undefined): string => `${STANDBY_PREFIX}${hostWords(host)} runs this sandbox`;
