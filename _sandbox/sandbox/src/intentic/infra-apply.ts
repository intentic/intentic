import type { Services } from "../composition.js";
import { applyEventsPath, resetEventsFile } from "./apply-events.js";

// The ONE way an infra apply runs: a one-shot tmux job in panel-infra-apply (human-readable pane, attachable
// via the global terminal panel, restart-adopted by main.ts) that mirrors its structured events to the durable
// apply events file. Shared by the /intentic/apply route and the service capability, so both surface in the
// same terminal, serialize on the same job, and feed the same ApplyProgress tail.
export const INFRA_APPLY_KEY = "infra-apply";

// Launch the apply → adopt job (the service capability prefixes `resolve` — its declared entry must be
// resolved into the artifact first). False when a job is already running: the live run (and its events file)
// is left untouched — resetting would truncate a file being tailed.
export const startInfraApplyJob = async (
    services: Pick<Services, "processes" | "config" | "workspace">,
    options?: { readonly resolveFirst?: true },
): Promise<boolean> => {
    if (services.processes.running(INFRA_APPLY_KEY)) {
        return false;
    }
    const eventsPath = applyEventsPath(services.config.historyRoot);
    // Truncate + write {kind:"start"} before launching so a tail opened right after the caller returns sees a
    // fresh file, never the previous run's events.
    await resetEventsFile(eventsPath);
    await services.processes.start(INFRA_APPLY_KEY, {
        command:
            options?.resolveFirst === true
                ? "intentic deploy resolve && intentic deploy apply --yes && intentic deploy adopt"
                : "intentic deploy apply && intentic deploy adopt",
        cwd: services.workspace.root,
        // Every command in the chain mirrors its events (and its {kind:"exit"}) to the same durable file —
        // adopt's exit (or a failed earlier command's) is the whole-job completion signal.
        env: { INTENTIC_EVENTS_FILE: eventsPath },
        // The shell returning to its prompt flips `running` → false, which is how InfraDeclare's poll
        // observes completion of the whole chain.
        oneShot: true,
    });
    return true;
};
