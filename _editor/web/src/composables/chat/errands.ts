import type { IconName } from "@intentic/ui";
import { withoutResumeNote } from "@intentic/sandbox-contract";
import type { ChatMessage } from "./transcript";

/* PROMPTS THE APP WROTE AND SENT ON THE USER'S BEHALF, an errand.
 *
 * Some of an agent's work is chore-shaped and nobody should have to type it: rebase onto the moved main line
 * and resolve what conflicts (the land report's primary button, conflictResolution.ts), and the review and
 * test passes that will follow it. The app composes those prompts and enqueues them as ORDINARY turns, which
 * is the right wire behaviour and the one thing here that must not change, the agent genuinely receives them,
 * a running turn takes them as steering, Stop and the queue work on them unchanged.
 *
 * It is the wrong TRANSCRIPT behaviour. As written they are user messages, so each one opened a turn of its
 * own: the sticky pin came off the question that defines the work and landed on a paragraph of our prose,
 * attributed to a user who never typed it, in the one row of the panel that is never off screen.
 *
 * So an errand FOLDS into the turn it serves (transcript.ts) and is rendered by its LABEL rather than by its
 * text (ChatMessageView), the same treatment a bare "continue" gets and for the same reason, differing only
 * in whose words are being suppressed: theirs there, ours here.
 *
 * RECOGNISED FROM THE TEXT, which is not a shortcut, it is the only thing that survives. The transcript is
 * rebuilt from the daemon on every hydrate (restoreMessages keeps role/text/attachments/thinking/tools) and
 * synthesized from the attach head's bare `prompt` string on every reattach, so a flag set at send time would
 * be right in the window that sent it and gone everywhere else, including this window after a reload. The
 * resume notes on the wire (events.ts, RESUME_NOTES) hit the same wall and answered it the same way.
 *
 * The signature is the prompt's own OPENING PARAGRAPH, and the composer builds the prompt FROM it
 * (errandPrompt) rather than repeating it. That is what keeps recogniser and prompt from drifting as these
 * multiply, and it adds no machine marker to prose a model has to read. */

export interface Errand {
    // The row's glyph, sharing the vocabulary of whatever raised the errand (a land conflict is `sync`, the
    // same glyph REASON_COPY marks a diverged path with).
    readonly icon: IconName;
    // What happened, as the row and the pinned prompt's trailer say it. Short: the trailer is one line under a
    // prompt that is already clamped to six.
    readonly label: string;
    // Why the app sent it. The user did not type this message and is owed the reason on the row itself, not in
    // a tooltip they have to go looking for.
    readonly detail: string;
    // The prompt's first paragraph, composed FROM, recognised BY. Must stay unique across errands and stable
    // across releases: a reworded opening is a new errand as far as an already-stored transcript is concerned,
    // and the old one goes back to reading as a message the user typed.
    readonly opening: string;
}

export const ERRANDS = {
    landConflict: {
        icon: `sync`,
        label: `Resolving the land conflict`,
        detail: `Sent by the app, landing this work refused`,
        opening: `Landing your work hit a merge conflict, none of it reached the user's workspace; it is all still on your branch. Rebase onto the main line and resolve the conflicts yourself. In each repo below (\`root\` is your working directory, any other name that subdirectory of it):`,
    },
} as const satisfies Record<string, Errand>;

// The prompt an errand actually sends: its opening, then the parts describing THIS instance of it.
export const errandPrompt = (errand: Errand, parts: readonly string[]): string => [errand.opening, ...parts].join(`\n\n`);

/* Which errand a transcript message is, if any.
 *
 * Read through withoutResumeNote because a turn the daemon restarted carries its original prompt behind a note
 * explaining why (events.ts), that is the same errand, still doing the same chore, and the hydrate path has
 * nowhere else that strips it. */
export const errandOf = (message: ChatMessage): Errand | undefined => {
    if (message.role !== `user`) {
        return undefined;
    }
    const text = withoutResumeNote(message.text.trim());
    return Object.values(ERRANDS).find((errand) => text.startsWith(errand.opening));
};
