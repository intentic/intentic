// The follow-up the daemon USED to send when a turn ended with work it could not confirm. Nothing sends it any more:
// checks run after work lands, never inside a conversation (schemas/workspace/mainline.ts). It stays on the wire because
// records already hold it, and the chat has to go on recognising it: a prompt nobody typed must not reach a reader as
// their own words.

// Anchored on by the reader, so it must stay unique and stable across releases — a reworded opening un-recognises every
// nudge already in a record, and they read as the user's own typing again.
export const VERIFY_NUDGE_OPENING =
    "The turn you just finished left work this sandbox could not confirm, so it is asking before the work is called done. Each item below is either a check that did not pass, which you repair, or something the turn changed without showing it works, which you prove. Deal with every one of them, then say plainly what you ran and what it covered.";

// The prompt a nudge actually sends: its opening, then the findings and asks, each already worded for the model.
export const verifyNudgePrompt = (parts: readonly string[]): string => [VERIFY_NUDGE_OPENING, ...parts].join("\n\n");

// Whether a stored prompt is one, so any reader can ask without checking first.
export const isVerifyNudge = (prompt: string): boolean => prompt.startsWith(VERIFY_NUDGE_OPENING);
