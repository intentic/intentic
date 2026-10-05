import type { Log } from "@intentic/local-agent";

/* ONE ENTRY OF THE KNOWN-ARTIFACTS MANIFEST (manifest.ts). Each says how to find one kind of thing an install of this
   agent may hold, and what is done with it. An entry is either an idempotent check (it finds nothing once the thing is
   gone, so it costs a few stats on every pass) or, where finding is dear, done ONCE behind a marker of its own, under
   `~/.intentic/machine/upkeep/<id>`. Never one marker for all: an entry a later release adds runs on every machine,
   whatever the earlier entries left there. */

// What is done with what an entry finds:
// - retire: an entry or a workaround that starts something, turned off and removed;
// - trash: moved into `~/.intentic/machine/trash/<stamp>-<name>`, where a person can still take it back;
// - prune: deleted, for what is already past its keeping (the trash itself, half downloads);
// - rotate: a log set aside as `<name>.1` once it is too big;
// - repair: an entry put back the way this build writes it;
// - report: nothing this agent may change, said so a person can.
export type UpkeepAction = "retire" | "trash" | "prune" | "rotate" | "repair" | "report";

// Where an entry looks. Paths come from here, never from a module's constants, so a test runs the manifest over a home
// of its own.
export interface UpkeepContext {
    readonly log: Log;
    readonly now: number;
    // The user's home, and this agent's state under it (`~/.intentic/machine`).
    readonly home: string;
    readonly base: string;
    readonly platform: NodeJS.Platform;
    // Who restarts this environment's agent, as the resident stamped it beside its pid (task, systemd, windows…);
    // undefined when no agent is running.
    readonly supervisor: string | undefined;
    // Whether this pass runs inside the resident agent, the process its login entry starts, rather than a `doctor`.
    readonly resident: boolean;
}

// One thing found. `act` brings it to the current shape; absent, it is skipped, and `why` says why (a process still
// runs from it, it is not this agent's to change, it could not be read).
export interface Finding {
    readonly what: string;
    readonly act?: () => Promise<void>;
    readonly why?: string;
}

export interface UpkeepEntry {
    // Stable for good: it names the entry's marker and its line in a report.
    readonly id: string;
    // What upkeep.json counts it under; several entries may share one.
    readonly kind: string;
    readonly action: UpkeepAction;
    // Why this kind of thing goes, said once per entry by `doctor`.
    readonly reason: string;
    // Done once, behind its own marker; `formerMarker` is a file under `~/.intentic/machine` that an earlier build wrote
    // for the same work, which counts as done (and is moved to the new marker by the first pass that fixes).
    readonly once?: boolean;
    readonly formerMarker?: string;
    readonly find: (context: UpkeepContext) => Promise<readonly Finding[]>;
}
