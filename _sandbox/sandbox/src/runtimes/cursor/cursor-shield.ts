import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { McpServerConfig, SDKCustomTool, SDKCustomToolResult, SDKJsonValue, ToolName } from "@cursor/sdk";
import type { AgentEvent, PersonalDataClass } from "@intentic/sandbox-contract";
import { createHoldback, type Holdback } from "../../privacy/gateway/protocols/holdback.js";
import { type Json, restoreStrings } from "../../privacy/gateway/protocols/walk.js";
import { SHIELD_NOTE } from "../../privacy/gateway/request-shield.js";
import type { TurnShield } from "../../privacy/privacy-shield.js";
import { tokenPattern } from "../../privacy/tokens.js";
import type { CursorHookShield } from "./cursor-hooks.js";
import type { CursorRunHandle, CursorSession } from "./cursor-host.js";

// THE PRIVACY SHIELD ON CURSOR'S RUNTIME. Cursor's agent sends what it reads to its own servers on its own wire, so the
// gateway can't stand in front of it; but every channel its model reads through passes this daemon first, and each is
// read by content here (agent-runtimes.ts `privacy: "hooks"`):
// - every message sent to the agent (the prompt, a plan's revision, steering, a follow-up): masked on the session itself
//   (shieldedSession), so no path that sends can forget to; the instructions the daemon hands over: masked before they
//   are handed over (cursor-agent.ts);
// - the rules Cursor loads itself (AGENTS.md, .cursor/rules): read before the turn, and a finding refuses it, the one
//   thing that can't be masked (instructionRefusal);
// - a file its read tool opens: refused when it holds personal data, since a read can be refused but not changed; the
//   model is pointed at the shell, where the same file arrives masked (cursorHookShield.read);
// - a shell command: rewritten by the preToolUse hook to run through the hook script, which hands its output here to be
//   masked before Cursor reads it (cursor-hooks.ts, cursor-hook-script.ts);
// - the built-in tools that read past both (grep, glob, ls, semantic search, fetch, lints): withheld (SHIELD_WITHHELD);
// - MCP: every server behind the masking proxy (privacy/gateway/mcp-route.ts), the project's own (.cursor/mcp.json,
//   which Cursor would otherwise start unproxied and unapproved) included, or the project's settings not loaded at all
//   when one of its servers can't be proxied (projectMcp); the daemon's own tools: masked here;
// - tokens the model writes: read back to their values in tool inputs, in the new lines of an edited file, and in
//   everything the transcript shows.

// Built-in tools whose output reaches the model past every channel above: off while the shield reads the turn. Names
// in the SDK's own vocabulary; one it does not know makes Agent.create throw, so these are the ones it lists.
export const SHIELD_WITHHELD: readonly ToolName[] = ["grep", "glob", "ls", "semSearch", "webFetch", "readLints"];

// The same tools by the names Cursor's hooks call their executors, refused there as well while the shield masks, so a
// tool that slips past the list above (a renamed one, a subagent's own set) still meets the shield; with the two that
// would hand the model a picture of the screen.
const REFUSED_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob", "List", "Ls", "SemSearch", "ReadLints", "Fetch", "ComputerUse", "RecordScreen"]);

// Told to the model once, with the instructions, while the shield masks: what a token is (the gateway's own note, word
// for word) and where Cursor's own tools stand.
export const CURSOR_SHIELD_NOTE = `${SHIELD_NOTE} On this runtime the privacy shield also stands in front of your tools: a file holding personal data can't be opened with the read tool, so read it with the shell (cat, sed -n, head), where it arrives with tokens in place of the personal data; the grep, glob, ls, semantic search, fetch and lints tools are off, so use the shell for those too (rg, ls, find, curl); and change a file that holds personal data with the shell (sed -i, a heredoc) rather than by writing it whole.`;

// Past this a file's text is not read for personal data: it would hold the hook past Cursor's patience. Refused instead,
// with the shell named as the way to read the part that is needed.
const MAX_CHECKED_CHARS = 2_000_000;

const KIND_WORDS: Readonly<Record<PersonalDataClass, string>> = {
    "person-name": "names",
    "national-id": "national identity numbers",
    "tax-id": "tax numbers",
    "identity-document": "identity document numbers",
    "bank-account": "bank accounts",
    "payment-card": "payment cards",
    email: "email addresses",
    phone: "phone numbers",
    address: "addresses",
};
const kindsSaid = (kinds: readonly PersonalDataClass[]): string => kinds.map((kind) => KIND_WORDS[kind]).join(", ");

