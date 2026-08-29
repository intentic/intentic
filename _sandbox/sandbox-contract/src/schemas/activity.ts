// activity: the activity audit log (historyRoot/activity.jsonl)
import { z } from "zod";
import { AgentOriginSchema } from "./agent.js";
// One provider-agnostic event per agent↔provider interaction, appended by the daemon only (never the agent,
// the log lives under historyRoot, outside /work, so the agent can't read or rewrite its own trail). Discord
// is the first source; other cli providers reuse the same shape.

export const ActivityEventSchema = z.object({
    id: z.string().describe("The entry's own id."),
    // Epoch ms; also the paging cursor.
    at: z.number().describe("When it happened, in milliseconds. Also what you page by."),
    // "discord", …; absent on provider-less system events (a cron automation.run).
    provider: z.string().optional().describe("Which outside service, when one was involved. Absent for the sandbox's own events."),
    // Which provider account handled the turn, the attribution key for per-account usage totals. Absent on
    // provider-less events and turns that ran on the provider's default account.
    account: z
        .string()
        .optional()
        .describe("Which account handled it. Absent for the sandbox's own events and for work run on a provider's default."),
    direction: z.enum(["in", "out", "system"]).describe("Whether something arrived, something went out, or the sandbox did it to itself."),
    // in: message.received | voice_utterance.received | voice_transcript.received
    // out: message.send | reaction.add | messages.read | api.call (unclassified provider endpoint)
    // system: gateway.login_failed | dispatch.failed | voice.session_started | voice.session_ended | automation.run
    //         | turn.started | turn.plan | turn.error | turn.completed (agent turn lifecycle; provider = claude/codex)
    //         | rule.blocked_push | rule.held_work | rule.continued_turn (a rule DID something, see RuleSchema.
    //           Only the three outcomes a person would otherwise have no explanation for: a push that did not
    //           go, work that did not arrive, a turn that did not end. A rule that ran and passed says nothing,
    //           because a feed that logs every green check is one the eye learns to skip.)
    type: z
        .string()
        .describe(
            "Exactly what happened: a message received or sent, a reaction, a turn starting or ending, a rule doing something. A rule that ran and passed says nothing here, because a feed of green ticks is one the eye learns to skip.",
        ),
    channelId: z.string().optional().describe("Which channel or thread it happened in."),
    // Inbound author display name.
    author: z.string().optional().describe("Who sent it, for something that arrived."),
    // Full message text (inbound) or sent payload content (outbound).
    content: z.string().optional().describe("The message, in full, whichever direction it went."),
    // Outbound HTTP method + endpoint path (tokens ride headers, never URLs).
    method: z.string().optional().describe("The verb of an outgoing call."),
    endpoint: z.string().optional().describe("The address of an outgoing call. Credentials travel in headers, so they are never here."),
    // The agent turn that made/handled it, the join key between an inbound wake and its outbound calls.
    sessionId: z.string().optional().describe("The provider session behind it."),
    /* ONE TURN'S EVENTS, TIED TOGETHER. A turn writes four lifecycle events plus one per outbound provider call,
     * and read as five rows they say one thing five times, so the feed groups on this instead. It cannot be
     * sessionId: the runtime does not mint one until the stream's first frame, which is AFTER turn.started, so
     * the very event carrying the prompt is the one that could never be joined. Minted by the turn itself. */
    turnId: z
        .string()
        .optional()
        .describe(
            "Ties one turn's entries together. A turn writes several, and read as separate rows they say one thing several times, so a feed groups on this.",
        ),
    // The stable conversation the turn belongs to. Outlives sessionId, which a provider/account/harness switch
    // retires mid-conversation, so this, not sessionId, is what "the same agent" means across a feed.
    conversationId: z
        .string()
        .optional()
        .describe(
            "Which conversation. This, rather than the provider session, is what the same agent means across a feed, because a session is retired whenever the model changes.",
        ),
    // The conversation's display title as it stood when the event was written. Denormalised on purpose: the
    // registry entry it came from is prunable and renameable, and an audit row must still read as words years
    // later. Absent on the first event of a fresh conversation, the auto-namer has not run yet.
    title: z
        .string()
        .optional()
        .describe(
            "What that conversation was called at the time. Copied in rather than looked up, because an audit entry must still read as words years later, after the conversation has been renamed or pruned.",
        ),
    // What woke the conversation from outside, when something did (see AgentOriginSchema), the feed's "who
    // called me" attribution, and how a turn is filed under Discord rather than under the runtime that served it.
    origin: AgentOriginSchema.optional().describe(
        "What woke the conversation from outside, when something did. It is how a turn gets filed under the chat service that caused it rather than under the model that served it.",
    ),
    automationIds: z.array(z.string()).optional().describe("Which automations were involved."),
    outcome: z.enum(["ok", "error"]).optional().describe("How it ended."),
    error: z.string().optional().describe("What went wrong, when something did."),
    // Source-specific detail: guildId, attachments, transcript path, participants…
    extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Whatever else the source had to say: attachments, participants, a recording's path. Shape varies by source."),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export const ActivityQuerySchema = z.object({
    provider: z.string().optional().describe("Narrow it to one outside service."),
    limit: z.coerce.number().min(1).max(500).default(100).describe("How many entries to return."),
    // `at` cursor, exclusive, newest-first paging.
    before: z.coerce.number().optional().describe("Only entries older than this timestamp, so paging walks backwards through the feed."),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export const ActivityListSchema = z.object({ events: z.array(ActivityEventSchema).describe("The audit entries, newest first.") });
// Live connection health, probed per provider capability (not stored): gateway state from the client pool
// (idle = the gateway is up but has no enabled listener automation to connect for, distinct from a
// connection that should be up but isn't; pairing = the socket is up but the credential is a ceremony nobody
// has finished, which no amount of waiting fixes), lastError from the newest system-error event in the log.
export const ActivityConnectionSchema = z.object({
    capabilityId: z.string().describe("Which connection."),
    provider: z.string().describe("Which service it is."),
    gateway: z
        .enum(["ready", "connecting", "pairing", "disconnected", "idle"])
        .describe(
            "Idle means it is up but has nothing to listen for, which is different from a connection that should be up and is not. Pairing means somebody started a sign-in and never finished it, which no amount of waiting will fix.",
        ),
    lastError: z.string().optional().describe("The most recent thing that went wrong on it."),
});
export const ActivityStatusSchema = z.object({
    connections: z
        .array(ActivityConnectionSchema)
        .describe("Each source feeding the record, and whether it is working. Probed now rather than remembered."),
    // The daemon's live voice session, when one is up.
    voice: z
        .object({
            channelId: z.string().describe("Which channel."),
            channelName: z.string().describe("What it is called."),
            startedAt: z.number().describe("When it joined, in milliseconds."),
            participants: z.array(z.string()).describe("Who else is in it."),
        })
        .optional()
        .describe("A voice call the sandbox is currently in, when it is in one."),
});
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;
