import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homeDir } from "@intentic/local-agent";

// WHAT `ic` KEEPS ABOUT THE SANDBOXES OF THIS ENVIRONMENT: its home, and one channel record per sandbox in it. Whether a
// swap is in flight, and whether a cutover is being done right now, is NOT read here: `ic sandbox swaps --json` answers
// that from ic's own rule (ic-swaps.ts), so no process judges ic's record a second way. What is left of the records is the
// list of sandboxes ic knows of, which the keeper needs while Docker is down.

// Where ic keeps its records: INTENTIC_HOME when set, which ic honours, else `.intentic` under the home this agent uses.
export const icHome = (env: NodeJS.ProcessEnv = process.env): string => {
    const set = env["INTENTIC_HOME"];
    return set === undefined || set === "" ? join(homeDir(), ".intentic") : set;
};

// One sandbox's swap, as far as a reader that only asks "is something going on" needs it. `phase` is ic's word, kept as
// written so a phase a newer ic adds still reads as "something is going on"; `at` is when the cutover began and
// `probationUntil` when the watch lets go, both ms. ic's answer (`DeviceSwap`) is assignable to it.
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

// The longest a restart of this agent waits for a swap to finish, whoever started it. A live cutover is bounded by ic's own
// timeouts (the download, the pre-flight, the readiness wait), well inside this; past it the agent goes ahead rather than
// wait for ever on a swap that is not ending, and the probation watch settles whatever it left.
export const SWAP_WAIT_MAX_MS = 30 * 60_000;