const hasToken = (text: string): boolean => tokenPattern().test(text);

// What the model reads when the shield refuses one of its reads or tools: what happened, and the way that does work.
const READ_IN_SHELL =
    "Read it with the shell instead (cat, sed -n, head): its personal data reaches you there as tokens like ⟦PERSON_n⟧, and tokens you write in commands are turned back into the real values before they run.";
export const refusals = {
    read: (path: string, kinds: readonly PersonalDataClass[]): string =>
        `${path} holds personal data (${kindsSaid(kinds)}) this model provider is not trusted with, so the privacy shield did not let the read tool open it. ${READ_IN_SHELL}`,
    tokens: (path: string): string =>
        `${path} holds text shaped like the privacy shield's tokens, which the read tool would hand you unmarked. Read it with the shell instead (cat, sed -n, head), where such text is marked as a literal.`,
    tooLarge: (path: string): string =>
        `${path} is too large for the privacy shield to check, so the read tool did not open it. Read the part you need with the shell (sed -n, head, rg), where the output is masked.`,
    picture: (path: string, kinds: readonly PersonalDataClass[]): string =>
        `${path} shows personal data (${kindsSaid(kinds)}) this model provider is not trusted with, so the privacy shield did not let it be opened.`,
    unreadablePicture: (path: string): string =>
        `${path} is a picture the privacy shield could not read on this machine to check it for personal data, so it was not opened.`,
    document: (path: string, kinds: readonly PersonalDataClass[]): string =>
        `${path} is a document holding personal data (${kindsSaid(kinds)}) this model provider is not trusted with, so the privacy shield did not let the read tool open it. Read its text with the shell instead (pdftotext "${path}" -), where it arrives with tokens in place of the personal data.`,
    unreadableDocument: (path: string): string =>
        `${path} is a document the privacy shield could not read on this machine to check it for personal data, so it was not opened.`,
    opaque: (path: string): string =>
        `${path} is a file the read tool would send as raw bytes, which the privacy shield cannot check for personal data, so it was not opened. Inspect it with the shell instead, where the output is masked.`,
    offTool: (tool: string): string =>
        `The ${tool} tool reads past the privacy shield, so it is off while the shield masks this conversation. Use the shell instead (rg, ls, find, curl): its output reaches you with personal data as tokens.`,
    write: (path: string): string =>
        `${path} holds personal data, and writing it whole would hand back the lines it replaces as they are. Change it with the shell instead (sed -i, a heredoc): personal data reaches you there as tokens, and tokens you write are turned back into the real values.`,
};

// Every string of a tool's input with its tokens read back; the same object when there were none, so nothing is sent
// back to Cursor as changed that was not.
const restoredInput = (input: Record<string, unknown>, restore: (text: string) => string): Record<string, unknown> | undefined => {
    const restored = restoreStrings(input as Json, restore);
    return restored === input ? undefined : (restored as Record<string, unknown>);
};

// The new lines of an edit, read back: each edit's added text holding a token is replaced, wherever it now sits in the
// file, by the same text with its values. Only the added text is touched: a file a whole write could replace holds no
// token-shaped text of its own (`tool` refuses that write), so every match is a line the model just wrote.
export const restoreEdits = (
    content: string,
    edits: readonly { readonly new_string: string }[],
    restore: (text: string) => string,
): string | undefined => {
    let out = content;
    for (const { new_string: added } of edits) {
        if (added === "" || !hasToken(added)) {
            continue;
        }
        const restored = restore(added);
        if (restored !== added) {
            out = out.split(added).join(restored);
        }
    }
    return out === content ? undefined : out;
};

// Thrown in place of sending a message the shield could not mask; the turn reports it as unshielded.
export class UnmaskedMessage extends Error {
    constructor(cause: unknown) {
        super(`The privacy shield could not mask this message, so it was not sent to Cursor. ${cause instanceof Error ? cause.message : ""}`.trim(), { cause });
        this.name = "UnmaskedMessage";
    }
}

const masked = async (shield: TurnShield, text: string): Promise<string> => {
    try {
        return await shield.mask(text, "prompt");
    } catch (error) {
        throw new UnmaskedMessage(error);
    }
};

