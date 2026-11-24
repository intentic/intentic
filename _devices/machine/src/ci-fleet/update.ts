import { chmod, rename, rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { DEV_VERSION } from "@intentic/sandbox-contract/state/versions";
import { agentAssetName, agentAssetUrl, downloadAsset } from "../release.js";
import { verifyReleaseFiles } from "../release/release-verify.js";
import type { FleetContext } from "./context.js";
import { FLEET_BINARY } from "./paths.js";

/* THE SERVICE FOLLOWS THE PERSON'S AGENT, THROUGH A SIGNED RELEASE ONLY. The agent says its version on every status read
   (`hello`); when it differs from the service's own, the service downloads that release's binary itself and checks it
   against the release's signed SHA256SUMS (release-verify.ts, as every binary the agent installs is checked) before it
   replaces its root-owned copy, then exits once nothing it does is mid-way, and systemd starts the new one. The
   person's binary is never what root runs: an agent built from source names a version no release has, and nothing
   happens. A version that failed is not tried again for an hour. */

const RETRY_MS = 60 * 60_000;
// How often an update that waits for the service to be idle looks again.
const IDLE_LOOK_MS = 5_000;

const isRelease = (version: string): boolean => version !== DEV_VERSION && version !== "0.0.0";

export interface Updater {
    readonly heard: (version: string) => void;
}

export const createUpdater = (context: FleetContext, own: string, exit: () => void, binary: string = FLEET_BINARY): Updater => {
    const tried = new Map<string, number>();
    let underway = false;
    const exitWhenIdle = (): void => {
        if (context.busy.count() === 0) {
            exit();
            return;
        }
        setTimeout(exitWhenIdle, IDLE_LOOK_MS);
    };
    const update = async (version: string): Promise<void> => {
        const next = `${binary}.next`;
        try {
            await downloadAsset(agentAssetUrl(version), next);
            const signed = await verifyReleaseFiles(version, [{ name: agentAssetName(), path: next }]);
            await chmod(next, 0o755);
            await rename(next, binary);
            context.log(`update: v${version} (${signed}) replaces v${own}; restarting once idle`);
            exitWhenIdle();
        } catch (error) {
            await rm(next, { force: true });
            context.log(`update: could not take v${version}, staying on v${own}: ${errorMessage(error)}`);
        } finally {
            underway = false;
        }
    };
    return {
        heard: (version) => {
            const last = tried.get(version);
            if (version === own || !isRelease(version) || underway || (last !== undefined && context.sys.now() - last < RETRY_MS)) {
                return;
            }
            tried.set(version, context.sys.now());
            underway = true;
            void update(version);
        },
    };
};
