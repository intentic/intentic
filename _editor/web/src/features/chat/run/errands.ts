import type { IconName } from "@intentic/ui";
import { LAND_BREAKAGE_OPENING, LAND_CONFLICT_OPENING, VERIFY_NUDGE_OPENING, withoutResumeNote } from "@intentic/sandbox-contract";
import type { ChatMessage } from "../transcript/transcript";
import { t } from "@intentic/ui/i18n";

// An app-composed prompt, sent as an ordinary turn (so the agent, Stop and the queue treat it unchanged) but folded and
// rendered by its label in the transcript, not as raw text. Recognized by the prompt's own opening paragraph, since no
// send-time flag survives a reload; the composer builds each prompt from that same opening so the two can't drift.

export interface Errand {
    // Shares the glyph vocabulary of whatever raised the errand (a land conflict is `sync`, matching REASON_COPY).
    readonly icon: IconName;
    // What happened, shown on the row and the pinned prompt's trailer; kept short to fit both.
    readonly label: string;
    // Why the app sent it; shown on the row itself, since the user didn't type this and is owed the reason.
    readonly detail: string;
    // The prompt's first paragraph: composed from, and recognized by. Must stay unique and stable across releases, or a
    // reworded opening un-recognizes an already-stored errand.
    readonly opening: string;
}

export const errands = () =>
    ({
        landConflict: {
            icon: `sync`,
            label: t(`chat.errands.resolvingLandConflict`),
            detail: t(`chat.errands.sentByAppLanding`),
            // The contract's, not a literal here: the fold recognises this turn too (land-conflict.ts).
            opening: LAND_CONFLICT_OPENING,
        },
        // Composed by the DAEMON, unlike the one above, so its opening is the contract's: the two ends would drift the
        // first time either was reworded on its own.
        verifyNudge: {
            icon: `check-circle`,
            label: t(`chat.errands.checkingWorkJustDid`),
            detail: t(`chat.errands.sentBySandboxTurn`),
            opening: VERIFY_NUDGE_OPENING,
        },
        // Composed by the daemon when this conversation's land turned the main tree's check red (land-breakage.ts).
        landBreakage: {
            icon: `wrench`,
            label: t(`chat.errands.fixingWhatLandBroke`),
            detail: t(`chat.errands.sentBySandboxLand`),
            opening: LAND_BREAKAGE_OPENING,
        },
    }) as const satisfies Record<string, Errand>;

// The prompt an errand actually sends: its opening, then the parts describing this instance.
export const errandPrompt = (errand: Errand, parts: readonly string[]): string => [errand.opening, ...parts].join(`\n\n`);

// Which errand a message is, if any. Reads through withoutResumeNote, since a daemon-restarted turn carries the same
// errand's prompt behind an explanatory note.
export const errandOf = (message: ChatMessage): Errand | undefined => {
    if (message.role !== `user`) {
        return undefined;
    }
    const text = withoutResumeNote(message.text.trim());
    return Object.values(errands()).find((errand) => text.startsWith(errand.opening));
};