// The one way a shielded turn talks to its agent: every message, sent or steered into a live run, is masked on its way
// in, and one that cannot be masked is not sent. The run is wrapped member by member: the SDK's Run keeps its methods on
// its prototype, which a spread would drop.
export const shieldedSession = (session: CursorSession, shield: TurnShield): CursorSession => ({
    agentId: session.agentId,
    close: () => session.close(),
    send: async (prompt, options) => {
        const run = await session.send(await masked(shield, prompt), options);
        const steer = run.steer === undefined ? undefined : run.steer.bind(run);
        const handle: CursorRunHandle = {
            wait: () => run.wait(),
            cancel: () => run.cancel(),
            ...(steer === undefined ? {} : { steer: async (text: string) => steer(await masked(shield, text)) }),
        };
        return handle;
    },
});

// The project's own MCP servers on a turn the shield reads. Cursor loads <root>/.cursor/mcp.json with its project
// settings and starts every server in it unapproved and unproxied (@cursor/sdk: includeProjectMcp with
// ignoreApprovals), while a server given in the agent's own options wins its name over the project's. So each server
// that speaks HTTP is given again under its name, through the masking proxy; a server that runs as a local process
// (or one whose address or headers name what can't be filled in here) can't be proxied, and then the project's settings
// are not loaded at all (`withhold`), which drops its rules with its servers rather than let one go to Cursor unmasked.
// `root` is the turn's folder as this process reaches it.
export const projectMcp = async (
    shield: TurnShield,
    root: string,
): Promise<{ readonly servers: Readonly<Record<string, McpServerConfig>> } | { readonly withhold: readonly string[] }> => {
    const text = await readFile(join(root, ".cursor", "mcp.json"), "utf8").catch(() => undefined);
    if (text === undefined) {
        return { servers: {} };
    }
    let declared: unknown;
    try {
        declared = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
    } catch {
        return { withhold: [".cursor/mcp.json"] };
    }
    if (declared === undefined || declared === null) {
        return { servers: {} };
    }
    if (typeof declared !== "object" || Array.isArray(declared)) {
        return { withhold: [".cursor/mcp.json"] };
    }
    const servers: Record<string, McpServerConfig> = {};
    const withhold: string[] = [];
    for (const [name, server] of Object.entries(declared as Record<string, unknown>)) {
        const proxied = await proxiedProjectServer(shield, server);
        if (proxied === undefined) {
            withhold.push(name);
        } else {
            servers[name] = proxied;
        }
    }
    return withhold.length > 0 ? { withhold } : { servers };
};

// Cursor fills ${env:NAME}, ${NAME} and ${NAME:-default} from its environment; anything else left in is not proxied.
const VARIABLE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;
const filled = (text: string): string | undefined => {
    const value = text.replaceAll(VARIABLE, (_match, name: string, fallback: string | undefined) => process.env[name] ?? fallback ?? "");
    return value.includes("${") ? undefined : value;
};

const proxiedProjectServer = async (shield: TurnShield, server: unknown): Promise<McpServerConfig | undefined> => {
    if (typeof server !== "object" || server === null || Array.isArray(server)) {
        return undefined;
    }
    // The masking proxy speaks streamable HTTP, and passes no OAuth flow through.
    const { url, headers, type, auth } = server as { url?: unknown; headers?: unknown; type?: unknown; auth?: unknown };
    if (typeof url !== "string" || (type !== undefined && type !== "http") || auth !== undefined) {
        return undefined;
    }
    const address = filled(url);
    const filledHeaders: Record<string, string> = {};
    if (headers !== undefined) {
        if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
            return undefined;
        }
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
            const header = typeof value === "string" ? filled(value) : undefined;
            if (header === undefined) {
                return undefined;
            }
            filledHeaders[key] = header;
        }
    }
    if (address === undefined) {
        return undefined;
    }
    return {
        type: "http",
        url: await shield.mcpUrl(address),
        ...(Object.keys(filledHeaders).length > 0 ? { headers: filledHeaders } : {}),
    };
};

