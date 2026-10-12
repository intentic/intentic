import { serialLock } from "@intentic/base/async";
import type { Services } from "../composition.js";
import { stateRelPath } from "../state-paths.js";
import { composeEnvironment } from "./environment.js";

// The approved overlay is a derived file, composed when the daemon itself changes what goes into it: an approval, a
// capability saved, a privacy policy, a boot. Two of its inputs are versioned workspace files, though, and a land, a
// commit, a checkout or a hand edit rewrites them without passing through any of that. Nothing recomposed, the overlay on
// disk stayed the one composed before the change; a rebuild baked that, the next boot composed the new one, and the card
// read "pending rebuild" straight after the rebuild (2026-10-12: a landed custom section, the second time round).
const OVERLAY_INPUTS: ReadonlySet<string> = new Set([
    stateRelPath(".intentic/config/environment.custom.Dockerfile"),
    // The capability manifest, by the path the table declares for it: environment does not reach into capabilities.
    stateRelPath(".intentic/config/capabilities.json"),
]);

// Whether a watcher batch may have moved an input. An unnamed batch could hold anything (batch-relevance.ts), so it does.
export const overlayInputsMoved = (paths: readonly string[]): boolean => paths.length === 0 || paths.some((path) => OVERLAY_INPUTS.has(path));

// Recomposes after every batch that may have moved an input. Composing writes the overlay only when its text changed, so
// the batch carrying that write, or an approve's own, recomposes to the same bytes and stops there.
export const recomposeOnInputChanges = (services: Services, subscribe: (listener: (paths: string[]) => void) => () => void): (() => void) => {
    // One compose at a time: two overlapping would each read the overlay and write their own over it.
    const serially = serialLock();
    return subscribe((paths) => {
        if (!overlayInputsMoved(paths)) {
            return;
        }
        void serially(() => composeEnvironment(services)).catch((error) =>
            services.logger.warn({ err: error }, "environment: the approved environment could not be recomposed after its inputs changed"),
        );
    });
};
