import { startEngineWatch } from "../engines/engines.js";
import { startExtensionUpdateWatch } from "../extensions/extension-updates.js";
import { startAutoUpdate } from "./update-when-quiet.js";
import { startReleaseNotesCheck } from "../system/updates/release-notes.js";
import { startVersionCheck } from "../system/updates/version-check.js";
import type { BootPhase } from "./boot-phase.js";

// All warmed off the request path; none blocks anything.
export const startVersionWatches = (phase: BootPhase): void => {
    const { traits, role, services, shutdown } = phase;
    // Meaningless for a local daemon.
    const versionCheck = traits.containerUpdates ? startVersionCheck() : undefined;
    shutdown.push(() => versionCheck?.stop());

    const releaseNotesCheck = traits.containerUpdates ? startReleaseNotesCheck() : undefined;
    shutdown.push(() => releaseNotesCheck?.stop());

    // Takes a downloaded update by itself at a quiet moment; decides for itself whether this container is one it can.
    startAutoUpdate(phase);

    const extensionUpdateWatch = traits.extensionHost ? startExtensionUpdateWatch(services) : undefined;
    shutdown.push(() => extensionUpdateWatch?.stop());

    // Runs only where this daemon owns the container.
    const engineWatch = startEngineWatch(services, role);
    shutdown.push(() => engineWatch.stop());
};
