import { startVanishedRepoSweep } from "../agents/registry/vanished-repos.js";
import { startSidecarService } from "../derived/sidecar-service.js";
import { startRefWatch, subscribeRefChanges } from "../git/remote/ref-watch.js";
import { stateRelPath } from "../workspace/layout/state-paths.js";
import { startRepoWatch, subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { startWorkspaceWatch, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";
import type { BootPhase } from "./boot-phase.js";

// What re-derives when a workspace file or a git ref moves. Three feeds carry it, because none of them can see what
// the others see: the file watcher (which ignores .git), the repo watcher (clones and deletions under /work) and the
// ref watcher (any commit, checkout, branch, tag or rebase in any repo). Everything downstream subscribes; nothing
// polls.

// A workspace-relative path is extension source (code or enablement) if it matches one of three locations. Module
// scope so the watcher doesn't rebuild this on every change batch.
const extensionSource = (path: string): boolean =>
    path.startsWith(`${stateRelPath(".intentic/config/workspace-extensions/")}/`) ||
    path.startsWith(`${stateRelPath(".intentic/local/extensions/")}/`) ||
    path === stateRelPath(".intentic/config/extension-enablement.json");

export const startChangeReactions = ({ logger, services, shutdown }: BootPhase): void => {
    // Watches /work so the browser's tree and open file refresh instantly over /events, no manual refresh needed.
    startWorkspaceWatch(services.workspace.root, logger);
    // Search index revalidates on the same watch stream; a query serves the current index while reindexing happens
    // between queries.
    subscribeWorkspaceChanges(() => services.iq.markDirty());
    // Restarts the extension backend host when its source changes (an edit, a fresh checkout, an enablement flip):
    // loaded code can't be unloaded, so a debounced restart is the reload. No-op while no extension ships a backend.
    subscribeWorkspaceChanges((paths) => {
        if (paths.some(extensionSource)) {
            services.extensionBackend.restart();
        }
    });
    // Re-derives a binary file's markdown shadow (docx/pdf/image/audio) via a spawned `fileq` whenever it lands or
    // changes. Gated by the `sidecars` setting, read fresh each pass so the switch works without a restart.
    shutdown.push(
        startSidecarService({ enabled: async () => (await services.sandboxSettings.get()).sidecars, logger }, subscribeWorkspaceChanges).stop,
    );
    // Reframes the discovered repo list on /events when a repo is cloned or deleted under /work (the file watcher
    // itself ignores .git).
    startRepoWatch(services.workspace.root, logger);
    // Reframes commit-graph-derived surfaces on any ref move (commit, checkout, branch, tag, rebase) in any repo;
    // neither the file watcher (ignores .git) nor the repo watcher above can carry this.
    startRefWatch(services.workspace.root, subscribeRepoChanges, logger);
    // Health rankings include committed churn; a ref can move without a workspace byte changing, so only the ref feed
    // can invalidate this.
    shutdown.push(subscribeRefChanges(() => services.iq.invalidateHealth()));
    // Removes a deleted repo from every composition still naming it and reclaims its stranded checkouts: the one
    // correction a frozen composition can't make for itself (agents/registry/vanished-repos.ts).
    shutdown.push(startVanishedRepoSweep(services, subscribeRepoChanges));

    // Warms the search index (sweep, symbols, embedding backlog) on its own worker thread so the first search is
    // ready; incremental, so a valid on-disk index survives a boot. Detached, as an observation point only.
    void services.iq.warm().catch((error: unknown) => logger.warn({ err: error }, "iq index warmup failed, search runs on the index as it stands"));
};
