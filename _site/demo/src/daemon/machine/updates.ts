import type { Info } from "@intentic/sandbox-contract/schemas/system";
import type { AutoUpdate, AutoUpdateInput } from "@intentic/sandbox-contract/schemas/updates";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { pushDomains } from "./machineKit";

// The owner's say over updates (the daemon's updates/auto-update.ts): whether a downloaded release is taken by itself
// in a quiet moment, paused until a time, and which release not to offer again. /info reads it back, so the version
// card redraws from the answer, and every other page hears it through the `update` push.

const auto: AutoUpdate = { enabled: true, phase: `idle`, holds: [] };
// The release the owner said not to offer again, read back by /info's `skippedVersion`.
interface Skipped {
    version: string | undefined;
}
const skipped: Skipped = { version: undefined };

/** /info as the fixture states it, with the update state the owner's presses left. */
export const withUpdateState = (info: Info): Info => ({ ...info, autoUpdate: { ...auto, holds: [...auto.holds] }, skippedVersion: skipped.version });

/** The switch, a pause (null or a moment past lifts it), or "now", which needs a downloaded release to take. */
export const configureAutoUpdate = ({ enabled, pausedUntil, applyNow }: AutoUpdateInput): AutoUpdate => {
    if (applyNow === true && auto.phase === `idle`) {
        return refuse(`nothing is downloaded to take: this sandbox already runs the newest release`, 409);
    }
    if (enabled !== undefined) {
        auto.enabled = enabled;
    }
    if (pausedUntil !== undefined) {
        auto.pausedUntil = pausedUntil === null || pausedUntil <= Date.now() ? undefined : pausedUntil;
    }
    pushDomains(`update`);
    return { ...auto, holds: [...auto.holds] };
};

/** Stops offering one release; null offers the newest again. */
export const skipRelease = (version: string | null): SandboxHandlerOutput<`system`, `skipUpdate`> => {
    skipped.version = version ?? undefined;
    pushDomains(`update`);
    return { ok: true };
};
