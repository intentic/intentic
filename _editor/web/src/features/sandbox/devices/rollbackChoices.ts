import { DEVICE_FEATURE_ROLLBACK_TO, type DeviceFacts, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { waysBack } from "@intentic/sandbox-contract/state/ways-back";
import type { DeviceSandboxRow, RollbackChoice } from "@intentic/ui";
import { versionName } from "../overview/version/updateOutcome";

// The image's own short name: its tag, or its short digest. What sets apart two kept builds that say the same version.
const imageTag = (image: string): string => {
    const digest = /@sha256:([0-9a-f]{12})/.exec(image);
    if (digest !== null) {
        return digest[1]!;
    }
    const leaf = image.slice(image.lastIndexOf(`/`) + 1);
    const colon = leaf.lastIndexOf(`:`);
    return colon === -1 ? leaf : leaf.slice(colon + 1);
};

/**
 * The ways back a row's Roll back can choose between, as `ic` lists them (versions.rs `ways_back`: newest first, only
 * ones it can still reach; an older ic's unreachable rows left out by the contract's `waysBack`), each once, when the agent the op goes through can go back to one other than the newest
 * (`rollback-to`: an older agent refuses the `to` it would be sent). Fewer than two is no choice at all, and the plain
 * verb stands. The newest is the plain rollback, so it carries no `to`; every other is sent as the exact image `ic`
 * listed, never as its version: every dev build says 0.0.0, and a version names whichever kept build carries it first
 * (2026-10-08). A version several share is labelled with each one's image tag beside it.
 */
export const rollbackChoices = (
    facts: Pick<DeviceFacts, "features"> | undefined,
    sandbox: Pick<DeviceSandboxRow, "rollbackTargets"> | undefined,
): RollbackChoice[] => {
    const targets = waysBack(facts, sandbox?.rollbackTargets ?? []);
    if (targets.length < 2 || !deviceSupports(facts, DEVICE_FEATURE_ROLLBACK_TO)) {
        return [];
    }
    const shared = (version: string): boolean => targets.filter((other) => other.version === version).length > 1;
    return targets.map((target, at) => ({
        version: target.version === undefined ? versionName(target.image) : shared(target.version) ? `${target.version} (${imageTag(target.image)})` : target.version,
        to: at === 0 ? undefined : target.image,
    }));
};
