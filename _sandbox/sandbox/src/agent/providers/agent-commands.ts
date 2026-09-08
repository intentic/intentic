import type { AgentCommand, AgentProvider } from "@intentic/sandbox-contract";

// The last slash-command list each provider published, populated from real turns rather than probes so it reflects the
// workspace's actual config. In-memory and keyed by provider: a daemon restart re-learns on the next turn.

const published = new Map<AgentProvider, readonly AgentCommand[]>();

// Replaces a provider's published command list wholesale.
export function recordCommands(provider: AgentProvider, items: readonly AgentCommand[]): void {
    published.set(provider, items);
}

// Empty when the provider has not run a turn in this daemon's lifetime.
export function commandsOf(provider: AgentProvider): readonly AgentCommand[] {
    return published.get(provider) ?? [];
}

// Whether the CLI will read this prompt as an unknown slash command and silently discard it without replying. An empty
// list means "not learned yet", never "no commands": treated as false so a real command is never mistaken for prose.
export function isUnknownSlashCommand(provider: AgentProvider, prompt: string): boolean {
    const known = commandsOf(provider);
    // Trimmed first: the CLI's own parse is at least as forgiving of leading whitespace.
    const text = prompt.trimStart();
    if (known.length === 0 || !text.startsWith("/")) {
        return false;
    }
    const name = text.slice(1).split(/\s/, 1)[0] ?? "";
    return name.length > 0 && !known.some((command) => command.name === name);
}

// Unwraps a CLI-answered command's text from the <local-command-stdout> tag the transcript stores it under.
export function localCommandText(content: string): string {
    const wrapped = /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content);
    return (wrapped?.[1] ?? content).trim();
}

// The name in the CLI's "Unknown command: /x" refusal; undefined for any other, real, output.
export function unknownCommandName(output: string): string | undefined {
    return /^Unknown command:\s*\/?(\S+)/.exec(output)?.[1];
}

// Sandbox reset / test isolation.
export function resetCommands(): void {
    published.clear();
}
