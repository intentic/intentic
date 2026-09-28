import { DEVICE_FEATURE_ROLLBACK_TO, type DeviceFacts, deviceSupports } from "@intentic/sandbox-contract";
import type { DeviceSandboxRow, RollbackChoice } from "@intentic/ui";
import { versionName } from "../overview/version/updateOutcome";

/**
 * The versions a row's Roll back can choose between: every image the machine kept for this sandbox, newest first,
 * when the agent the op goes through can go back to one other than the newest (`rollback-to`: an older agent refuses
 * the `to` it would be sent). Fewer than two kept is no choice at all, and the plain verb stands. The newest is the
 * plain rollback, so it carries no `to`; the others are named by version, or by image when the image would not say.
 */
export const rollbackChoices = (
    facts: Pick<DeviceFacts, "features"> | undefined,
    sandbox: Pick<DeviceSandboxRow, "rollbackTargets"> | undefined,
): RollbackChoice[] => {
    const targets = sandbox?.rollbackTargets ?? [];
    if (targets.length < 2 || !deviceSupports(facts, DEVICE_FEATURE_ROLLBACK_TO)) {
        return [];
    }
    return targets.map((target, at) => ({ version: target.version ?? versionName(target.image), to: at === 0 ? undefined : (target.version ?? target.image) }));
};
