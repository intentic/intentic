import type { IconName } from "@intentic/ui";
import {
    isLandFix,
    LAND_BREAKAGE_OPENING,
    LAND_CONFLICT_OPENING,
    LAND_FIX_OPENING,
    type TurnErrand,
    VERIFY_NUDGE_OPENING,
    withoutResumeNote,
} from "@intentic/sandbox-contract";
import type { ChatMessage } from "../transcript/transcript";
import { t } from "@intentic/ui/i18n";

// An app-composed prompt, sent as an ordinary turn (so the agent, Stop and the queue treat it unchanged) but folded and
// rendered by its label in the transcript, not as raw text. A row names the errand it is (`TranscriptRow.errand`); a row
// recorded before rows did is recognized by the prompt's own opening paragraph, which is why every opening below stays
// byte-identical for good.

export interface Errand {
    // Shares the glyph vocabulary of whatever raised the errand (a land conflict is `sync`, matching REASON_COPY).
    readonly icon: IconName;
    // What happened, shown on the row and the pinned prompt's trailer; kept short to fit both.
    readonly label: string;
    // Why the app sent it; shown on the row itself, since the user didn't type this and is owed the reason.
    readonly detail: string;
    // What rows name it by: the errand itself and, for a fix attempt, the nudge that continues it.
    readonly kinds: readonly TurnErrand[];
    // The prompt's first paragraph, for rows older than `kinds`: composed from, and recognized by. Must stay unique and
    // stable across releases, or a reworded opening un-recognizes an already-stored errand. Absent for an errand only
    // ever recorded with its kind.
    readonly opening?: string;
    // The contract's own recogniser, where it ships one, so this side and the daemon's cannot disagree about a prompt.
    readonly matches?: (prompt: string) => boolean;
}

export const errands = () =>
    ({
        landConflict: {
            icon: `sync`,
            label: t(`chat.errands.resolvingLandConflict`),
            detail: t(`chat.errands.sentByAppLanding`),
            kinds: [`land-conflict`],
            // The contract's, not a literal here: the fold recognises this turn too (land-conflict.ts).
            opening: LAND_CONFLICT_OPENING,
        },
        // Composed by the DAEMON, unlike the one above, so its opening is the contract's: the two ends would drift the
        // first time either was reworded on its own. Nothing sends it any more (checks run after landing, not inside a
        // turn); kept so the transcripts that already hold one still read it as the sandbox's, not the user's words.
        verifyNudge: {
            icon: `check-circle`,
            label: t(`chat.errands.checkingWorkJustDid`),
            detail: t(`chat.errands.sentBySandboxTurn`),
            kinds: [`verify-nudge`],
            opening: VERIFY_NUDGE_OPENING,
        },
        // Composed by the daemon when this conversation's land turned the main tree's check red (land-breakage.ts).
        landBreakage: {
            icon: `wrench`,
            label: t(`chat.errands.fixingWhatLandBroke`),
            detail: t(`chat.errands.sentBySandboxLand`),
            kinds: [`land-breakage`],
            opening: LAND_BREAKAGE_OPENING,
        },
        // The first prompt of a FRESH conversation the daemon starts on a red main line nobody holding the work could
        // take (land-fix.ts): the same kind of chore as the follow-up above, handed to somebody new.
        landFix: {
            icon: `wrench`,
            label: t(`chat.errands.fixingRedMainLine`),
            detail: t(`chat.errands.startedBySandboxRedMain`),
            kinds: [`land-fix`, `land-fix-nudge`],
            opening: LAND_FIX_OPENING,
            matches: isLandFix,
        },
        // Told, while it still works, that main went red on what it is working on (land-breakage.ts holds the red on it).
        landHeld: {
            icon: `wrench`,
            label: t(`chat.errands.mainRedOnItsWork`),
            detail: t(`chat.errands.sentBySandboxHeld`),
            kinds: [`land-held`],
        },
        // The attempt at what the push checks found (push-fix.ts), and its nudge when an earlier turn ended unfixed.
        pushFix: {
            icon: `wrench`,
            label: t(`chat.errands.fixingPushFindings`),
            detail: t(`chat.errands.sentBySandboxPush`),
            kinds: [`push-fix`, `push-fix-nudge`],
        },
        // The attempt at a failed CI run (ci-fix.ts), and its nudge.
        ciFix: {
            icon: `wrench`,
            label: t(`chat.errands.fixingFailedCi`),
            detail: t(`chat.errands.sentBySandboxCi`),
            kinds: [`ci-fix`, `ci-fix-nudge`],
        },
    }) as const satisfies Record<string, Errand>;

// The prompt an errand actually sends: its opening, then the parts describing this instance.
export const errandPrompt = (errand: Errand & { readonly opening: string }, parts: readonly string[]): string => [errand.opening, ...parts].join(`\n\n`);

// Which errand a message is, if any: the one its row names, else, for a row recorded before rows named it, the one its
// prompt opens with. Reads through withoutResumeNote, since a daemon-restarted turn carries the same errand's prompt
// behind an explanatory note.
export const errandOf = (message: ChatMessage): Errand | undefined => {
    if (message.role !== `user`) {
        return undefined;
    }
    const all: readonly Errand[] = Object.values(errands());
    const named = message.errand;
    if (named !== undefined) {
        return all.find((errand) => errand.kinds.includes(named));
    }
    const text = withoutResumeNote(message.text.trim());
    return all.find((errand) => errand.matches?.(text) ?? (errand.opening !== undefined && text.startsWith(errand.opening)));
};
