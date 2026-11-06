import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defineStep } from "../state-steps.js";

// What the field notes kept, retired on 2026-11-06 when the brief went for moving nothing it was measured on: the brief
// each conversation was first sent, pinned so its later turns sent the same bytes. Nothing reads it any more, so the step
// deletes it. Spelled here rather than through state-paths.ts, which lists only what the daemon still keeps. The brief
// itself (`config/field-notes.toon`) is the owner's tracked file and is left for them to delete.
const PINS = ["local", "cache", "field-notes-pins.json"] as const;

export const fieldNotesLeftoversStep = defineStep({
    id: "field-notes-leftovers",
    describe: "deletes what the retired field notes kept: the brief each conversation was pinned to",
    plan: async ({ roots, kind }) => {
        const pins = join(roots.workspace, STATE_DIR, ...PINS);
        if ((await kind(pins)) !== "file") {
            return undefined;
        }
        return {
            changes: ["deletes the pins the retired field notes left behind"],
            writes: new Map([[pins, undefined]]),
        };
    },
});
