import type { OpenCodeClient } from "@opencode/client";
import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import { stripTurnPreamble } from "../../sessions/vocabulary/prompt-envelope.js";

// OpenCode's slash commands, for a turn (opencode-agent.ts): which it offers where the turn runs, and whether a prompt
// names one.

// The slash commands OpenCode offers where the turn runs (its own `init` and `review`, a config's own), for the
// composer's `/` popover; none where they cannot be read, which costs only the popover.
export const commandsAt = async (c: OpenCodeClient, cwd: string): Promise<AgentCommand[]> => {
    // allow(silent-catch): an unread list costs the popover its entries, never the turn
    const listed = await c.command.list({ location: { directory: cwd } }).catch(() => undefined);
    return (listed?.data ?? []).map((command) => ({ name: command.name, description: command.description ?? "" }));
};

// A prompt whose words (after the daemon's notes) open with `/name`, naming a command OpenCode offers: the command, the
// rest of the words as its arguments, and the notes, which ride ahead of it as the session's own context.
export const commandIn = (prompt: string, commands: readonly AgentCommand[]): { name: string; text: string; notes: string } | undefined => {
    const words = stripTurnPreamble(prompt);
    const match = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/u.exec(words.trimStart());
    const name = match?.[1];
    if (name === undefined || !commands.some((command) => command.name === name)) {
        return undefined;
    }
    return { name, text: match?.[2] ?? "", notes: prompt.slice(0, prompt.length - words.length).trim() };
};
