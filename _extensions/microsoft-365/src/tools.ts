import type { ToolCallContext, ToolCard, ToolDefinition } from "@intentic/extension-api";
import { type Account, accountOf } from "./accounts.js";
import type { Act } from "./commands.js";
import { parse, runCommand } from "./commands.js";
import type { CommandIo } from "./files.js";
import type { Graph } from "./graph.js";
import type { SignIns } from "./sign-in.js";

// The tools the backend serves each Microsoft 365 card (`contributes.tools.perCard`): the daemon hands each call the
// card's settings, sign-in included, and the conversation that asked. `m365` in the agent's shell is their caller; the
// model sees them too, and they say so.

// What a tool is called with, as ToolDefinition declares it: JSON, unchecked until parsed here.
type ToolArguments = Parameters<ToolDefinition["call"]>[0];
type ToolArgument = ToolArguments[string];

// One file the CLI saves, or one download it fetches, by the workspace path the command named.
export interface SavedFile {
    readonly path: string;
    readonly data: string;
}
export interface Download {
    readonly path: string;
    readonly url: string;
}

// What one `run` hands back: the command's own JSON, and what the CLI is to save and fetch.
export interface RunAnswer {
    readonly output: Awaited<ReturnType<typeof runCommand>> | { readonly done: true };
    readonly files: readonly SavedFile[];
    readonly downloads: readonly Download[];
}

export interface RunArguments {
    readonly argv: readonly string[];
    readonly files: ReadonlyMap<string, Buffer>;
}

// A JSON string is its own String(): the check needs no representation test.
const isText = (value: ToolArgument): value is string => value === String(value);

export const runArgumentsOf = (args: ToolArguments): RunArguments => {
    const argv = args["argv"];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isText)) {
        throw new Error("argv takes the command's words after `m365`, as strings");
    }
    const sent = args["files"] ?? {};
    if (!(sent instanceof Object) || Array.isArray(sent)) {
        throw new Error("files takes an object of workspace paths to base64 bytes");
    }
    const files = new Map<string, Buffer>();
    for (const [path, data] of Object.entries(sent)) {
        if (!isText(data)) {
            throw new Error(`files["${path}"] must be the file's bytes, base64`);
        }
        files.set(path, Buffer.from(data, "base64"));
    }
    return { argv, files };
};

// The I/O a command runs with in the backend: the files the CLI sent, and a record of what the CLI saves and fetches.
export interface CollectingIo {
    readonly io: CommandIo;
    readonly files: SavedFile[];
    readonly downloads: Download[];
}

export const collectingIo = (sent: ReadonlyMap<string, Buffer>): CollectingIo => {
    const files: SavedFile[] = [];
    const downloads: Download[] = [];
    const io: CommandIo = {
        read: async (path) => {
            const bytes = sent.get(path);
            if (bytes === undefined) {
                throw new Error(`The m365 command did not send ${path}: name the file with --file or --attach`);
            }
            return bytes;
        },
        write: async (path, bytes) => {
            files.push({ path, data: Buffer.from(bytes).toString("base64") });
            return path;
        },
        download: async (path, url) => {
            downloads.push({ path, url });
            return path;
        },
    };
    return { io, files, downloads };
};

export interface ToolDeps {
    readonly graphFor: (account: Account) => Graph;
    // Carries out one outward action for the conversation that asked (actions.ts executeAction, wired by server.ts).
    readonly actFor: (graph: Graph, account: Account, conversationId: string | undefined) => Act;
    readonly signIns: SignIns;
}

const text = (value: RunAnswer | { readonly state: string; readonly message: string } | Readonly<Record<string, string | boolean>>): string =>
    JSON.stringify(value, null, 2);

export const runTool = async (deps: ToolDeps, card: ToolCard, args: ToolArguments, context: Pick<ToolCallContext, "conversationId">): Promise<string> => {
    const { argv, files } = runArgumentsOf(args);
    const account = accountOf(card.id, card.config);
    const graph = deps.graphFor(account);
    const collected = collectingIo(files);
    const output = await runCommand(graph, collected.io, parse(argv), deps.actFor(graph, account, context.conversationId));
    return text({ output: output ?? { done: true }, files: collected.files, downloads: collected.downloads });
};

export const cardTools =
    (deps: ToolDeps) =>
    (card: ToolCard): readonly ToolDefinition[] => [
        {
            name: "run",
            description:
                'Run one `m365` command for this Microsoft 365 card with its sign-in, which never leaves the connection: `argv` is the command\'s words after `m365` (`["mail", "list", "--limit", "5"]`), `files` the base64 bytes of each workspace file it reads (`--file`, `--attach`), keyed by the path as written. Answers the command\'s JSON, the files to save and Microsoft storage addresses to download. The `m365` command in the shell does all of this for you; prefer it. Sends, calendar changes and uploads follow the owner\'s action rules: a held one waits in the approval queue.',
            inputSchema: {
                type: "object",
                properties: { argv: { type: "array", items: { type: "string" } }, files: { type: "object", additionalProperties: { type: "string" } } },
                required: ["argv"],
            },
            effect: "write",
            call: (args, context) => runTool(deps, card, args, context),
        },
        {
            name: "sign_in",
            description:
                "Start Microsoft's sign-in for this card: answers Microsoft's page and a short code for the office user to type there. Then call sign_in_wait until it says done. `m365 auth login` does both.",
            inputSchema: { type: "object", properties: {} },
            effect: "write",
            call: () => deps.signIns.start(accountOf(card.id, card.config)),
        },
        {
            name: "sign_in_wait",
            description: "Wait for the sign-in sign_in started to finish: answers pending or done, or fails with why.",
            inputSchema: { type: "object", properties: {} },
            effect: "read",
            call: async (_args, context) => text(await deps.signIns.wait(accountOf(card.id, card.config), context.signal)),
        },
        {
            name: "status",
            description: "Whether this card is signed in, and with which tenant and access.",
            inputSchema: { type: "object", properties: {} },
            effect: "read",
            call: () => {
                const account = accountOf(card.id, card.config);
                return text({ id: card.id, tenantId: account.tenantId, access: account.access ?? "write", signedIn: (account.refreshToken ?? "") !== "" });
            },
        },
    ];
