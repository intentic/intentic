import type { Services } from "../composition.js";
import { applyEventsPath, resetEventsFile } from "./apply-events.js";

// The one way an infra apply runs; shared by the apply route and service capability, so both serialize on it.
export const INFRA_APPLY_KEY = "infra-apply";

// Launches the apply → adopt job (service capability prefixes resolve first). Returns false if already running, leaving
// the live run and its events file untouched rather than truncating a file being tailed.
export const startInfraApplyJob = async (
    services: Pick<Services, "processes" | "config" | "workspace">,
    options?: { readonly resolveFirst?: true },
): Promise<boolean> => {
    if (services.processes.running(INFRA_APPLY_KEY)) {
        return false;
    }
    const eventsPath = applyEventsPath(services.config.historyRoot);
    // Resets the file before launching so a tail opened right after sees a fresh file, not the previous run's.
    await resetEventsFile(eventsPath);
    await services.processes.start(INFRA_APPLY_KEY, {
        command:
            options?.resolveFirst === true
                ? "intentic deploy resolve && intentic deploy apply --yes && intentic deploy adopt"
                : "intentic deploy apply && intentic deploy adopt",
        cwd: services.workspace.root,
        // Every chained command mirrors events to the same file; adopt's exit, or an earlier failure, is completion.
        env: { INTENTIC_EVENTS_FILE: eventsPath },
        // Shell returning to prompt flips `running` false; that's how InfraDeclare's poll sees the chain finish.
        oneShot: true,
    });
    return true;
};
