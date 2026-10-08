import { DEVICE_FEATURE_ROLLBACK_TO, type DeviceFacts, deviceSupports } from "@intentic/sandbox-contract";
import type { DeviceSandboxRow, RollbackChoice } from "@intentic/ui";
import { versionName } from "../overview/version/updateOutcome";

type Target = NonNullable<DeviceSandboxRow["rollbackTargets"]>[number];

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
 * The versions a row's Roll back can choose between: every image the machine kept for this sandbox, newest first,
 * when the agent the op goes through can go back to one other than the newest (`rollback-to`: an older agent refuses
 * the `to` it would be sent). Fewer than two kept is no choice at all, and the plain verb stands. The newest is the
 * plain rollback, so it carries no `to`; the others are named by version, or by image when the image would not say.
 * A version two kept builds share (every dev build says 0.0.0) names neither: each is labelled with its image's tag
 * beside the version and sent as its image, since `ic` resolves a version to the FIRST build that carries it.
 */
export const rollbackChoices = (
    facts: Pick<DeviceFacts, "features"> | undefined,
    sandbox: Pick<DeviceSandboxRow, "rollbackTargets"> | undefined,
): RollbackChoice[] => {
    const targets = sandbox?.rollbackTargets ?? [];
    if (targets.length < 2 || !deviceSupports(facts, DEVICE_FEATURE_ROLLBACK_TO)) {
        return [];
    }
    const shared = (target: Target): boolean => target.version !== undefined && targets.filter((other) => other.version === target.version).length > 1;
    return targets.map((target, at) => {
        const ambiguous = shared(target);
        const version = target.version === undefined ? versionName(target.image) : ambiguous ? `${target.version} (${imageTag(target.image)})` : target.version;
        return { version, to: at === 0 ? undefined : ambiguous ? target.image : (target.version ?? target.image) };
    });
};
