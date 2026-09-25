import { type AgentHarness, type AgentProvider, DEFAULT_HARNESS, DEFAULT_PROVIDER } from "@intentic/sandbox-contract";

// Which account a conversation's turn runs on, in one place. The conversation's profile (`provider`, `harness`,
// `account`, and the session minted on them) is the one truth; a turn, a press, a wake or a queued batch only states
// intent: a provider and harness, and at most an explicit account. Every daemon path that used to decide this for
// itself (the turn decision's latch, the registry's profile write, the resume press, the queue drain) asks here.
//
// An account left undefined is `auto`: nothing on file for this provider, so the credential resolver takes the
// serviceability pick (usage/serviceability.ts via preferredAccount), and the session frame then latches what served.

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
    const provider = intent.agent ?? DEFAULT_PROVIDER;
    const harness = intent.harness ?? DEFAULT_HARNESS;
    const held = profile?.provider === provider ? profile.account : undefined;
    const account = intent.account ?? held;
    return {
        provider,
        harness,
        account,
        continues: profile !== undefined && profile.provider === provider && profile.harness === harness && account === profile.account,
    };
};
