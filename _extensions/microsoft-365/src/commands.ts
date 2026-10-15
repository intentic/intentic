import { readFile } from "node:fs/promises";
import { type ActionDraft, actionFor, type ActionOutcome, executeAction, loadAction } from "./actions.js";
import { calendarCommands } from "./calendar.js";
import { documentCommands } from "./documents.js";
import { workspaceFile } from "./files.js";
import type { Graph, Json } from "./graph.js";
import { mailCommands } from "./mail.js";

// The `m365` command line: words pick a command, `--flag value` pairs carry its options, and a flag the command does
// not read is refused before anything is sent, rather than silently dropped. Output is Graph's JSON, trimmed with
// `$select` to what a reader needs; failures print to stdout with exit 2, the agent-CLI contract `gw` keeps too.

export const HELP = `m365 [--account <card id>] <group> <command> [arguments] [--flags]
  accounts | whoami | auth login
  mail folders [--folder <parent-id>] [--search <text>]
  mail list [--folder inbox] [--filter "isRead eq false"] [--limit 25]
  mail search --query <text> [--folder <id>] [--limit 25]
  mail read <message-id> [--attachments <workspace dir>] [--body text|html]
  mail draft --file <message.json> [--attach a.pdf,b.docx]
  mail send --file <message.json> [--attach a.pdf,b.docx]
  mail reply <message-id> --file <reply.json> [--attach …]   (also: reply-all, forward)
  calendar calendars
  calendar events --from <ISO> --to <ISO> [--calendar <id>] [--tz Europe/Warsaw] [--limit 100]
  calendar read <event-id> [--tz Europe/Warsaw]
  calendar create --file <event.json> | update <event-id> --file <changes.json> | cancel <event-id> --file <cancel.json>
  files drives | sites --query <text> | libraries <site-id>
  files list [--drive <id>] [--item <folder-id>] [--limit 200]
  files search --query <text> [--drive <id>] [--limit 50]
  files download <item-id> --out <workspace path> [--drive <id>]
  files upload --file <workspace path> --name <file name> [--drive <id>] [--parent <folder-id>]
  action run <approval-id>
Sending, replying, forwarding, calendar changes and uploads wait for the owner's approval unless an action rule says
otherwise (microsoft365.mail.send, microsoft365.calendar.write, microsoft365.files.upload).`;

export interface Arguments {
    readonly words: readonly string[];
    readonly flags: Readonly<Record<string, string>>;
}

const KNOWN_FLAGS = new Set([
    "account",
    "attach",
    "attachments",
    "body",
    "calendar",
    "drive",
    "file",
    "filter",
    "folder",
    "from",
    "item",
    "limit",
    "name",
    "out",
    "parent",
    "query",
    "search",
    "to",
    "tz",
]);

export const parse = (args: readonly string[]): Arguments => {
    const words: string[] = [];
    const flags: Record<string, string> = {};
    for (let index = 0; index < args.length; index++) {
        const value = args[index] ?? "";
        if (!value.startsWith("--")) {
            words.push(value);
            continue;
        }
        const key = value.slice(2);
        const next = args[index + 1];
        if (!KNOWN_FLAGS.has(key) || flags[key] !== undefined || next === undefined || next.startsWith("--")) {
            throw new Error(`Unknown, repeated or empty flag: ${value}`);
        }
        flags[key] = next;
        index++;
    }
    return { words, flags };
};

// What each command accepts: the flags it reads, and whether one id follows its name.
interface Usage {
    readonly flags: readonly string[];
    readonly id?: true;
}

