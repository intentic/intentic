import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { readTextIfExists, writeFileAtomic } from "@intentic/base/fs";
import type { Log } from "@intentic/local-agent";
import type { CiFleetPass } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { FleetConfig } from "./config.js";
import { type Discovery, discoverRunners } from "./discover.js";
import { type Holds, readHolds, writeHolds } from "./fleet-holds.js";
import { type FleetStatus, FleetStatusSchema } from "./protocol.js";
import type { FleetSys } from "./sys.js";

/* WHAT EVERY PART OF THE FLEET SERVICE SHARES: its settings, the seam to the computer, its log, the runners as they are
   now, the record of which are down on purpose, and the status the socket answers with. One instance per service
   process (fleet-service.ts); a test builds its own over a temp state folder and a fake computer (ci-fleet-testing.ts). */

// How many lines of one pass are kept: the newest, as a journal keeps them.
const PASS_LINES_KEPT = 200;

const statusPath = (stateDir: string): string => join(stateDir, "status.json");

export interface FleetContext {
    readonly config: FleetConfig;
    readonly sys: FleetSys;
    readonly log: Log;
    // The runners now, with the holds as they stand.
    readonly discover: () => Promise<Discovery>;
    // The holds, changed one change at a time: `change` gets the current record and returns the next.
    readonly holds: {
        readonly read: () => Promise<Holds>;
        readonly change: (change: (holds: Holds) => Holds) => Promise<Holds>;
    };
    readonly status: {
        readonly read: () => FleetStatus;
        // Merges `part` into the status and writes it out, world-readable, for the person's agent.
        readonly update: (part: Partial<FleetStatus>) => Promise<void>;
    };
    // Work the service must not restart under (a unit op, a pass, a registration): the self-update waits for none.
    readonly busy: { readonly hold: () => () => void; readonly count: () => number };
}

// A pass as the status keeps it: its newest lines only.
export const keptPass = (pass: CiFleetPass): CiFleetPass => ({ ...pass, lines: pass.lines.slice(-PASS_LINES_KEPT) });

// One queue for every change of a file, so two changes read and write in turn.
const serialized = (): (<T>(work: () => Promise<T>) => Promise<T>) => {
    let tail: Promise<unknown> = Promise.resolve();
    return async <T>(work: () => Promise<T>): Promise<T> => {
        const turn = tail.then(work, work);
        // allow(silent-catch): the failure reaches the caller through `turn`; the tail only keeps the next change in order
        tail = turn.catch(() => undefined);
        return await turn;
    };
};

export const createFleetContext = async (config: FleetConfig, sys: FleetSys, log: Log, version: string): Promise<FleetContext> => {
    await mkdir(config.stateDir, { recursive: true, mode: 0o755 });
    const kept = await readTextIfExists(statusPath(config.stateDir));
    const before = kept === undefined ? undefined : parseJsonWith(kept, FleetStatusSchema);
    let status: FleetStatus = { ...before, caches: before?.caches ?? [], version, startedAt: new Date(sys.now()).toISOString() };
    const inTurn = serialized();
    const statusTurn = serialized();
    let busy = 0;
    const holds = {
        read: async () => await readHolds(config.stateDir),
        change: async (change: (holds: Holds) => Holds) =>
            await inTurn(async () => {
                const next = change(await readHolds(config.stateDir));
                await writeHolds(config.stateDir, next);
                return next;
            }),
    };
    return {
        config,
        sys,
        log,
        discover: async () => await discoverRunners(sys, await holds.read(), config.janitor.runnersGlob),
        holds,
        status: {
            read: () => status,
            update: async (part) =>
                await statusTurn(async () => {
                    status = { ...status, ...part };
                    await writeFileAtomic(statusPath(config.stateDir), `${JSON.stringify(status, undefined, 2)}\n`, 0o644);
                }),
        },
        busy: {
            hold: () => {
                busy += 1;
                let released = false;
                return () => {
                    if (!released) {
                        released = true;
                        busy -= 1;
                    }
                };
            },
            count: () => busy,
        },
    };
};
