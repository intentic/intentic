import { isOpenNeed, type Need } from "@intentic/sandbox-contract/schemas/needs";

export interface ApplyNowDeps {
    /** The need as this editor last heard it, if it still has it. */
    readonly current: () => Pick<Need, `status`> | undefined;
    /** Sends `apply`: the person says what the need asked for is done. */
    readonly apply: () => Promise<void>;
    /** Reads the need afresh from the daemon, for a refusal that may only mean this editor's copy was behind. */
    readonly fresh?: () => Promise<Pick<Need, `status`> | undefined>;
}

/**
 * Settles a need the press just met, now rather than on the daemon's next check, so the card closes with this press
 * instead of offering it again. A need the daemon already closed (its own check, started by the same change) is left
 * alone, and so is one it closed while this editor's copy still read open (a push missed across a rebuild, 2026-11-04):
 * the refusal is read again against the daemon's list, and a need no longer open is no failure of this press. `lenient`
 * (a new connection, 2026-10-20): a refusal is not this press failing, since a connection still coming up is met by the
 * daemon the moment it probes live.
 */
export const applyNow = async ({ current, apply, fresh }: ApplyNowDeps, lenient = false): Promise<void> => {
    const known = current();
    if (known !== undefined && !isOpenNeed(known)) {
        return;
    }
    try {
        await apply();
    } catch (error) {
        if (lenient) {
            // allow(silent-catch): lenient by design; the daemon settles the need itself once the connection is live.
            return;
        }
        // allow(silent-catch): a re-read that fails proves nothing either way, so the press's own refusal is what it says.
        const now = await fresh?.().catch(() => undefined);
        if (now !== undefined && !isOpenNeed(now)) {
            return;
        }
        throw error;
    }
};
