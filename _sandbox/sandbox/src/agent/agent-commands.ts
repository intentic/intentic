import type { AgentCommand, AgentProvider } from "@intentic/sandbox-contract";

/* The last slash-command list each provider published, so a conversation's `/` popover works BEFORE that
 * conversation has run a turn. The list is a property of the provider + workspace, not of a conversation:
 * every turn republishes it, and it is identical across the conversations of one sandbox.
 *
 * Populated from real turns rather than by probing, deliberately. A command list is only accurate when the
 * session that reports it loaded the same config the turn will (settingSources → the workspace's
 * .claude/commands, plus the turn's plugins), so a throwaway probe session would answer with built-ins alone
 * and hide exactly the project commands this exists to surface. Turns already carry that config, so the
 * accurate list is free, the only cost is that a sandbox where the provider has never run a turn reads
 * empty, which is one turn of emptiness rather than a permanently wrong list.
 *
 * In-memory: a daemon restart re-learns on the next turn. Keyed by provider. Claude's commands and each ACP
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

/* Whether the Claude Code harness will read this prompt as a slash command and then throw it away. The CLI
 * parses a leading `/` as a command name: one it doesn't know makes it answer "Unknown command: /x" locally
 * and DISCARD the rest of the message, so the model never sees a word of it and the turn ends with no reply.
 *
 * Prose hits that constantly here, because this product's own vocabulary is slash-prefixed, "/workspace view
 * does not remember…", "/agents/{id} shows…", "/etc/hosts is stale". The command reading of an unknown name
 * cannot succeed, so there is nothing to weigh: rewriting it as prose (turn-preamble.ts) is the only reading
 * that can work.
 *
 * Answered here rather than in the composer so every client is covered, web, mobile, automations, cron wakes
 *, and against the SAME list the CLI matches on: supportedCommands(), republished by every turn.
 *
 * An empty list means "not learned yet" (no turn since this daemon started), never "this provider has no
 * commands", guessing there would turn a real /compact into prose, so the guard stands down and lets the
 * CLI's own refusal surface instead (agent.ts translates it to an unknown-command error frame). */
export function isUnknownSlashCommand(provider: AgentProvider, prompt: string): boolean {
    const known = commandsOf(provider);
    // Leading whitespace is trimmed before the check because the CLI's own parse is at least as forgiving:
    // treating " /foo" as prose when the CLI still reads it as a command is the failure this exists to stop.
    const text = prompt.trimStart();
    if (known.length === 0 || !text.startsWith("/")) {
        return false;
    }
    const name = text.slice(1).split(/\s/, 1)[0] ?? "";
    return name.length > 0 && !known.some((command) => command.name === name);
}

// What a command the CLI answered ITSELF actually said, unwrapped from the tag the transcript stores it
// under. Trimmed because the wrapper is written on its own lines and the text is rendered as prose.
export function localCommandText(content: string): string {
    const wrapped = /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content);
    return (wrapped?.[1] ?? content).trim();
}

// The name in the CLI's "Unknown command: /x" refusal, the one local-command answer that means the user's
// message was thrown away rather than acted on. Undefined for every other command's output, which is real
// content to show.
export function unknownCommandName(output: string): string | undefined {
    return /^Unknown command:\s*\/?(\S+)/.exec(output)?.[1];
}

// Sandbox reset / test isolation.
export function resetCommands(): void {
    published.clear();
}
