import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";

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

// The command name a `/`-leading prompt opens with: everything up to the first whitespace. Trimmed first, since the
// CLI's own parse is at least as forgiving of leading whitespace. Undefined when the prompt does not open with `/`.
const leadingName = (prompt: string): string | undefined => {
    const text = prompt.trimStart();
    return text.startsWith("/") ? (text.slice(1).split(/\s/, 1)[0] ?? "") : undefined;
};

// Whether the CLI will read this prompt as an unknown slash command and silently discard it without replying. An empty
// list means "not learned yet", never "no commands": treated as false so a real command is never mistaken for prose.
export function isUnknownSlashCommand(provider: AgentProvider, prompt: string): boolean {
    const known = commandsOf(provider);
    const name = leadingName(prompt);
    if (known.length === 0 || name === undefined) {
        return false;
    }
    return name.length > 0 && !known.some((command) => command.name === name);
}

// The published command this prompt opens with, by name; undefined for prose, and for every prompt while the provider's
// list is still unlearned, so the turn goes on exactly as it did before the list existed.
export function publishedCommandOf(provider: AgentProvider, prompt: string): string | undefined {
    const name = leadingName(prompt);
    return name === undefined || name === "" ? undefined : commandsOf(provider).find((command) => command.name === name)?.name;
}

// Unwraps a CLI-answered command's text from the <local-command-stdout> tag the transcript stores it under.
export function localCommandText(content: string): string {
    const wrapped = /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content);
    return (wrapped?.[1] ?? content).trim();
}

// The Claude CLI's own words for a slash command it does not know, checked against the installed binary
// (tests/vendor-phrases.integration.test.ts); a reworded refusal reads as the command's real output.
export const UNKNOWN_COMMAND_PREFIX = "Unknown command:";
const UNKNOWN_COMMAND = new RegExp(String.raw`^${UNKNOWN_COMMAND_PREFIX}\s*\/?(\S+)`);

// The name in the CLI's "Unknown command: /x" refusal; undefined for any other, real, output.
export function unknownCommandName(output: string): string | undefined {
    return UNKNOWN_COMMAND.exec(output)?.[1];
}

// Sandbox reset / test isolation.
export function resetCommands(): void {
    published.clear();
}
