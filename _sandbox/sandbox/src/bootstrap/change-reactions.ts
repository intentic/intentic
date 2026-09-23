import { join } from "node:path";
import { startVanishedRepoSweep } from "../agents/registry/vanished-repos.js";
import { startSidecarService } from "../derived/sidecar-service.js";
import { onListenerStatusMoved } from "../extensions/listener-status.js";
import { startRefWatch, subscribeRefChanges } from "../git/remote/ref-watch.js";
import { ignoreFileMode } from "../git/remote/repo-git-dirs.js";
import { stateRelPath } from "../state-paths.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { startRepoWatch, subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { startWorkspaceWatch, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";
import type { BootPhase } from "./boot-phase.js";

// Three feeds, none of which sees what the others see: files (ignores .git), repos (clones and deletions), refs. Nothing polls.

// Module scope so the watcher doesn't rebuild this on every change batch.
const extensionSource = (path: string): boolean =>
    path.startsWith(`${stateRelPath(".intentic/config/workspace-extensions/")}/`) ||
    path.startsWith(`${stateRelPath(".intentic/local/extensions/")}/`) ||
    path === stateRelPath(".intentic/config/extension-enablement.json");

export const startChangeReactions = ({ logger, services, shutdown, traits }: BootPhase): void => {
    startWorkspaceWatch(services.workspace.root, logger);
    subscribeWorkspaceChanges(() => services.iq.markDirty());
    // Loaded code can't be unloaded, so a debounced restart is the reload.
    subscribeWorkspaceChanges((paths) => {
        if (paths.some(extensionSource)) {
            services.extensionBackend.restart();
        }
    });
    // The `sidecars` setting is read fresh each pass, so the switch works without a restart.
    shutdown.push(
        startSidecarService({ enabled: async () => (await services.sandboxSettings.get()).sidecars, logger }, subscribeWorkspaceChanges).stop,
    );
    startRepoWatch(services.workspace.root, logger);
    startRefWatch(services.workspace.root, subscribeRepoChanges, logger);
    // A ref can move without a workspace byte changing, so only the ref feed can invalidate health.
    shutdown.push(subscribeRefChanges(() => services.iq.invalidateHealth()));
    shutdown.push(startVanishedRepoSweep(services, subscribeRepoChanges));
    // A repo cloned mid-session gets the file-mode rule boot gave the rest, not a boot later.
    if (traits.relocateGitDirs) {
        shutdown.push(
            subscribeRepoChanges((repos) => {
                for (const repo of repos) {
                    void ignoreFileMode(join(services.workspace.root, repo)).catch((error: unknown) =>
                        logger.warn({ err: error, repo }, "could not persist core.fileMode=false, a terminal's git may see mode-only edits"),
                    );
                }
            }),
        );
    }
    // A gateway's live status is half of what the Activity view shows, and it has no file to watch.
    shutdown.push(onListenerStatusMoved(() => publishRuntimeChange("activity")));

    // Incremental, so a valid on-disk index survives a boot.
    void services.iq.warm().catch((error: unknown) => logger.warn({ err: error }, "iq index warmup failed, search runs on the index as it stands"));
};
