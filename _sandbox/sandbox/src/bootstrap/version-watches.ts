import { startEngineWatch } from "../engines/engines.js";
import { startExtensionUpdateWatch } from "../extensions/extension-updates.js";
import { startAutoUpdate } from "./update-when-quiet.js";
import { startReleaseNotesCheck } from "../system/updates/release-notes.js";
import { onLatestVersion, startVersionCheck } from "../system/updates/version-check.js";
import { autoUpdater } from "../system/updates/auto-update.js";
import { onRuntimeChange, publishRuntimeChange } from "../seams/runtime-feed.js";
import type { BootPhase } from "./boot-phase.js";

// All warmed off the request path; none blocks anything.
export const startVersionWatches = (phase: BootPhase): void => {
    const { traits, role, services, shutdown } = phase;
    // Meaningless for a local daemon.
    const versionCheck = traits.containerUpdates ? startVersionCheck() : undefined;
    shutdown.push(() => versionCheck?.stop());
    if (versionCheck !== undefined) {
        // A newly known release reaches the update card (`system.info`, invalidated by "update") and the automatic
        // update now, instead of at their next poll.
        shutdown.push(
            onLatestVersion(() => {
                publishRuntimeChange("update");
                autoUpdater()?.poke();
            }),
        );
        // A computer of the owner's dialling in on a newer release than this sandbox knows of: look for it now.
        const lookAtHosts = (): void => {
            const seen = services.hostHub.connected().flatMap((id) => {
                const version = services.hostHub.state(id).announced?.version;
                return version === undefined ? [] : [version];
            });
            versionCheck.notice(seen, services.info?.version);
        };
        lookAtHosts();
        shutdown.push(onRuntimeChange((domains) => (domains.includes("hosts") ? lookAtHosts() : undefined)));
    }

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
