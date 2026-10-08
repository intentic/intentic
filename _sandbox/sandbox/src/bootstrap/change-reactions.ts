import { join, relative } from "node:path";
import { startVanishedRepoSweep } from "../conversations/registry/vanished-repos.js";
import { capabilitiesDocument } from "../capabilities/capabilities-store.js";
import { invalidateContributions } from "../capabilities/contributions.js";
import { extensionsRoot, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import { extensionDevDocument } from "../extensions/extension-dev.js";
import { extensionEnablementDocument } from "../extensions/extension-enablement.js";
import { followExtensionDirs, stopPendingExtensionProcesses } from "../extensions/extension-processes.js";
import { onListenerStatusMoved } from "../extensions/listener/listener-status.js";
import { startRefWatch, subscribeRefChanges } from "../git/remote/ref-watch.js";
import { ignoreFileMode } from "../git/remote/repo-git-dirs.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { batchMatters, gitMatters, iqMatters } from "../workspace/watch/batch-relevance.js";
import { startRepoWatch, subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { startWorkspaceWatch, subscribeUnwatchedWrites, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";
import type { BootPhase } from "./boot-phase.js";

// Three watchers, none of which sees what the others see: files (ignores .git), repos (clones and deletions), refs.
// Nothing polls. (netd's per-checkout change counts are a fourth feed, but one that answers status reads,
// git/feed/checkout-feed.ts, and moves none of the reactions here.)

// Every workspace path an installed extension's code or switches live under, in the watcher's own relative spelling,
// taken from the documents and directories that own them: a hand edit there moves the extension like an install does.
const extensionSourceOf = (root: string): ((path: string) => boolean) => {
    const dirs = [workspaceExtensionsRoot(root), extensionsRoot(root)].map((dir) => `${relative(root, dir)}/`);
    const files = new Set([extensionEnablementDocument.path, extensionDevDocument.path]);
    return (path) => files.has(path) || dirs.some((dir) => path.startsWith(dir));
};

export const startChangeReactions = ({ logger, services, shutdown, traits }: BootPhase): void => {
    // Built once, not per change batch.
    const extensionSource = extensionSourceOf(services.workspace.root);
    shutdown.push(startWorkspaceWatch(services.workspace.root, logger));
    shutdown.push(
        subscribeWorkspaceChanges((paths) => {
            if (batchMatters(paths, iqMatters)) {
                services.iq.markDirty();
            }
        }),
    );
    shutdown.push(subscribeWorkspaceChanges(services.workspaceTreeChanged));
    shutdown.push(subscribeUnwatchedWrites(() => services.workspaceTreeChanged([])));
    // Loaded code can't be unloaded, so a debounced restart is the reload; one that declares new powers waits for approval
    // again, and keeps none of its processes meanwhile.
    shutdown.push(
        subscribeWorkspaceChanges((paths) => {
            // The capability manifest names the installed extensions, so a hand edit to it moves the inventory too.
            if (paths.some((path) => extensionSource(path) || path === capabilitiesDocument.path)) {
                invalidateContributions();
            }
            if (paths.some(extensionSource)) {
                services.extensionBackend.restart();
                void stopPendingExtensionProcesses(services);
            }
            // Idempotent, so the dev routes' own write passing through here moves nothing twice.
            if (paths.includes(extensionDevDocument.path)) {
                void followExtensionDirs(services);
            }
        }),
    );
    shutdown.push(startRepoWatch(services.workspace.root, logger));
    shutdown.push(startRefWatch(services.workspace.root, subscribeRepoChanges, logger));
    // A ref can move without a workspace byte changing, so only the ref feed can invalidate health.
    shutdown.push(subscribeRefChanges(() => services.iq.invalidateHealth()));
    // Everything a land standing is measured against outside the registry: refs (main's HEAD, agent tips) and the main
    // checkouts' files (a landed path discarded, a blocking edit cleared).
    shutdown.push(
        services.agents.watchStandings((changed) => {
            const stops = [
                subscribeRefChanges(changed),
                subscribeWorkspaceChanges((paths) => {
                    if (batchMatters(paths, gitMatters)) {
                        changed();
                    }
                }),
                subscribeUnwatchedWrites(changed),
            ];
            return () => {
                for (const stop of stops) {
                    stop();
                }
            };
        }),
    );
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
