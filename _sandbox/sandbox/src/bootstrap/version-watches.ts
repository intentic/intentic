import { startEngineWatch } from "../engines/engines.js";
import { startExtensionUpdateWatch } from "../extensions/extension-updates.js";
import { startReleaseNotesCheck } from "../platform/boot/release-notes.js";
import { startVersionCheck } from "../platform/boot/version-check.js";
import { recordNewestRun } from "../store/newest-run.js";
import type { BootPhase } from "./boot-phase.js";

// Which version of itself this run records, and which newer ones it watches for: the daemon's own release and its
// notes, the installed extensions, and the agent engines. All of it is warmed off the request path so /info and the
// Extensions tab answer from a cache, and none of it blocks anything.
export const startVersionWatches = ({ config, traits, role, services, shutdown }: BootPhase): void => {
    // Stamps the workspace with the newest version that ever ran it (forward-only), so a post-rollback manifest issue
    // reads as "written by a newer intentic", not "your file is broken". Backgrounded; gates nothing.
    if (role.roots) {
        void recordNewestRun(config.workspaceRoot).catch(() => undefined);
    }

    // Warms the "latest released version" cache so /info can offer an update without fetching on the request path.
    // Channel-aware: stable gets the promoted release, beta the newest; meaningless for a local daemon.
    const versionCheck = traits.containerUpdates ? startVersionCheck() : undefined;
    shutdown.push(() => versionCheck?.stop());

    // What an update would actually give: a separate read (the release's notes, not just its version pointer), same
    // cadence, neither blocking the /info that shows them.
    const releaseNotesCheck = traits.containerUpdates ? startReleaseNotesCheck() : undefined;
    shutdown.push(() => releaseNotesCheck?.stop());

    // Same courtesy for installed extensions: compares each pinned sha against its registry shortly after boot and
    // daily after; the Extensions tab's own reads keep it fresher still.
    const extensionUpdateWatch = traits.extensionHost ? startExtensionUpdateWatch(services) : undefined;
    shutdown.push(() => extensionUpdateWatch?.stop());

    // Same for the agent engines (Claude Code, Codex, Cursor, OpenCode, the translator): each engine's channel decides
    // its version source, acted on without a new image. Runs only where this daemon owns the container.
    const engineWatch = startEngineWatch(services, role);
    shutdown.push(() => engineWatch.stop());
};
