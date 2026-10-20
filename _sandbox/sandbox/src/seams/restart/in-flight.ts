import type { RestartResume } from "../../agent/run/turn/recovery/restart-resume-policy.js";

/* WORK A RESTART CUT, RECOVERED ONE WAY. Work in flight (a turn, an automation fire, a spawned child, a workflow run, a
   kept job) is written down by the module that owns it, in its own document or table. What a boot does with what an
   earlier process left of it is declared beside that store, as one kind here: put it back as it was, run it again under
   this boot's restart answer, or say it was lost. Every kind is read once, before the gate opens (main.ts), when nothing
   in this process has written a record yet, so a kind never needs a mark of its own to tell what an earlier process left
   from what this one just wrote. Then each recovers what it was handed, one after another in the order
   bootstrap/restart/in-flight-kinds.ts lists them, under the one restart answer this boot gives (restart-resume-policy.ts).
   2026-10-20: a dozen boot passes had grown across four files, each reading its own ledger while live work wrote it, each
   with its own "is this mine" test (a boot uuid, a carried-ids set, a live-admissions set, a held-ids check), and two of
   them decided the fate of one paused child from contradictory facts. */

export interface InFlightKind<Left, Deps> {
    // What the log calls it.
    readonly name: string;
    // Recovered only by a daemon holding that claim (system/boot/container-owner.ts): `roots` for work on these volumes'
    // conversations, `container` for what lived in the container itself. Absent, by every daemon.
    readonly claim?: "roots" | "container";
    // Every record of it on file, read before the gate opens. A throw recovers nothing of the kind this boot, and its
    // records wait on file for the next.
    readonly read: (deps: Deps) => Promise<readonly Left[]>;
    // Acts on what an earlier process left: never throws for one record, each says its own failure in the log.
    readonly recover: (deps: Deps, left: readonly Left[], resume: RestartResume) => Promise<void>;
}

// A kind with its records read: what the pass runs, the record type closed over.
export interface LeftWork {
    readonly name: string;
    readonly count: number;
    readonly recover: (resume: RestartResume) => Promise<void>;
}

// A kind as the registry lists it, whatever its records' type.
export interface InFlight<Deps> {
    readonly name: string;
    readonly claim: "roots" | "container" | undefined;
    readonly read: (deps: Deps) => Promise<LeftWork>;
}

export const defineInFlight = <Left, Deps>(kind: InFlightKind<Left, Deps>): InFlight<Deps> => ({
    name: kind.name,
    claim: kind.claim,
    read: async (deps) => {
        const left = await kind.read(deps);
        return { name: kind.name, count: left.length, recover: (resume) => kind.recover(deps, left, resume) };
    },
});

// Says a kind that could not be read or recovered; the pass goes on to the next.
export type InFlightFailed = (kind: string, stage: "read" | "recover", error: Error) => void;

/** Every kind's records, each read on its own: one that cannot be read recovers nothing this boot, its records kept. */
export const readLeftWork = async <Deps>(deps: Deps, kinds: readonly InFlight<Deps>[], failed: InFlightFailed): Promise<readonly LeftWork[]> =>
    (
        await Promise.all(
            kinds.map(async (kind): Promise<readonly LeftWork[]> =>
                kind.read(deps).then(
                    (left) => [left],
                    (error: Error) => {
                        failed(kind.name, "read", error);
                        return [];
                    },
                ),
            ),
        )
    ).flat();

/** Recovers what was read, kind after kind in the order given: a later kind stands on what an earlier one put back. */
export const recoverLeftWork = async (left: readonly LeftWork[], resume: RestartResume, failed: InFlightFailed): Promise<void> => {
    for (const work of left) {
        await work.recover(resume).catch((error: Error) => failed(work.name, "recover", error));
    }
};
