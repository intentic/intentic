import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execBounded } from "@intentic/base/process";
import { parseJsonWith } from "@intentic/base/json";
import { type DeviceSwap, DeviceSwapsSchema } from "@intentic/sandbox-contract/schemas/device-swaps";
import { homeDir } from "@intentic/local-agent";
import { icCandidates } from "../tools/ic-binary.js";
import { askIcServe } from "../tools/ic-serve/ic-serve.js";
import { sharedReading } from "../tools/listing/ic-readings.js";
import { icHome, slugOfRecord } from "./swap-records.js";
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
    return parseJsonWith(line, DeviceSwapsSchema);
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
    // The resident ic's answer when it has one (ic-serve.ts); a failure or a timeout there is no answer, as here.
    const served = await askIcServe(swapsArgs, SWAPS_TIMEOUT_MS);
    if (served !== undefined) {
        return served === "timeout" || served.code !== 0 ? undefined : served.stdout;
    }
    for (const binary of icCandidates(process.platform, homeDir())) {
        // allow(silent-catch): a candidate that is missing, too old for the verb, or failing has no answer, and the next is tried
        // candidates are tried in order; the first that answers wins
        const answer = await execBounded(binary, [...swapsArgs], { timeoutMs: SWAPS_TIMEOUT_MS }).catch(() => undefined);
        if (answer !== undefined) {
            return answer.stdout;
        }
    }
    return undefined;
};

export const DEFAULT_SWAPS_SEAMS: SwapsSeams = { ic: askIc, files: async () => await swapsFromFiles() };

const readSwapsWith = async (seams: SwapsSeams): Promise<DeviceSwap[]> => {
    const stdout = await seams.ic();
    const answered = stdout === undefined ? undefined : swapsFrom(stdout);
    return answered ?? (await seams.files());
};

/* (2026-11-24) ONE ANSWER FOR EVERY READER. The mirror pass asks every 5 s, the probation watch every minute, the keeper
   and the auto-upgrade when they decide, and each ask was an `ic` process. ic's answer is a reading of its channel records,
   so it is held while they stay as they were: a record written (a swap begun, a cutover's heartbeat every 15 s, a swap
   ended) is a different stamp and is read again, and SWAPS_HELD_MS bounds the one change no file shows, a cutover whose
   heartbeat went stale (ic calls it interrupted 90 s after the last beat), and the restart gate asks fresh. */
const SWAPS_HELD_MS = 30_000;

// The channel records as they stand on disk, by name, size and modification time: what ic's answer is read from. A home
// that cannot be read is one stamp like any other, and a record that vanished between listing and stat is left out.
export const channelStamp = async (home: string = icHome()): Promise<string> => {
    // allow(silent-catch): no readable home is no record, the same answer swapsFromFiles gives
    const names = await readdir(home).catch((): string[] => []);
    const stamps = await Promise.all(
        names
            .filter((name) => slugOfRecord(name) !== undefined)
            .toSorted()
            .map(async (name) => {
                // allow(silent-catch): a record gone between the listing and the stat is a swap that ended, and no stamp
                const info = await stat(join(home, name)).catch(() => undefined);
                return info === undefined ? "" : `${name}:${info.size}:${info.mtimeMs}`;
            }),
    );
    return stamps.join("|");
};

const shared = sharedReading(async () => await readSwapsWith(DEFAULT_SWAPS_SEAMS), { heldMs: SWAPS_HELD_MS, stamp: async () => await channelStamp() });

// Every sandbox whose record names a swap in flight or on probation, with ic's verdict on each cutover. ic's answer when it
// gives one; otherwise (COMPAT(ic-swaps): an ic from before the command) the same rule applied to the same records here.
// Without `seams` it is the one answer every reader shares (above); `fresh` asks ic again whatever is held.
export const readSwaps = async (seams?: SwapsSeams, { fresh = false }: { readonly fresh?: boolean } = {}): Promise<DeviceSwap[]> =>
    seams === undefined ? [...(await shared.get({ fresh }))] : await readSwapsWith(seams);

// The sandboxes a restart of this agent would leave down if it went ahead now: the cutovers a live ic run is doing.
export const swapsUnderway = (swaps: readonly DeviceSwap[]): string[] => swaps.filter((swap) => swap.cutoverInProgress).map((swap) => swap.slug);
