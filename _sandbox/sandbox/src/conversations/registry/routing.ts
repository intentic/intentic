import { type AgentHarness, type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../composition.js";

// Which account a conversation's turn runs on, in one place. The conversation's profile (`provider`, `harness`,
// `account`, and the session minted on them) is the one truth; a turn, a press, a wake or a queued batch only states
// intent: a provider and harness, and at most an explicit account. Every daemon path that used to decide this for
// itself (the turn decision's latch, the registry's profile write, the resume press, the queue drain) asks here.
//
// An account left undefined is `auto`: nothing on file for this provider, so the credential resolver takes the
// serviceability pick (usage/serviceability.ts via preferredAccount), and the session frame then latches what served.
// An account filled in from the profile (the turn named none) is the conversation's remembered routing, not a choice
// made for this turn: where it can no longer serve, planning moves the conversation off it (blocked-account.ts).
// Continuing (`continues`) is decided here too, and only here: a client's own idea of the session is no say in it.

/** What a conversation runs on as its record has it; undefined for a conversation not opened yet. */
export interface RoutingProfile {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly account?: string | undefined;
}

/** What a request asks for. Absent provider and harness are the wire's defaults (claude, native). */
export interface RoutingIntent {
    readonly agent?: AgentProvider | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly account?: string | undefined;
}

export interface Routing {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // Undefined is `auto`: resolved by serviceability where the credential is minted.
    readonly account: string | undefined;
    // Whether the turn runs where the profile's session was minted (same provider, harness and account), the only
    // place that session may be resumed.
    readonly continues: boolean;
}

/**
 * The account a turn runs on: the one it names, else the one the conversation runs on, but only on the provider that
 * account belongs to (another provider's id names nothing there). A harness change keeps it: the account belongs to
 * the provider, not to the loop.
 */
export const routingFor = (profile: RoutingProfile | undefined, intent: RoutingIntent): Routing => {
    const { agent: provider, harness } = withRuntimeDefaults({ agent: intent.agent, harness: intent.harness });
    const held = profile?.provider === provider ? profile.account : undefined;
    const account = intent.account ?? held;
    return {
        provider,
        harness,
        account,
        continues: profile !== undefined && profile.provider === provider && sameLoop(profile, harness) && account === profile.account,
    };
};

// Whether a harness names the loop the profile's session was minted on. Two names for one runtime are one loop: a Kimi or
// Cursor conversation recorded under "claude-code" (before requests were normalized) keeps its session on "native".
export const sameLoop = (profile: RoutingProfile, harness: AgentHarness): boolean =>
    capabilitiesOf(profile.provider, profile.harness).runtime === capabilitiesOf(profile.provider, harness).runtime;

/**
 * The provider session a turn continues, decided here and nowhere else: on a conversation the daemon holds, its own
 * session, and only on the runtime and account that minted it (`routingFor(...).continues`); otherwise none, and the turn
 * opens a fresh session seeded from the record. A `sessionId` a client sent is no say in it: an older editor sends one it
 * worked out itself, which this ignores. Only a conversation not on record yet takes the one it names, since a past
 * session resumed from the history menu has no record.
 *
 * Asked of the routing the turn will RUN on, so a turn whose provider is chosen after the caller builds it (a persona's
 * or a run role's pin, turn-routing.ts) is judged on that one, not on the default it would have had. A caller that cannot
 * wait for the pin asks the door to decide (`continuing`, turn-doors.ts).
 */
export const sessionFor = (
    services: Pick<Services, "agents" | "conversations">,
    routing: RoutingIntent & { readonly conversationId: string; readonly sessionId?: string | undefined },
): string | undefined => {
    const entry = services.agents.entry(routing.conversationId);
    if (entry === undefined) {
        return routing.sessionId;
    }
    return routingFor(entry.profile, routing).continues ? services.conversations.sessionIdOf(routing.conversationId) : undefined;
};
