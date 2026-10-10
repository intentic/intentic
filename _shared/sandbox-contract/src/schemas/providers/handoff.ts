import { z } from "zod";
import { tokensLabel } from "../keep-warm.js";
import type { SandboxNotice } from "../../events/sandbox-notice.js";

// What a conversation hands the session that continues it after a spent usage allowance, when the prompt cache is cold
// and continuing means reading the conversation again from scratch. Measured on real sessions before it was built
// (sandbox/bench/handoff-bench.ts, 2026-10-09): context is ~94% tool output, and every call of the next turn re-reads
// whatever the session starts from, so the starting size sets the cost of the whole turn, not just of its first call.
//
//   carry    resume the session as it is: the model keeps everything, and re-reads all of it
//   trim     resume a copy of the session with older tool output cleared; every message and tool call stays
//   summary  a fresh session opened with a smaller model's summary and the last exchanges word for word
//
// The sandbox suggests one by the conversation's size; the person picks, on the card or as a standing setting.

export const HANDOFF_MODES = ["carry", "trim", "summary"] as const;
export const HandoffModeSchema = z.enum(HANDOFF_MODES);
export type HandoffMode = z.infer<typeof HandoffModeSchema>;

// The standing answer: `suggested` follows the size-based suggestion, anything else names one mode, used wherever it
// is available.
export const LimitHandoffSchema = z.enum(["suggested", ...HANDOFF_MODES]);
export type LimitHandoff = z.infer<typeof LimitHandoffSchema>;

// How many of the newest tool results a trimmed session keeps whole.
export const TRIM_KEEPS_RESULTS = 10;

export const HandoffOfferSchema = z.object({
    suggested: HandoffModeSchema.describe("The hand-off the sandbox would use unless told otherwise."),
    basis: z
        .enum(["size", "setting"])
        .describe("Why that one: the conversation's size (the sandbox's suggestion), or the owner's standing setting naming it."),
    carry: z
        .object({
            tokens: z.number().optional().describe("The context resuming the session re-reads. Absent where nothing measured it."),
        })
        .optional()
        .describe("Present where the session can be resumed as it is."),
    trim: z
        .object({
            tokens: z.number().describe("The estimated context a trimmed copy of the session starts from."),
            cleared: z.number().describe("How many older tool outputs trimming clears."),
        })
        .optional()
        .describe("Present where this runtime's session can be trimmed: a Claude Code session the sandbox holds."),
    summary: z
        .object({
            tokens: z.number().describe("The estimated context a fresh session opened with the summary starts from."),
            reads: z.number().optional().describe("The estimated tokens the summarising model reads once to write it."),
        })
        .optional()
        .describe("Present where a model is set for hand-off summaries (Sandbox ▸ Agent ▸ Models)."),
    chosen: HandoffModeSchema.optional().describe("The hand-off a person picked for this held turn, which every later send of it uses."),
});
export type HandoffOffer = z.infer<typeof HandoffOfferSchema>;

export const ChooseHandoffSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation's held turn."),
    handoff: HandoffModeSchema.describe("How the next send of the held turn continues the conversation."),
});
export type ChooseHandoff = z.infer<typeof ChooseHandoffSchema>;

export const handoffAvailable = (offer: HandoffOffer, mode: HandoffMode): boolean => offer[mode] !== undefined;

// The sandbox's suggestion for a session of `tokens` context: carry a small one (trimming saves little), trim the
// middle band (keeps almost everything at a fraction of the read), summarise a very large one (a trimmed copy still
// holds every message and tool call, which past ~700k is itself large). Falls to whatever is available.
export const suggestHandoff = (
    tokens: number | undefined,
    available: (mode: HandoffMode) => boolean,
    thresholds: { readonly carryUnder: number; readonly summaryOver: number },
): HandoffMode | undefined => {
    const order: readonly HandoffMode[] =
        tokens === undefined || tokens < thresholds.carryUnder
            ? ["carry", "trim", "summary"]
            : tokens >= thresholds.summaryOver
              ? ["summary", "trim", "carry"]
              : ["trim", "summary", "carry"];
    return order.find((mode) => available(mode));
};

// How a held turn actually continued, told once as its re-run starts, which the transcript keeps as a row: what it
// started from beside what carrying the session whole would have re-read. `fellBack` names a hand-off that was asked for
// and could not be built (no session file to trim, no model answered for the summary), which went on with the short
// record hand-off instead.
export const HandedOffSchema = z.object({
    mode: HandoffModeSchema,
    tokens: z.number().optional().describe("The context the continuing session starts from, estimated."),
    from: z.number().optional().describe("What carrying the session whole would have re-read."),
    cleared: z.number().optional().describe("Older tool outputs a trimmed copy cleared."),
    model: z.string().optional().describe("The model that wrote the summary."),
    fellBack: z.boolean().optional(),
});
export type HandedOff = z.infer<typeof HandedOffSchema>;

export const handedOffNotice = (event: HandedOff): Extract<SandboxNotice, { code: "handedOff" }> => ({
    code: "handedOff",
    params: {
        mode: event.mode,
        ...(event.tokens === undefined ? {} : { tokens: tokensLabel(event.tokens) }),
        ...(event.from === undefined ? {} : { from: tokensLabel(event.from) }),
        ...(event.cleared === undefined ? {} : { cleared: event.cleared }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.fellBack === true ? { fellBack: true } : {}),
    },
});

/** The transcript's line for how a held turn continued. */
export const handedOffLine = (event: HandedOff): string => {
    if (event.fellBack === true) {
        return event.mode === "trim"
            ? "Could not trim the session for the hand-off, so it was carried whole."
            : "Could not write a summary for the hand-off, so the fresh session opened with the recent conversation and where the work stands instead.";
    }
    const tokens = event.tokens === undefined ? undefined : tokensLabel(event.tokens);
    switch (event.mode) {
        case "carry":
            return `Continued in the same session, re-reading all of it${tokens === undefined ? "" : ` (about ${tokens} tokens)`}.`;
        case "trim": {
            const cleared = event.cleared ?? 0;
            const size =
                tokens === undefined ? "" : event.from === undefined ? ` (about ${tokens} tokens)` : ` (about ${tokens} tokens instead of ${tokensLabel(event.from)})`;
            return `Continued in a trimmed copy of the session${size}: ${cleared} older tool output${cleared === 1 ? "" : "s"} cleared, every message and tool call kept.`;
        }
        case "summary":
            return `Continued in a fresh session opened with a summary of the conversation${event.model === undefined ? "" : ` written by ${event.model}`}.`;
    }
};
