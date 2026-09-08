// Activity audit log schemas (historyRoot/activity.jsonl).
import { z } from "zod";
import { AgentOriginSchema } from "./agent.js";
// One provider-agnostic event per agent↔provider interaction, appended only by the daemon; the log lives outside /work,
// so an agent can't read or rewrite its own trail.

export const ActivityEventSchema = z.object({
    id: z.string().describe("The entry's own id."),
    // Epoch ms; also the paging cursor.
    at: z.number().describe("When it happened, in milliseconds. Also what you page by."),
    // "discord", …; absent on provider-less system events (a cron automation.run).
    provider: z.string().optional().describe("Which outside service, when one was involved. Absent for the sandbox's own events."),
    // Which provider account handled it; attribution key for per-account usage, absent on provider-less or
    // default-account turns.
    account: z
        .string()
        .optional()
        .describe("Which account handled it. Absent for the sandbox's own events and for work run on a provider's default."),
    direction: z.enum(["in", "out", "system"]).describe("Whether something arrived, something went out, or the sandbox did it to itself."),
    // in: message.received, voice_utterance.received, voice_transcript.received
    // out: message.send, reaction.add, messages.read, api.call (unclassified endpoint)
    // system: gateway.login_failed, dispatch.failed, voice.session_started, voice.session_ended, automation.run,
    // turn.started, turn.plan, turn.error, turn.completed, rule.blocked_push, rule.held_work, rule.continued_turn
    type: z
        .string()
        .describe(
            "Exactly what happened: a message received or sent, a reaction, a turn starting or ending, a rule doing something. A rule that ran and passed says nothing here, because a feed of green ticks is one the eye learns to skip.",
        ),
    channelId: z.string().optional().describe("Which channel or thread it happened in."),
    // Inbound author display name.
    author: z.string().optional().describe("Who sent it, for something that arrived."),
    // Distinct from `author` (the relayed sender) and `account` (who served it); absent for an unasked wake.
    actor: z
        .string()
        .optional()
        .describe("Who asked for the turn, as the sandbox verified it: a member's email, or token:<label> for a program's control token. Absent for a wake nothing asked for."),
    // Full message text (inbound) or sent payload content (outbound).
    content: z.string().optional().describe("The message, in full, whichever direction it went."),
    // HTTP method and endpoint path of an outgoing call; credentials ride headers, never the URL.
    method: z.string().optional().describe("The verb of an outgoing call."),
    endpoint: z.string().optional().describe("The address of an outgoing call. Credentials travel in headers, so they are never here."),
    // The agent turn that made/handled it, the join key between an inbound wake and its outbound calls.
    sessionId: z.string().optional().describe("The provider session behind it."),
    // Ties one turn's events together; not sessionId, minted only after turn.started, too late for that event.
    turnId: z
        .string()
        .optional()
        .describe(
            "Ties one turn's entries together. A turn writes several, and read as separate rows they say one thing several times, so a feed groups on this.",
        ),
    // Outlives sessionId, retired by a provider switch; this is what "same agent" means across a feed.
    conversationId: z
        .string()
        .optional()
        .describe(
            "Which conversation. This, rather than the provider session, is what the same agent means across a feed, because a session is retired whenever the model changes.",
        ),
    // Denormalized title at write time, since the registry entry is prunable/renameable; absent before the auto-namer
    // runs.
    title: z
        .string()
        .optional()
        .describe(
            "What that conversation was called at the time. Copied in rather than looked up, because an audit entry must still read as words years later, after the conversation has been renamed or pruned.",
        ),
    // Files a turn under what caused it (e.g. Discord), not under the runtime that served it.
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
// Live connection health, probed per capability, not stored; `gateway` from the client pool, `lastError` from the
// newest system-error event in the log.
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
