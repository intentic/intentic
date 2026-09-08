import type { IconName } from "@intentic/ui";
import { withoutResumeNote } from "@intentic/sandbox-contract";
import type { ChatMessage } from "../transcript/transcript";

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

export const ERRANDS = {
    landConflict: {
        icon: `sync`,
        label: `Resolving the land conflict`,
        detail: `Sent by the app, landing this work refused`,
        opening: `Landing your work hit a merge conflict, none of it reached the user's workspace; it is all still on your branch. Rebase onto the main line and resolve the conflicts yourself. In each repo below (\`root\` is your working directory, any other name that subdirectory of it):`,
    },
} as const satisfies Record<string, Errand>;

// The prompt an errand actually sends: its opening, then the parts describing this instance.
export const errandPrompt = (errand: Errand, parts: readonly string[]): string => [errand.opening, ...parts].join(`\n\n`);

// Which errand a message is, if any. Reads through withoutResumeNote, since a daemon-restarted turn carries the same
// errand's prompt behind an explanatory note.
export const errandOf = (message: ChatMessage): Errand | undefined => {
    if (message.role !== `user`) {
        return undefined;
    }
    const text = withoutResumeNote(message.text.trim());
    return Object.values(ERRANDS).find((errand) => text.startsWith(errand.opening));
};
