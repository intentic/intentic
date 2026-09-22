import { startEngineWatch } from "../engines/engines.js";
import { startExtensionUpdateWatch } from "../extensions/extension-updates.js";
import { startReleaseNotesCheck } from "../platform/boot/release-notes.js";
import { startVersionCheck } from "../platform/boot/version-check.js";
import { recordNewestRun } from "../store/newest-run.js";
import type { BootPhase } from "./boot-phase.js";

// All warmed off the request path; none blocks anything.
export const startVersionWatches = ({ config, traits, role, services, shutdown }: BootPhase): void => {
    // Forward-only, so a post-rollback manifest issue reads as "written by a newer intentic".
    if (role.roots) {
        void recordNewestRun(config.workspaceRoot).catch(() => undefined);
    }

    // Meaningless for a local daemon.
    const versionCheck = traits.containerUpdates ? startVersionCheck() : undefined;
    shutdown.push(() => versionCheck?.stop());

    const releaseNotesCheck = traits.containerUpdates ? startReleaseNotesCheck() : undefined;
    shutdown.push(() => releaseNotesCheck?.stop());

    const extensionUpdateWatch = traits.extensionHost ? startExtensionUpdateWatch(services) : undefined;
    shutdown.push(() => extensionUpdateWatch?.stop());

    // Runs only where this daemon owns the container.
    const engineWatch = startEngineWatch(services, role);
    shutdown.push(() => engineWatch.stop());
};
