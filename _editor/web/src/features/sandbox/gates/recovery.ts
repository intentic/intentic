import type { CommandOs } from "@intentic/ui";
import { oneLinerFits } from "@intentic/constants";
import { oneLiner } from "../../../app/environments/scriptCommand";
import type { DiagnosisNotice } from "../diagnosis/presentation";

// WHEN A SANDBOX DOESN'T COME BACK, what can still be done about it without it. Everything the recovery panel offers
// works with the daemon down: a link the desktop app on that machine answers, the one command typed there, the
// platform's own restart and rollback for a machine it runs, or a press through another of the owner's sandboxes that
// reaches the same machine (live/sandboxDoors.ts). WHEN it shows is the diagnosis's call (diagnosis/), never a timer's.
// Pure, so when it shows and what it prints are checked without mounting anything (recovery.test.ts).

// A restart this browser asked for is what the silence is, for this long; only past it is the way back offered.
export const RESTART_RECOVERY_AFTER_MS = 3 * 60_000;

export interface RecoveryInput {
    readonly reachable: boolean;
    /** How long the current run of failures has lasted, visibly. */
    readonly outageMs: number;
    /** A restart this browser asked for is still on record: the silence was expected, for a while. */
    readonly restartExpected: boolean;
    /** The machine that deleted its container said so: nothing here brings it back. */
    readonly removed: boolean;
    /** The platform refused to wake it (hours spent, hosted lane switched off): its own notice says what to do. */
    readonly refused: boolean;
    /** Only the owner holds the machine, the command and the platform's restart and rollback. */
    readonly owner: boolean;
    /** What the diagnosis of this outage says (diagnosis/presentation.ts); undefined while there is nothing to diagnose. */
    readonly notice: DiagnosisNotice | undefined;
}

/**
 * Whether the recovery panel is due: the diagnosis established a cause with something to do about it, or the machine
 * reported findings. Never on a clock alone — a sandbox that is merely busy has no way back to offer, however long it
 * takes — and never for a reader who could press none of it.
 */
export const recoveryDue = (input: RecoveryInput): boolean => {
    if (input.reachable || !input.owner || input.removed || input.refused || input.notice === undefined) {
        return false;
    }
    if (input.restartExpected && input.outageMs < RESTART_RECOVERY_AFTER_MS) {
        return false;
    }
    return input.notice.action !== undefined || input.notice.findings.length > 0;
};

export interface RecoveryCommands {
    /** Back to the version before the last update. */
    readonly rollback: string;
    readonly restart: string;
}

/**
 * The two single-purpose commands, for a reader who knows which one they want; everyone else gets the fix command, which
 * offers both when they are what it finds. Both are one-liners whose script fetches the current `ic` first. With no
 * name known (or one no one-liner can carry), `ic`'s bare verbs, which answer for the one sandbox on a device running
 * only one.
 */
export const recoveryCommands = (slug: string | undefined, os: CommandOs): RecoveryCommands => {
    if (slug === undefined || !oneLinerFits(`restart`, [slug])) {
        return { rollback: `ic sandbox rollback`, restart: `ic sandbox restart` };
    }
    return { rollback: oneLiner(`rollback`, [slug], os), restart: oneLiner(`restart`, [slug], os) };
};