// The shield's answers to Cursor's hooks for one turn (cursor-hooks.ts CursorHookShield).
export const cursorHookShield = (shield: TurnShield): CursorHookShield => ({
    read: async ({ path, content, image, document, opaque }) => {
        if (document !== undefined) {
            if (document.length === 0) {
                return (await shield.masking()) ? refusals.unreadableDocument(path) : undefined;
            }
            const verdict = await shield.refusesDocument(document, "read");
            if (verdict === "unreadable") {
                return refusals.unreadableDocument(path);
            }
            return verdict.length === 0 ? undefined : refusals.document(path, verdict);
        }
        if (opaque === true) {
            return (await shield.masking()) ? refusals.opaque(path) : undefined;
        }
        if (image !== undefined) {
            if (image.length === 0) {
                return (await shield.masking()) ? refusals.unreadablePicture(path) : undefined;
            }
            const verdict = await shield.refusesImage(image, "read");
            if (verdict === "unreadable") {
                return refusals.unreadablePicture(path);
            }
            return verdict.length === 0 ? undefined : refusals.picture(path, verdict);
        }
        if (content === undefined || content === "") {
            return undefined;
        }
        if (await shield.masking()) {
            if (content.length > MAX_CHECKED_CHARS) {
                return refusals.tooLarge(path);
            }
            if (hasToken(content)) {
                return refusals.tokens(path);
            }
        }
        const kinds = await shield.refuses(content, "read", "a file read was refused: it holds personal data");
        return kinds.length === 0 ? undefined : refusals.read(path, kinds);
    },
    toolCall: async ({ tool, input, existing }) => {
        if (await shield.masking()) {
            if (REFUSED_TOOLS.has(tool)) {
                return { refuse: refusals.offTool(tool) };
            }
            if (tool === "Write" && existing !== undefined && existing !== "") {
                const path = typeof input["file_path"] === "string" ? input["file_path"] : "This file";
                if (existing.length > MAX_CHECKED_CHARS || hasToken(existing)) {
                    return { refuse: refusals.write(path) };
                }
                const kinds = await shield.refuses(existing, "write", "a whole-file write was refused: the file it replaces holds personal data");
                if (kinds.length > 0) {
                    return { refuse: refusals.write(path) };
                }
            }
        }
        return { input: restoredInput(input, shield.restore) };
    },
    shellOutput: (output) => shield.mask(output, "shell"),
    edited: (content, edits) => restoreEdits(content, edits, shield.restore),
});

// THE RULES CURSOR LOADS ITSELF, read before the turn: Cursor's own project setting source reads them off disk and
// hands them to its model, past every channel the daemon owns, so they are the one thing the shield can only refuse.
// The names and places are the SDK's own (its rule loader's watch list); the tree is walked as its loader walks it,
// skipping what it skips.
const RULE_FILES: ReadonlySet<string> = new Set(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".cursorrules"]);
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "__pycache__", "dist", "build", ".git", "refs"]);
// Where a project keeps more instructions the loader reads: its rules, and the agents it may hand a task to.
const RULE_DIRS = [".cursor/rules", ".cursor/agents", ".claude/agents"];
const MAX_DEPTH = 8;
const MAX_DIRS = 4_000;
const MAX_RULE_BYTES = 1_000_000;

const ruleFilesUnder = async (root: string): Promise<string[]> => {
    const found: string[] = [];
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || visited >= MAX_DIRS) {
            return;
        }
        visited += 1;
        // allow(silent-catch): a folder that cannot be listed holds no rule Cursor could load from it either.
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isFile() && RULE_FILES.has(entry.name)) {
                found.push(join(dir, entry.name));
            } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                await walk(join(dir, entry.name), depth + 1);
            }
        }
    };
    const listed = async (dir: string): Promise<void> => {
        // allow(silent-catch): a rules folder that is absent or unreadable lists none.
        const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isFile() && /\.(md|mdc)$/u.test(entry.name)) {
                found.push(join(entry.parentPath, entry.name));
            }
        }
    };
    await walk(root, 0);
    await Promise.all(RULE_DIRS.map((dir) => listed(join(root, dir))));
    return found;
};

// Why the rules Cursor would load hold personal data, naming the files, or undefined when none does (or the shield only
// watches). `root` is the turn's folder as this process reaches it: for an anchored turn, its namespace's view.
export const instructionRefusal = async (shield: TurnShield, root: string, label: string): Promise<string | undefined> => {
    const holding: string[] = [];
    const kinds = new Set<PersonalDataClass>();
    for (const file of await ruleFilesUnder(root)) {
        // allow(silent-catch): a file that cannot be read measures as empty and is skipped, as Cursor could not load it.
        const size = await stat(file).then((info) => info.size).catch(() => 0);
        if (size === 0 || size > MAX_RULE_BYTES) {
            continue;
        }
        // allow(silent-catch): read as empty, as above: nothing Cursor could load from it.
        const text = await readFile(file, "utf8").catch(() => "");
        const found = await shield.refuses(text, "instructions", `the turn was refused: ${relative(root, file)}, which ${label} loads itself, holds personal data`);
        if (found.length > 0) {
            holding.push(relative(root, file));
            for (const kind of found) {
                kinds.add(kind);
            }
        }
    }
    if (holding.length === 0) {
        return undefined;
    }
    return [
        `The privacy shield did not send this to ${label}: ${holding.join(", ")} hold${holding.length === 1 ? "s" : ""} personal data (${kindsSaid([...kinds])}).`,
        `${label} reads ${holding.length === 1 ? "that file" : "those files"} itself and sends ${holding.length === 1 ? "it" : "them"} to its own servers, so the shield can't mask ${holding.length === 1 ? "it" : "them"} on the way; everything else in this conversation it can.`,
        `Let ${label} read this conversation as it is, trust it in Sandbox ▸ Agent ▸ Safety, or take the personal data out of ${holding.length === 1 ? "that file" : "those files"}.`,
    ].join(" ");
};