const USAGE = new Map<string, Usage>([
    ["accounts", { flags: [] }],
    ["whoami", { flags: [] }],
    ["auth login", { flags: [] }],
    ["mail folders", { flags: ["folder", "search"] }],
    ["mail list", { flags: ["folder", "filter", "limit"] }],
    ["mail search", { flags: ["query", "folder", "limit"] }],
    ["mail read", { flags: ["attachments", "body"], id: true }],
    ["mail draft", { flags: ["file", "attach"] }],
    ["mail send", { flags: ["file", "attach"] }],
    ["mail reply", { flags: ["file", "attach"], id: true }],
    ["mail reply-all", { flags: ["file", "attach"], id: true }],
    ["mail forward", { flags: ["file", "attach"], id: true }],
    ["calendar calendars", { flags: [] }],
    ["calendar events", { flags: ["from", "to", "calendar", "tz", "limit"] }],
    ["calendar read", { flags: ["tz"], id: true }],
    ["calendar create", { flags: ["file"] }],
    ["calendar update", { flags: ["file"], id: true }],
    ["calendar cancel", { flags: ["file"], id: true }],
    ["files drives", { flags: [] }],
    ["files sites", { flags: ["query"] }],
    ["files libraries", { flags: [], id: true }],
    ["files list", { flags: ["drive", "item", "limit"] }],
    ["files search", { flags: ["query", "drive", "limit"] }],
    ["files download", { flags: ["drive", "out"], id: true }],
    ["files upload", { flags: ["file", "name", "drive", "parent"] }],
    ["action run", { flags: [], id: true }],
]);

const commandOf = (args: Arguments): string => {
    const first = args.words[0] ?? "";
    return first === "accounts" || first === "whoami" ? first : args.words.slice(0, 2).join(" ");
};

export const validateArguments = (args: Arguments): void => {
    const name = commandOf(args);
    const usage = USAGE.get(name);
    if (usage === undefined) {
        throw new Error(HELP);
    }
    const stray = Object.keys(args.flags).find((flag) => flag !== "account" && !usage.flags.includes(flag));
    if (stray !== undefined) {
        throw new Error(`--${stray} is not an option of \`m365 ${name}\``);
    }
    const expected = name.split(" ").length + (usage.id === true ? 1 : 0);
    if (args.words.length !== expected) {
        throw new Error(usage.id === true ? `\`m365 ${name}\` takes one id` : `\`m365 ${name}\` takes no further words`);
    }
};

// What one command's code is handed: the connection, the workspace, and its own arguments, already validated.
export interface CommandContext {
    readonly graph: Graph;
    readonly root: string;
    readonly flag: (name: string) => string | undefined;
    readonly required: (name: string) => string;
    readonly id: () => string;
    readonly limit: (fallback: number) => number;
    readonly json: () => Promise<Json>;
    readonly act: (draft: ActionDraft) => Promise<ActionOutcome>;
}

const LIMIT_MAX = 1000;

const contextOf = (graph: Graph, root: string, args: Arguments): CommandContext => {
    const flag = (name: string): string | undefined => args.flags[name];
    const required = (name: string): string => {
        const value = flag(name);
        if (value === undefined || value === "") {
            throw new Error(`--${name} is required`);
        }
        return value;
    };
    return {
        graph,
        root,
        flag,
        required,
        id: () => args.words.at(-1) ?? "",
        limit: (fallback) => {
            const raw = flag("limit");
            const value = raw === undefined ? fallback : Number(raw);
            if (!Number.isInteger(value) || value < 1 || value > LIMIT_MAX) {
                throw new Error(`--limit takes a whole number from 1 to ${LIMIT_MAX}`);
            }
            return value;
        },
        // SAFETY: the file is the agent's own request body; Graph validates its shape and refuses what it cannot use.
        json: async () => JSON.parse(await readFile(await workspaceFile(root, required("file"), false), "utf8")) as Json,
        act: (draft) => executeAction(root, graph, actionFor(graph.account, draft)),
    };
};

// What a command prints: Graph's own JSON, or what became of an action.
export type Output = Json | ActionOutcome | undefined;

export const runCommand = async (graph: Graph, root: string, args: Arguments): Promise<Output> => {
    validateArguments(args);
    const name = commandOf(args);
    const ctx = contextOf(graph, root, args);
    if (name === "whoami") {
        return graph.call<Json>("/me?$select=id,displayName,mail,userPrincipalName,preferredLanguage");
    }
    if (name === "action run") {
        return executeAction(root, graph, await loadAction(root, ctx.id()), ctx.id());
    }
    const command = args.words[1] ?? "";
    const group = args.words[0] === "mail" ? mailCommands : args.words[0] === "calendar" ? calendarCommands : documentCommands;
    const run = group[command];
    if (run === undefined) {
        throw new Error(HELP);
    }
    return run(ctx);
};

export type Commands = Readonly<Record<string, (ctx: CommandContext) => Promise<Output>>>;
