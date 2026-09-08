import { ENGINE_IDS, type EngineId } from "@intentic/sandbox-contract";
import type { InvariantCheck } from "../invariants/invariants.js";
import { type EngineState, installedVersions, isQuarantined, readEngineState } from "./engine-store.js";

// Checks that `active` names a version actually on disk, and that it is never also quarantined; state.json is data, not
// a symlink, so an rm -rf, a half-finished GC, or a racing install can leave the pointer and the directory disagreeing.
// Left uncaught, the daemon falls back to the image silently while the card and channel still claim the store's
// version.

export interface EngineStoreDeps {
    // Overridden by tests; production reads the volume store (INTENTIC_ENGINES_DIR, or /history/engines).
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
        // Boot too, not just sweep: a prior life's install or GC could dangle the pointer before the first turn.
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
