import { ENGINE_IDS, type EngineId } from "@intentic/sandbox-contract";
import type { InvariantCheck } from "../invariants/invariants.js";
import { type EngineState, installedVersions, isQuarantined, readEngineState } from "./engine-store.js";

/* THE POINTER NAMES A COPY THAT IS THERE, or turns are running something other than what the card says.
 *
 * state.json is data, not a symlink (engine-store.ts), which is what makes activation atomic and reverting a
 * pointer move. It is also what lets the pointer and the directory disagree: an `rm -rf` on the volume, a
 * garbage collection that half finished, a second daemon's install racing this one's, and `active` names a
 * version that is not on disk. engine-resolve.ts then does exactly what it promises: it falls back to the
 * image's copy, silently, on every turn, because a read in the turn path must not throw. The card still shows
 * the store's version, the channel still reads `pinned`, and the sandbox is quietly running whatever the image
 * bakes, which is the one thing the whole mechanism exists to stop depending on.
 *
 * The same shape from the other side: an active version that is ALSO quarantined. The two writes that keep
 * those apart (activateVersion drops the quarantine entry, quarantineVersion drops `active`) are this daemon's,
 * and the file sits on a volume a rolled-back build or a hand edit can write too. */

export interface EngineStoreDeps {
    // Overridden by tests; production reads the store on the volume (INTENTIC_ENGINES_DIR, or /history/engines).
    readonly engineState?: (id: EngineId) => Promise<EngineState>;
    readonly installedVersions?: (id: EngineId) => Promise<string[]>;
}

export const owner = "engines";

export const checks = ({
    engineState = readEngineState,
    installedVersions: onDisk = installedVersions,
}: EngineStoreDeps = {}): readonly InvariantCheck[] => [
    {
        name: "active-engine-versions-are-on-disk",
        // Boot as well as the sweep: the previous life's install or GC is exactly what could have left the
        // pointer dangling, and the first turn is seconds away.
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const dangling: string[] = [];
            const contradictory: string[] = [];
            for (const id of ENGINE_IDS) {
                const state = await engineState(id);
                if (state.active === undefined) {
                    continue;
                }
                if (!(await onDisk(id)).includes(state.active)) {
                    dangling.push(`${id} ${state.active}`);
                }
                if (isQuarantined(state, state.active)) {
                    contradictory.push(`${id} ${state.active}`);
                }
            }
            if (dangling.length > 0) {
                return fail(
                    `${dangling.length} engine(s) point at a version that is not on disk (${dangling.join(", ")}): every turn is silently running the image's copy while the card and the channel say the store's`,
                );
            }
            if (contradictory.length > 0) {
                fail(
                    `${contradictory.length} engine(s) have an active version that is also quarantined (${contradictory.join(", ")}): the store refused it and is serving it`,
                );
            }
        },
    },
];
