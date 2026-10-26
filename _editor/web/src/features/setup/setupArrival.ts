import type { SandboxSummary } from "@intentic/api-contract";

// What a sandbox being set up has already been through, read off its row. (2026-10-26) The rest of this module decided
// what arriving on /setup did by itself (start a machine, hand the install to the app, or draw a picker); that page is
// gone, and a new sandbox is made, or one left unfinished finished, on a press on Home (features/home/newSandbox/).

/** A folder of the reader's computer a sandbox is set up for: its own name, and where it lands in the sandbox. */
export interface SetupProject {
    // The folder's own name, which a sandbox made for it is called.
    readonly name: string;
    // Where the folder lands in the sandbox (`/work/<dirName>`).
    readonly dirName: string;
}

// A row with history: redeemed, reported on, or checked in. Finding a row again (a reload, a reopened tab) is not
// history; only genuine acts count.
export const touched = (row: SandboxSummary): boolean =>
    // `?? null` on each: fields are optional as well as nullable on older rows, and `undefined !== null` touches every row.
    (row.lastSeenAt ?? null) !== null || (row.setupCodeClaimedAt ?? null) !== null || (row.setupReport ?? null) !== null;
