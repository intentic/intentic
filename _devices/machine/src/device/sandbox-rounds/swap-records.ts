import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homeDir } from "@intentic/local-agent";

// WHAT `ic` SAYS ABOUT A SWAP IN FLIGHT, read off its per-sandbox channel record: the one place every process on this
// environment (the resident agent, an `upgrade`, a `run`) can see that a sandbox is mid-swap, whichever process started
// it. ic writes `swap_phase` when it parks the old container (`cutover`) and keeps it while the previous version waits
// for the new one to prove itself (`probation`); the key is gone once neither is true.

// Where ic keeps its records: INTENTIC_HOME when set, which ic honours, else `.intentic` under the home this agent uses.
export const icHome = (env: NodeJS.ProcessEnv = process.env): string => {
    const set = env["INTENTIC_HOME"];
    return set === undefined || set === "" ? join(homeDir(), ".intentic") : set;
};

// One sandbox's record, as far as a swap goes. `phase` is ic's word, kept as written so a phase a newer ic adds still
// reads as "something is going on"; `at` is when the cutover began and `probationUntil` when the watch lets go, both ms.
export interface SwapRecord {
    readonly slug: string;
    readonly phase?: string | undefined;
    readonly at?: number | undefined;
    readonly probationUntil?: number | undefined;
}

const RECORD_PREFIX = "sandbox-";
const RECORD_SUFFIX = ".channel";

// The slug a record file belongs to, or undefined for any other file in ic's home.
export const slugOfRecord = (name: string): string | undefined =>
    name.startsWith(RECORD_PREFIX) && name.endsWith(RECORD_SUFFIX) && name.length > RECORD_PREFIX.length + RECORD_SUFFIX.length
        ? name.slice(RECORD_PREFIX.length, -RECORD_SUFFIX.length)
        : undefined;

const millis = (value: string | undefined): number | undefined => {
    const parsed = value === undefined ? Number.NaN : Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

// `key=value` lines under ic's own rules: the last occurrence wins, an unknown key is ignored, a line without `=` is
// not a line. Pure, so the format is asserted without a file.
export const parseSwapRecord = (slug: string, text: string): SwapRecord => {
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf("=");
        if (at > 0) {
            values.set(line.slice(0, at), line.slice(at + 1).trim());
        }
    }
    const phase = values.get("swap_phase");
    return {
        slug,
        phase: phase === "" ? undefined : phase,
        at: millis(values.get("swap_at")),
        probationUntil: millis(values.get("probation_until")),
    };
};

// Every record in ic's home that names a phase. A home ic has never written, or one that cannot be read, has none: this
// feeds deferrals and pauses, and none of them may stop the agent over a directory it does not own.
export const readSwapRecords = async (home: string = icHome()): Promise<SwapRecord[]> => {
    // allow(silent-catch): no readable home is no record, the same answer as a machine that never swapped
    const names = await readdir(home).catch((): string[] => []);
    const records = await Promise.all(
        names.map(async (name) => {
            const slug = slugOfRecord(name);
            // allow(silent-catch): a record that vanished between the listing and the read is a swap that ended
            const text = slug === undefined ? undefined : await readFile(join(home, name), "utf8").catch(() => undefined);
            return slug === undefined || text === undefined ? undefined : parseSwapRecord(slug, text);
        }),
    );
    return records.filter((record): record is SwapRecord => record?.phase !== undefined);
};

// Every sandbox this environment's ic keeps a record of, whatever its phase: what runs here as far as anything can tell
// while Docker is down, which is when the keeper needs it. A removed sandbox's record outlives it until
// `ic sandbox tidy` archives it, so the listing is preferred wherever Docker answers (keeper.ts, hostedSlugs).
export const readChannelSlugs = async (home: string = icHome()): Promise<string[]> => {
    // allow(silent-catch): no readable home is no record, the same answer as a machine ic never ran on
    const names = await readdir(home).catch((): string[] => []);
    return names
        .map(slugOfRecord)
        .filter((slug): slug is string => slug !== undefined)
        .toSorted();
};

// How long a cutover record counts as a swap still in progress. Past it the record is an interruption the probation
// watch is there to settle, not a reason to hold every other restart of this agent for ever.
export const CUTOVER_HOLDS_MS = 30 * 60_000;

// Whether this record says a container is being swapped right now: parked old, new one not yet proven up. A cutover
// with no time, or one stamped too far from now either way, is not believed.
export const cutoverUnderway = (record: SwapRecord, now: number): boolean =>
    record.phase === "cutover" && record.at !== undefined && Math.abs(now - record.at) < CUTOVER_HOLDS_MS;

// The sandboxes a restart of this agent would leave down if it went ahead now.
export const swapsUnderway = (records: readonly SwapRecord[], now: number): string[] =>
    records.filter((record) => cutoverUnderway(record, now)).map((record) => record.slug);
