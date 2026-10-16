import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import { parseSkillFile } from "../../skill-file.js";
import { stripTurnPreamble } from "../../sessions/vocabulary/prompt-envelope.js";
import { readTextIfExists } from "@intentic/base/fs";

// Cursor's custom commands: one Markdown file per command under the project's `.cursor/commands/`, its name the file's
// and its body the prompt it stands for. The SDK loads them for its own `/` but publishes no list back, so the daemon
// reads the folder itself: the list goes out as a `commands` frame for the composer's `/` popover, and a message that
// opens with `/name` is sent as that command's text, what Cursor's own editor does with it.

export interface CursorCommand extends AgentCommand {
    // The prompt the command stands for: the file without its frontmatter.
    readonly body: string;
}

const COMMANDS_DIR = join(".cursor", "commands");

// Longest description the popover shows before it is cut; a command file's first line can be a whole paragraph.
const DESCRIPTION_CHARS = 120;

// What a command says it does: its frontmatter's description, else its first non-blank line with any heading marks off.
const describe = (description: string | undefined, body: string): string => {
    const first = description ?? body.split("\n").find((line) => line.trim() !== "") ?? "";
    const plain = first.replace(/^#+\s*/, "").trim();
    return plain.length > DESCRIPTION_CHARS ? `${plain.slice(0, DESCRIPTION_CHARS - 1)}…` : plain;
};

// Every command a project's tree carries, in name order; a tree with no such folder has none. `root` is the folder Cursor
// opens the project at, as the daemon reads it.
export const cursorCommands = async (root: string): Promise<CursorCommand[]> => {
    const dir = join(root, COMMANDS_DIR);
    // allow(silent-catch): a project without the folder, or one the daemon cannot list, offers no commands
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((entry) => entry.isFile() && extname(entry.name) === ".md").map((entry) => entry.name);
    const commands = await Promise.all(
        files.map(async (file): Promise<CursorCommand | undefined> => {
            // A file that vanished between the listing and the read is no command.
            const text = await readTextIfExists(join(dir, file));
            if (text === undefined) {
                return undefined;
            }
            const parsed = parseSkillFile(text);
            const body = parsed.body.trim();
            return body === "" ? undefined : { name: basename(file, ".md"), description: describe(parsed.description, body), body };
        }),
    );
    return commands.filter((command) => command !== undefined).toSorted((a, b) => a.name.localeCompare(b.name));
};

const INVOKED = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/;

// The prompt with a `/name rest` message replaced by the named command's text, the rest after it; the daemon's notes in
// front of the message stay as they were. A message naming no command is sent as typed.
export const expandCursorCommand = (prompt: string, commands: readonly CursorCommand[]): string => {
    const words = stripTurnPreamble(prompt);
    const invoked = INVOKED.exec(words.trim());
    const command = invoked === null ? undefined : commands.find((candidate) => candidate.name === invoked[1]);
    if (command === undefined) {
        return prompt;
    }
    const rest = invoked?.[2]?.trim() ?? "";
    return `${prompt.slice(0, prompt.length - words.length)}${rest === "" ? command.body : `${command.body}\n\n${rest}`}`;
};
