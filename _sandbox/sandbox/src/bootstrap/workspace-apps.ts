import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { type StarterReadiness, waitForStarter } from "../system/boot/prewarm.js";
import { answers } from "../ports/port-probe.js";
import { runAutostart } from "../scaffold/autostart.js";
import { appPanelKey } from "../workspace/layout/app-previews.js";
import type { BootPhase } from "./boot-phase.js";

// Runs past the data gate, after the stale-session sweep and after the baseline commit a dev server's first build would dirty.

// Observed, never awaited: the starter answering is a preview concern, not a readiness one.
const noteStarterReadiness = (logger: Logger, pending: Promise<StarterReadiness>): void => {
    void pending
        .then((readiness) => {
            if (readiness !== "ready") {
                logger.warn(
                    { key: appPanelKey(STARTER_REPO, STARTER_APP), readiness },
                    "autostart: starter did not answer before the readiness window closed",
                );
            }
        })
        .catch((error: unknown) => logger.warn({ err: error }, "autostart: the starter's readiness could not be observed"));
};

export const startWorkspaceApps = async ({ logger, traits, role, services }: BootPhase, prewarm: boolean): Promise<void> => {
    if (!role.roots || !traits.ownsWorkspaceConfig) {
        return;
    }
    const outcome = await runAutostart(services).catch((error: unknown) => {
        logger.warn({ err: error }, "autostart: the list could not be read, nothing started");
        return undefined;
    });
    if (outcome !== undefined && (outcome.started.length > 0 || outcome.skipped.length > 0)) {
        logger.info(outcome, "autostart: workspace apps");
    }
    const starterKey = appPanelKey(STARTER_REPO, STARTER_APP);
    // A prewarm boot stops once the starter is warm, so nothing would be alive to hear the answer.
    if (prewarm || outcome?.started.includes(starterKey) !== true) {
        return;
    }
    noteStarterReadiness(
        logger,
        waitForStarter({ starterKey, processes: services.processes, answers: (port) => answers("http", port) }, { maxMs: 30_000 }),
    );
};
