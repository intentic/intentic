import type { AgentCommand, AgentProvider } from "@intentic/sandbox-contract";

/* The last slash-command list each provider published, so a conversation's `/` popover works BEFORE that
 * conversation has run a turn. The list is a property of the provider + workspace, not of a conversation:
 * every turn republishes it, and it is identical across the conversations of one sandbox.
 *
 * Populated from real turns rather than by probing, deliberately. A command list is only accurate when the
 * session that reports it loaded the same config the turn will (settingSources → the workspace's
 * .claude/commands, plus the turn's plugins), so a throwaway probe session would answer with built-ins alone
 * and hide exactly the project commands this exists to surface. Turns already carry that config, so the
 * accurate list is free — the only cost is that a sandbox where the provider has never run a turn reads
 * empty, which is one turn of emptiness rather than a permanently wrong list.
 *
 * In-memory: a daemon restart re-learns on the next turn. Keyed by provider — Claude's commands and each ACP
 * agent's are different vocabularies. Single-tenant behind the authenticated tunnel, so no per-user scoping
 * (same bet as agent-steering.ts). */

const published = new Map<AgentProvider, readonly AgentCommand[]>();

// Record a provider's freshly-published list. Replace-wholesale, matching the frame's own semantics.
export function recordCommands(provider: AgentProvider, items: readonly AgentCommand[]): void {
    published.set(provider, items);
}

// The provider's last-known commands; empty when it has never run a turn in this daemon's lifetime.
export function commandsOf(provider: AgentProvider): readonly AgentCommand[] {
    return published.get(provider) ?? [];
}

// Sandbox reset / test isolation.
export function resetCommands(): void {
    published.clear();
}
