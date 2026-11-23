import { z } from "zod";

// CARRYING ON PAST A LARGE CONTEXT (2026-11-19). A turn that ends by itself because its conversation's context grew
// large while work is still open ("Steps 8-11 are still open; I stopped because this conversation's context is large")
// left the next move to the owner: in one audited sandbox the owner restarted three such stops in a row by hand, each
// within six minutes, and the chain sat idle overnight. The sandbox's loops/context-continue.ts recognises the stop and
// carries the conversation on in a fresh session seeded with the latest messages, where the work stands, and what the
// stopped turn said was left, at most this many times in a row. Zero to begin with: a continuation spends the allowance
// on work nobody is watching, so until the owner raises it the conversation is only told it could carry on.

/* When a conversation carries on by itself, with nobody sending it a message: past a large context, once something it
   asked a person for arrives, after a restart. Declared here so settings.ts carries one line for each. */

/** The sandbox setting, declared here so settings.ts carries one line for it. */
export const contextContinuesSetting = z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0)
    .describe(
        "How many times in a row a conversation carries on by itself, in a fresh session, after its turn stopped because its context had grown large while work was still open. The fresh session opens with the latest messages, where the work stands, and what the stopped turn said was left. A message from anyone else starts the count again. Zero never carries on by itself: the conversation is told it could, and the next move is yours.",
    );

// A person answering a need is exactly the moment they want the work to go on (docs/architecture/needs.md), unlike a
// restart nobody watched, so this one is on to begin with.
export const continueWhenNeedMetSetting = z
    .boolean()
    .default(true)
    .describe(
        "Whether a conversation carries on by itself once something it asked a person for arrives: a connection made, a secret given, access allowed, a tool built into the image. Off leaves the answer on the conversation's card until someone sends a message.",
    );

// A switch rather than a policy: a restart is the one ending with nobody watching it. On to begin with (2026-11-23): off,
// a restart left every conversation it cut waiting for a press, and one whose turn was waiting on its own subagents (cut
// by the same restart) had nothing left that would ever wake it. A restart storm still resumes nothing
// (restart-resume-policy.ts), and a restart traced to memory goes by memoryKillPolicy.
export const autoResumeOnRestartSetting = z
    .boolean()
    .default(true)
    .describe(
        "Whether a turn killed by the sandbox restarting is re-run once it comes back. A switch rather than one of the policies above, because a restart is the one ending with nobody watching it, so there is no in-chat question to answer. On to begin with, so work a restart cut carries on rather than waiting for a press; turn it off if you would rather not have the allowance spent and files edited while you are not watching. A burst of restarts in a row resumes nothing. Either way the interruption is recorded rather than silently lost. A restart the sandbox traces to memory running out goes by `memoryKillPolicy` instead, whatever this says.",
    );
