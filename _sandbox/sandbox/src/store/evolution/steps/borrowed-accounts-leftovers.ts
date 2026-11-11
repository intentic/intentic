import { join } from "node:path";
import { defineStep } from "../state-steps.js";

// What account borrowing kept, retired on 2026-11-11 with accounts links (links.md): each model account another of the
// owner's sandboxes lent this one, as where to ask for it. It held no credential, and nothing reads it any more, so the
// step deletes it. Spelled here rather than through state-paths.ts, which lists only what the daemon still keeps.
const BORROWED = ["identity", "borrowed-accounts.json"] as const;

export const borrowedAccountsLeftoversStep = defineStep({
    id: "borrowed-accounts-leftovers",
    describe: "deletes the list of model accounts the retired accounts links borrowed",
    plan: async ({ roots, kind }) => {
        const borrowed = join(roots.history, ...BORROWED);
        if ((await kind(borrowed)) !== "file") {
            return undefined;
        }
        return {
            changes: ["deletes the borrowed-accounts list the retired accounts links left behind"],
            writes: new Map([[borrowed, undefined]]),
        };
    },
});
