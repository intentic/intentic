import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defineStep } from "../store/evolution/state-steps.js";

// THE ROLE KITS' FOLDER, MOVED WITH THE NAME (2026-11-18). Personas were renamed roles, and their file moves by its own
// document's `movedFrom` (roles-store.ts); each card's kit (its PROMPT.md and its own skills) lived in
// `.intentic/config/personas/<id>/` and belongs in `.intentic/config/roles/<id>/`. Renamed as a tree, instant on one
// volume and put back by the journal on a rollback. Where the new folder already holds a kit of the same id (made again
// after the update), that one wins and the old one stays where it is for its owner to look at.

// Spelled here rather than through state-paths.ts, which lists only the addresses the daemon still keeps.
const OLD = join(STATE_DIR, "config", "personas");
const NEW = join(STATE_DIR, "config", "roles");

export const roleKitsFolderStep = defineStep({
    id: "persona-kits-to-roles",
    describe: "moves each role's kit from the personas folder to the roles folder",
    phase: "layout",
    plan: async ({ roots, kind, list }) => {
        const from = join(roots.workspace, OLD);
        if ((await kind(from)) !== "directory") {
            return undefined;
        }
        const to = join(roots.workspace, NEW);
        if ((await kind(to)) === undefined) {
            return { changes: [`moves the role kits from ${OLD} to ${NEW}`], writes: new Map(), renames: new Map([[from, to]]) };
        }
        const taken = new Set(await list(to));
        const moving = (await list(from)).filter((name) => !taken.has(name));
        if (moving.length === 0) {
            return undefined;
        }
        return {
            changes: [`moves ${moving.length} role kit(s) from ${OLD} to ${NEW}, beside the ones already there`],
            writes: new Map(),
            renames: new Map(moving.map((name) => [join(from, name), join(to, name)])),
        };
    },
});
