import {
    AgentTurnSchema,
    HandoffOfferSchema,
    RESUME_NOTES,
    type ResumeReason,
    TodoItemSchema,
    TurnSpeakerSchema,
    turnedAwayCode,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import type { HeldRecord } from "./conversation-state.js";

// A spent allowance's held turn, as the conversation's entry keeps it so a restart keeps the booking. Every other hold
// is the daemon's memory, gone with it: a stopped turn or an outage is re-asked by the next press. A limit hold is
// different: the owner answered "send again" (or "move") for a reset hours away, and a restart in between used to drop
// the turn and the booking with it, leaving the card in Attention under a clock nothing would act on (2026-10-07).
// Written by the actor whenever the hold changes (conversation-decide.ts, keepLimitHold) and put back at boot
// (restoreLimitHolds below, first at boot). Only an unfired hold is kept: a fired one has started its turn, which the turn
// journal covers from there.
// A turn the sandbox started and the door turned away (a door hold: low memory, a model gone, a refused credential) is
// kept the same way. Its run never started, so no journal covers it, and the commonest door, low memory, is the one a
// restart most often follows: a booked resend that fired into a low-memory refusal used to hand its durable booking on
// to a hold nothing wrote down, and a restart then lost the turn (2026-10-10).

// The turn as the re-run needs it: the request, and who said it, so the re-run is attributed as the refused turn was.
// What only a conversation's first turn reads (owner, fence, postures, title source) is left out: this one has an entry.
const HeldInputSchema = z.intersection(
    AgentTurnSchema,
    z.object({
        conversationId: z.string(),
        speaker: TurnSpeakerSchema.optional(),
        actor: z.string().optional(),
        unseenRuns: z.array(z.string()).optional(),
        resume: z.enum(Object.keys(RESUME_NOTES) as [ResumeReason, ...ResumeReason[]]).optional(),
        resumeAt: z.string().optional(),
    }),
);

const RoutingPickSchema = z.object({ account: z.string(), carry: z.boolean() });

export const StoredLimitHoldSchema = z.object({
    // Absent for a spent allowance's, the only kind an older build kept.
    reason: z.literal("door").optional(),
    input: HeldInputSchema,
    run: z.string().optional(),
    sessionId: z.string().optional(),
    // Epoch seconds the allowance reopens; absent is press-only, which a restart keeps too.
    reopensAt: z.number().optional(),
    ran: z.boolean(),
    standing: z
        .object({ state: z.enum(["verified", "unproven", "failing", "no-code"]), paths: z.array(z.string()), check: z.string().optional() })
        .optional(),
    checklist: z.array(TodoItemSchema).optional(),
    contextTokens: z.number().optional(),
    handoffTokens: z.number().optional(),
    move: RoutingPickSchema.optional(),
    onto: RoutingPickSchema.optional(),
    carryRefused: z.boolean().optional(),
    handoff: HandoffOfferSchema.optional(),
    // When the refusal was recorded: the resume pass never fires at a reopen instant at or before it (turn-resume.ts).
    recordedAt: z.number(),
});
export type StoredLimitHold = z.infer<typeof StoredLimitHoldSchema>;

/** Whether this hold is one the entry keeps: a spent allowance's or one the door turned away, not yet fired. */
export const keptHold = (held: HeldRecord | undefined): held is HeldRecord => (held?.reason === "limit" || held?.reason === "door") && !held.fired;

/**
 * The hold as the entry stores it, through the schema so nothing it cannot read back is written; undefined for a hold
 * the entry does not keep, or one whose turn this build cannot describe (it then lives as long as the daemon, and the
 * invariant "held-limit-turns-are-kept-for-a-restart" reports it: unkeptHoldReason).
 */
export const storedLimitHold = (held: HeldRecord | undefined): StoredLimitHold | undefined => {
    const parsed = parsedHold(held);
    return parsed?.success === true ? parsed.data : undefined;
};

const parsedHold = (held: HeldRecord | undefined) => {
    if (!keptHold(held)) {
        return undefined;
    }
    const { reason, fired: _fired, tries: _tries, remint: _remint, resumeAt: _resumeAt, ...kept } = held;
    return StoredLimitHoldSchema.safeParse(reason === "door" ? { ...kept, reason } : kept);
};

/**
 * Why a hold the entry should keep cannot be written, or undefined when it can (or is not one to keep). A turn the daemon
 * built always parses (turn-admission.ts, together), so an answer here is a bug: the hold lives only as long as the
 * daemon, and a restart loses the turn and its booking. Asked by the invariant that says so (conversations/invariant.ts).
 */
export const unkeptHoldReason = (held: HeldRecord | undefined): string | undefined => {
    const parsed = parsedHold(held);
    return parsed === undefined || parsed.success ? undefined : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
};

/**
 * The hold an entry kept, as the actor holds it after a restart: only while the entry still ends in the refusal that
 * held it (the spent allowance, or a door that turns a whole turn away) and is not archived, so a hold an older build
 * left behind under a later turn never comes back.
 */
export const restoredLimitHold = (entry: PersistedAgent | undefined): HeldRecord | undefined => {
    const stored = entry?.limitHold;
    if (stored === undefined || entry === undefined || entry.archivedAt !== undefined) {
        return undefined;
    }
    const { ending } = entry;
    const standsBehind = stored.reason === "door" ? ending.kind === "failed" && turnedAwayCode(ending.code) : ending.kind === "limited";
    if (!standsBehind) {
        return undefined;
    }
    const { standing, input, run, sessionId, reopensAt, reason, ...rest } = stored;
    const { speaker, actor, unseenRuns, resume, resumeAt, ...turn } = input;
    return {
        ...rest,
        ...opt("run", run),
        ...opt("sessionId", sessionId),
        ...opt("reopensAt", reopensAt),
        input: {
            ...turn,
            ...opt("speaker", speaker),
            ...opt("actor", actor),
            ...opt("unseenRuns", unseenRuns),
            ...opt("resume", resume),
            ...opt("resumeAt", resumeAt),
        },
        ...(standing === undefined ? {} : { standing: { state: standing.state, paths: standing.paths, check: standing.check } }),
        reason: reason ?? "limit",
        fired: false,
        tries: 0,
    };
};

/**
 * Puts back every spent allowance's hold its entry kept across the restart, so the resume pass fires a booked resend at
 * its reset and a booked move at once, as the daemon that made it would have, and a turn the sandbox starts meanwhile
 * (a watch, a queued report) finds the window still shut instead of spending a refusal on it. A door hold comes back
 * too, for its press, or for the memory release where low memory turned it away. Synchronous and first at boot, ahead of anything that could start a turn. Answers how many came back.
 */
export const restoreLimitHolds = (services: Pick<Services, "agents" | "conversations" | "logger">): number => {
    let restored = 0;
    for (const conversationId of services.agents.ids()) {
        const held = restoredLimitHold(services.agents.entry(conversationId));
        if (held !== undefined) {
            services.conversations.send(conversationId, { kind: "hold-restored", held });
            restored += 1;
        }
    }
    if (restored > 0) {
        services.logger.info({ restored }, "boot: held turns a spent allowance or a door stranded were put back, with their bookings");
    }
    return restored;
};
