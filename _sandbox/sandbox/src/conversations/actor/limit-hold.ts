import { AgentTurnSchema } from "@intentic/sandbox-contract/schemas/agent";
import { HandoffOfferSchema } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { RESUME_NOTES, type ResumeReason } from "@intentic/sandbox-contract/events/resume";
import { TodoItemSchema } from "@intentic/sandbox-contract/events/requests";
import { TurnSpeakerSchema } from "@intentic/sandbox-contract/schemas/speaker";
import { turnedAwayCode } from "@intentic/sandbox-contract/policy/turned-away";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import type { HeldRecord } from "./conversation-state.js";

// A held turn, as the conversation's entry keeps it so a restart keeps its booking and its remedy. A limit hold was the
// first: the owner answered "send again" (or "move") for a reset hours away, and a restart in between used to drop the
// turn and the booking with it, leaving the card in Attention under a clock nothing would act on (2026-10-07). Every
// other wall is kept the same way (2026-10-19): a stopped turn's ladder (its rungs and how many it has climbed), an
// outage's wait for the provider, an overflow's fresh session, and a flagged turn's fork point before the stopped
// response, which a press without it would send the classifier again. A refused credential's hold alone stays memory:
// its re-mint has a minute, and the token it must supersede is not written to disk.
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

// Every wall a hold is kept for but a spent allowance's, which is the absent reason an older build wrote.
const KEPT_REASONS = ["door", "stopped", "outage", "overflow", "flagged"] as const;

export const StoredLimitHoldSchema = z.object({
    // Absent for a spent allowance's, the only kind an older build kept.
    reason: z.enum(KEPT_REASONS).optional(),
    // How many rungs of its ladder a stopped turn has climbed, so a restart neither forgets them nor climbs them again.
    tries: z.number().int().nonnegative().optional(),
    // A flagged turn's session entry before the stopped response (refusal-fork.ts), where a press resumes it.
    forkAt: z.string().optional(),
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
    // Held at the door (spent-door.ts): its re-run keeps the session, so a restart must keep this too.
    turnedAway: z.boolean().optional(),
    handoff: HandoffOfferSchema.optional(),
    // When the refusal was recorded: the resume pass never fires at a reopen instant at or before it (turn-resume.ts).
    recordedAt: z.number(),
});
export type StoredLimitHold = z.infer<typeof StoredLimitHoldSchema>;

/** Whether this hold is one the entry keeps: any wall but a refused credential's, not yet fired. */
export const keptHold = (held: HeldRecord | undefined): held is HeldRecord => held !== undefined && held.reason !== "auth" && !held.fired;

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
    const { reason, fired: _fired, tries, remint: _remint, resumeAt, ...kept } = held;
    return StoredLimitHoldSchema.safeParse({
        ...kept,
        ...opt("reason", reason === "limit" ? undefined : reason),
        ...opt("tries", tries > 0 ? tries : undefined),
        ...opt("forkAt", resumeAt),
    });
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
    if (!standsBehind(stored, entry.ending)) {
        return undefined;
    }
    const { standing, input, run, sessionId, reopensAt, reason, tries, forkAt, ...rest } = stored;
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
        ...opt("standing", standing === undefined ? undefined : { state: standing.state, paths: standing.paths, check: standing.check }),
        ...opt("resumeAt", forkAt),
        reason: reason ?? "limit",
        fired: false,
        tries: tries ?? 0,
    };
};

// Whether the entry still ends in the wall that held the turn: a hold an older build left under a later turn is not one.
const standsBehind = (stored: StoredLimitHold, ending: PersistedAgent["ending"]): boolean => {
    switch (stored.reason) {
        case undefined:
            return ending.kind === "limited";
        case "door":
            return ending.kind === "failed" && turnedAwayCode(ending.code);
        case "flagged":
            return ending.kind === "failed" && ending.code === "safeguard-flagged";
        // Booked to come back at once, so its failure reads as work in progress (conversation-decide.ts comingBackNow):
        // the entry is left as the turn before it left it, or failed where the wall said so.
        case "stopped":
        case "outage":
        case "overflow":
            return ending.kind === "failed" || ending.kind === "idle";
    }
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
        services.logger.info({ restored }, "boot: held turns were put back with their bookings and remedies (a spent allowance, a door, a stop, an outage, an overflow, a flag)");
    }
    return restored;
};
