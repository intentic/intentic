import type { LandedMessage } from "../schemas/agents.js";

// The commit a landed message makes: its subject, then every trailer in one paragraph, since git reads only the last
// block of a message as trailers.
export const landedCommitMessage = (landed: LandedMessage): string => {
    const trailers = [
        landed.note === undefined ? "" : `Release-Note: ${landed.note}`,
        landed.breaking === undefined ? "" : `Breaking-Note: ${landed.breaking}`,
        landed.testNote === undefined ? "" : `Test-Note: ${landed.testNote}`,
        ...(landed.allows ?? []).map((allow) => `Allow: ${allow}`),
    ]
        .filter((line) => line !== "")
        .join("\n");
    return [landed.subject, trailers].filter((part) => part !== "").join("\n\n");
};

// The `Test-Note:` line a conversation ended its last message with, when it declared a weakened test on purpose.
export const declaredTestNote = (said: string): string | undefined => /^Test-Note:[ \t]*(\S.*)$/m.exec(said)?.[1]?.trim();

// The `Allow: <check> — <reason>` lines a conversation ended its last message with, each an exception it declared for
// its change on purpose; the check after the land and the push read them off the landed commit.
export const declaredAllows = (said: string): string[] => [...said.matchAll(/^Allow:[ \t]*(\S.*)$/gm)].map((match) => match[1]!.trim());
