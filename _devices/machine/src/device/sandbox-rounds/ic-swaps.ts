import { execBounded } from "@intentic/base/process";
import { type DeviceSwap, DeviceSwapsSchema } from "@intentic/sandbox-contract";
import { homeDir } from "@intentic/local-agent";
import { icCandidates } from "../tools/ic-binary.js";
import { swapsFromFiles } from "./swaps-fallback.js";

// WHICH SWAPS ARE GOING ON IN THIS ENVIRONMENT, as `ic` says. A swap parks a sandbox's container and starts its
// replacement, and stopping this agent between the two is what left sandboxes down; so the agent's restarts and upgrades
// wait for a cutover, the keeper skips a sandbox mid-swap, the probation watch asks about the sandboxes that have a swap,
// and file sync holds still around one. All of them used to read ic's channel record and judge it themselves, and judged
// it differently from ic: ic calls a cutover interrupted 90 seconds after its heartbeat stops, and they believed its start
// time for half an hour. Now `ic sandbox swaps --json` is the one reader. It reads ic's home and not Docker, so it answers
// while Docker is down, which is when this agent most needs it (a Docker Desktop that is starting is no reason to restart
// the agent under a parked container).

// Docker-free and fast; a run that takes longer than this is an ic in trouble, and the fallback answers.
const SWAPS_TIMEOUT_MS = 15_000;

export const swapsArgs = ["sandbox", "swaps", "--json"] as const;

// `ic sandbox swaps --json` prints one line of JSON on stdout, an array with a row per swap. Parsed, not trusted: anything
// else (an ic that prints its usage for a verb it does not know, a row of a shape this agent cannot read) is undefined,
// which the caller answers with the fallback.
export const swapsFrom = (stdout: string): DeviceSwap[] | undefined => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("["));
    if (line === undefined) {
        return undefined;
    }
    try {
        const parsed = DeviceSwapsSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is not ic's answer, which is what undefined says
        return undefined;
    }
};

// What the answer needs of the world, so the choice between ic and the fallback is asserted without a binary.
export interface SwapsSeams {
    // ic's stdout for `swaps --json`; undefined when ic could not answer it (none installed, too old to know the verb, or
    // it failed).
    readonly ic: () => Promise<string | undefined>;
    // COMPAT(ic-swaps): remove with swaps-fallback.ts, in the release after the one that first ships `ic sandbox swaps`.
    readonly files: () => Promise<DeviceSwap[]>;
}

const askIc = async (): Promise<string | undefined> => {
    for (const binary of icCandidates(process.platform, homeDir())) {
        // allow(silent-catch): a candidate that is missing, too old for the verb, or failing has no answer, and the next is tried
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are tried in order; the first that answers wins
        const answer = await execBounded(binary, [...swapsArgs], { timeoutMs: SWAPS_TIMEOUT_MS }).catch(() => undefined);
        if (answer !== undefined) {
            return answer.stdout;
        }
    }
    return undefined;
};

export const DEFAULT_SWAPS_SEAMS: SwapsSeams = { ic: askIc, files: async () => await swapsFromFiles() };

// Every sandbox whose record names a swap in flight or on probation, with ic's verdict on each cutover. ic's answer when it
// gives one; otherwise (COMPAT(ic-swaps): an ic from before the command) the same rule applied to the same records here.
export const readSwaps = async (seams: SwapsSeams = DEFAULT_SWAPS_SEAMS): Promise<DeviceSwap[]> => {
    const stdout = await seams.ic();
    const answered = stdout === undefined ? undefined : swapsFrom(stdout);
    return answered ?? (await seams.files());
};

// The sandboxes a restart of this agent would leave down if it went ahead now: the cutovers a live ic run is doing.
export const swapsUnderway = (swaps: readonly DeviceSwap[]): string[] => swaps.filter((swap) => swap.cutoverInProgress).map((swap) => swap.slug);
