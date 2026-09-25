import type { TurnNote } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { knownReds } from "./mainline-status.js";

// What a turn is told about checks: nothing checks its work when it finishes and nothing holds it back, the main tree's
// own check runs after it lands, and which failures the main tree already has, so a conversation never spends a turn
// chasing a red somebody else caused and somebody else is fixing.
// Sent on the opening message and after a compaction, like every standing note, and again whenever the main tree's reds
// change under a conversation, since that is exactly when the old line stops being true.

export const LANDING_CHECKS_NOTE_TITLE = "Checks after landing";
export const LANDING_CHECKS_NOTE_HEADER = "## Checks after landing";

// The note this one replaced, still parsed out of prompts records hold (turn-preamble.ts), never sent.
export const LEGACY_TURN_ENDING_NOTE_TITLE = "Automatic end-of-turn checks";
export const LEGACY_TURN_ENDING_NOTE_HEADER = "## Automatic end-of-turn checks";

// Failures listed per red project before the rest are counted.
const LISTED = 8;

export type KnownRed = Awaited<ReturnType<typeof knownReds>>[number];

const where = (project: string): string => (project === "" ? "the workspace root" : `\`${project}\``);

const clock = (at: number): string => {
    const date = new Date(at);
    return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
};

const redLines = (red: KnownRed): string[] => [
    `- ${where(red.project)}: ${red.failureCount === 0 ? "red" : `${red.failureCount} failure${red.failureCount === 1 ? "" : "s"}`} since ${clock(red.since)}${red.lands.length === 0 ? "" : `, after ${red.lands.map((title) => `"${title}"`).join(", ")} landed`}`,
    ...red.failures.slice(0, LISTED).map((unit) => `  - \`${unit}\``),
    ...(red.failures.length > LISTED ? [`  - …and ${red.failureCount - LISTED} more`] : []),
];

export const landingChecksNote = (reds: readonly KnownRed[], wasRed: boolean): TurnNote => ({
    title: LANDING_CHECKS_NOTE_TITLE,
    text: [
        LANDING_CHECKS_NOTE_HEADER,
        "",
        "Nothing checks your work when you finish, and nothing holds it back: you decide when it is done. After it lands, the main tree's own check runs in the background. A failure traced to your work comes back to this conversation as a message; anything else goes to a fresh conversation. Run whatever checks you judge worth running while you work, scoped to what you changed (the tests that cover it, its package's typecheck), never the whole repository: that is what runs after the land. None is required before you finish.",
        ...(reds.length > 0
            ? [
                  "",
                  "The main tree is already red on these, before any of your work lands. They are not yours to chase unless your task is about them:",
                  "",
                  ...reds.flatMap(redLines),
              ]
            : wasRed
              ? ["", "The main tree's own check is green again: a failure you see from here on is worth reading as your own."]
              : []),
    ].join("\n"),
});

// What each conversation was last told of the reds, by fingerprint; a restart forgets it, which costs one more note.
const told = new Map<string, string>();

const fingerprintOf = (reds: readonly KnownRed[]): string => reds.map((red) => `${red.project}@${red.since}:${red.failureCount}`).join("|");

// The note this turn owes, or undefined: always when `due` (the opening message, or after a compaction), otherwise only
// when the reds changed since this conversation was last told of them.
export const landingChecksNoteFor = async (
    deps: Pick<Services, "verifyStore" | "logger">,
    conversationId: string | undefined,
    due: boolean,
): Promise<TurnNote | undefined> => {
    let reds: readonly KnownRed[];
    try {
        reds = await knownReds(deps);
    } catch (error) {
        deps.logger.warn({ err: error }, "landing checks note: the main line's verdicts could not be read");
        reds = [];
    }
    const fingerprint = fingerprintOf(reds);
    const previous = conversationId === undefined ? undefined : told.get(conversationId);
    // A conversation this daemon has not told since it started is taken to know the reds as they stand: it heard them
    // before a restart, or on an opening this one did not send. From here on a change is news.
    if (previous === undefined && !due) {
        if (conversationId !== undefined) {
            told.set(conversationId, fingerprint);
        }
        return undefined;
    }
    const changed = previous !== undefined && previous !== fingerprint;
    if (!due && !changed) {
        return undefined;
    }
    if (conversationId !== undefined) {
        told.set(conversationId, fingerprint);
    }
    return landingChecksNote(reds, previous !== undefined && previous !== "");
};
