import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import type { DeviceSwap } from "@intentic/sandbox-contract/schemas/device-swaps";
import { icHome, slugOfRecord } from "./swap-records.js";

/* COMPAT(ic-swaps): REMOVE THIS FILE IN THE RELEASE AFTER THE ONE THAT FIRST SHIPS `ic sandbox swaps` (the second release
 * with that command in every ic). Delete it, `readSwaps`'s `files` seam (ic-swaps.ts) and swaps-fallback.test.ts.
 *
 * `ic` owns the question "is a cutover in progress": `ic sandbox swaps --json` answers it from ic's own rule
 * (probation.rs cutover_in_progress). This file is for the one release in which a new agent can meet an ic that does not
 * have the command yet (the agent and ic ship separately): it reads the channel records itself and applies THE SAME rule.
 * It does not decide anything of its own: golden/swap-verdicts.json holds each record and the row ic gives for it, and
 * swaps-fallback.test.ts holds this reader to every one, boundary by boundary, as ic's Rust test does.
 *
 * What it does NOT keep from the reader it replaced: the half hour a cutover record was believed for (CUTOVER_HOLDS_MS),
 * and the two-sided window around now. An ic killed mid-swap leaves a record that ic itself calls interrupted after 90
 * seconds; believing it for 30 minutes held the agent's restarts and upgrades for that long on a swap nobody was doing. */

// A cutover's heartbeat is a beat of a live ic run every HEARTBEAT_SECS; one older than this has no run behind it.
// Held to ic's constants (probation.rs HEARTBEAT_SECS, STALE_MS) by golden/swap-verdicts.json.
export const CUTOVER_HEARTBEAT_SECS = 15;
export const CUTOVER_STALE_MS = 90_000;

// ic parses these with `u64::from_str`: digits, an optional leading `+`, no spaces, and a value that does not parse is a
// key that is not there. Notably 0 is a number (a heartbeat of nought is a stale one, not an absent one).
const unsigned = (value: string | undefined): number | undefined => {
    if (value === undefined || !/^\+?\d+$/.test(value)) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
};

// A cutover in progress, ic's rule over the facts of its record: the phase is `cutover` and the run's own heartbeat, else
// the cutover's start when it has not beaten yet, is under CUTOVER_STALE_MS old. A time from the future (a clock moved
// back) is no age at all, as ic's saturating subtraction reads it.
export const cutoverInProgress = (phase: string, at: number, alive: number | undefined, now: number): boolean =>
    phase === "cutover" && Math.max(0, now - (alive ?? at)) < CUTOVER_STALE_MS;

// `key=value` lines under ic's own rules (record.rs `parse`): the last occurrence wins, an unknown key is ignored, a line
// without `=` is not a line, a value is taken as written. Pure, so the format is asserted without a file.
const valuesOf = (text: string): Map<string, string> => {
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf("=");
        if (at >= 0) {
            values.set(line.slice(0, at), line.slice(at + 1));
        }
    }
    return values;
};

// One record's swap as ic's `swaps --json` would give it: undefined when the record names no swap (a phase this ic does
// not know, or a phase with no start time, is none, as in ic's `swap_of`).
export const swapOfRecord = (slug: string, text: string, now: number): DeviceSwap | undefined => {
    const values = valuesOf(text);
    const phase = values.get("swap_phase");
    const at = unsigned(values.get("swap_at"));
    if ((phase !== "cutover" && phase !== "probation") || at === undefined) {
        return undefined;
    }
    const alive = unsigned(values.get("swap_alive"));
    const until = phase === "probation" ? unsigned(values.get("probation_until")) : undefined;
    return { slug, phase, at, alive, probationUntil: until, cutoverInProgress: cutoverInProgress(phase, at, alive, now) };
};

// Every swap in ic's home, read off the records. A home ic has never written, or one that cannot be read, has none: this
// feeds deferrals and pauses, and none of them may stop the agent over a directory it does not own.
export const swapsFromFiles = async (home: string = icHome(), now: number = Date.now()): Promise<DeviceSwap[]> => {
    // allow(silent-catch): no readable home is no record, the same answer as a machine that never swapped
    const names = await readdir(home).catch((): string[] => []);
    const swaps = await Promise.all(
        names.map(async (name) => {
            const slug = slugOfRecord(name);
            // A record that vanished between the listing and the read is a swap that ended.
            const text = slug === undefined ? undefined : await readTextIfExists(join(home, name));
            return slug === undefined || text === undefined ? undefined : swapOfRecord(slug, text, now);
        }),
    );
    return swaps.filter((swap) => swap !== undefined).toSorted((left, right) => left.slug.localeCompare(right.slug));
};