// Tokens in what the transcript shows read back to their values: Cursor's model writes the tokens it was given, and the
// owner reads the real values, as the gateway restores a covered runtime's answers. Streamed text holds back a tail
// that may be the start of a token (holdback.ts), one stream per author: the turn's own prose and thinking, and each
// subagent's. Anything else is restored whole, after the streams before it have let go of what they held.
export interface EventRestorer {
    readonly map: (event: AgentEvent) => AgentEvent[];
    // What the streams still hold, as the phase ends.
    readonly flush: () => AgentEvent[];
}

export const createEventRestorer = (restore: (text: string) => string): EventRestorer => {
    const streams = new Map<string, { readonly kind: "delta" | "thinking"; readonly parent: string | undefined; readonly holdback: Holdback }>();
    const flush = (): AgentEvent[] => {
        const out: AgentEvent[] = [];
        for (const { kind, parent, holdback } of streams.values()) {
            const rest = holdback.flush();
            if (rest !== "") {
                out.push(parent === undefined ? { kind, text: rest } : { kind, text: rest, parentToolUseId: parent });
            }
        }
        streams.clear();
        return out;
    };
    return {
        map: (event) => {
            if (event.kind === "delta" || event.kind === "thinking") {
                const parent = event.parentToolUseId;
                const key = `${event.kind}\0${parent ?? ""}`;
                let stream = streams.get(key);
                if (stream === undefined) {
                    stream = { kind: event.kind, parent, holdback: createHoldback(restore) };
                    streams.set(key, stream);
                }
                const text = stream.holdback.push(event.text);
                return text === "" ? [] : [{ ...event, text }];
            }
            return [...flush(), restoreStrings(event as unknown as Json, restore) as unknown as AgentEvent];
        },
        flush,
    };
};

// A result the daemon's own tools hand Cursor, as the model may read it: every string masked, and a picture (which
// nothing here reads) replaced by a note while the shield masks.
const WITHHELD_PICTURE = "[A picture was withheld by the privacy shield: it could not be checked for personal data on this machine.]";
const maskResult = async (result: SDKCustomToolResult, shield: TurnShield, masking: boolean): Promise<SDKCustomToolResult> => {
    const walk = async (value: SDKJsonValue, key?: string): Promise<SDKJsonValue> => {
        if (typeof value === "string") {
            return key === "type" || key === "mimeType" || value === "" ? value : shield.mask(value, "tool");
        }
        if (Array.isArray(value)) {
            return Promise.all(value.map(async (item) => walk(item)));
        }
        if (value !== null && typeof value === "object") {
            if (masking && value["type"] === "image") {
                return { type: "text", text: WITHHELD_PICTURE };
            }
            const entries = await Promise.all(Object.entries(value).map(async ([field, item]) => [field, await walk(item, field)] as const));
            return Object.fromEntries(entries);
        }
        return value;
    };
    return (await walk(result as SDKJsonValue)) as SDKCustomToolResult;
};

// The daemon's own tools on a turn the shield reads: tokens in what the model passes read back before the tool runs (a
// question shown to the owner, a script, a child's brief), and what the tool answers masked before the model reads it.
export const shieldedCustomTools = (tools: Record<string, SDKCustomTool>, shield: TurnShield): Record<string, SDKCustomTool> =>
    Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [
            name,
            {
                ...tool,
                execute: async (args, context) => {
                    const restored = restoreStrings(args as Json, shield.restore) as Record<string, SDKJsonValue>;
                    return maskResult(await tool.execute(restored, context), shield, await shield.masking());
                },
            } satisfies SDKCustomTool,
        ]),
    );
