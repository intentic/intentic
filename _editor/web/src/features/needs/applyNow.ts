import type { Need } from "@intentic/sandbox-contract/schemas/needs";

export interface ApplyNowDeps {
    /** The need as this editor last heard it, if it still has it. */
    readonly current: () => Pick<Need, `status`> | undefined;
    /** Sends `apply`: the person says what the need asked for is done. */
    readonly apply: () => Promise<void>;
}

/**
 * Settles a need the press just met, now rather than on the daemon's next check, so the card closes with this press
 * instead of offering it again. A need the daemon already closed (its own check, started by the same change) is left
 * alone. `lenient` (a new connection, 2026-10-20): a refusal is not this press failing, since a connection still coming
 * up is met by the daemon the moment it probes live.
 */
export const applyNow = async ({ current, apply }: ApplyNowDeps, lenient = false): Promise<void> => {
    if (current()?.status === `met`) {
        return;
    }
    if (!lenient) {
        await apply();
        return;
    }
    // allow(silent-catch): lenient by design; the daemon settles the need itself once the connection is live.
    await apply().catch(() => undefined);
};
