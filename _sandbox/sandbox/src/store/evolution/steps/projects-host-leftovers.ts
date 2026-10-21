import { join } from "node:path";
import { defineStep } from "../state-steps.js";

// The folder registry of the desktop app's one sandbox per computer (SANDBOX_PROJECTS_HOST), retired on 2026-10-21 when
// every folder got a sandbox of its own: which folders had attached, and where each was on the owner's computer.
// Nothing reads it any more, and the folders' copies, repos and history do not depend on it, so the step deletes it.
// Spelled here rather than through a document, since the daemon no longer keeps one there. It sits on /history.
const REGISTRY = "projects.json";

export const projectsHostLeftoversStep = defineStep({
    id: "projects-host-leftovers",
    describe: "deletes the folder registry of the retired one sandbox per computer that folders attached to",
    plan: async ({ roots, kind }) => {
        const registry = join(roots.history, REGISTRY);
        if ((await kind(registry)) !== "file") {
            return undefined;
        }
        return {
            changes: ["deletes the folder registry the retired one sandbox per computer left behind"],
            writes: new Map([[registry, undefined]]),
        };
    },
});
