import { posix, win32 } from "node:path";
import { z } from "zod";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@intentic/sandbox-contract/events/requests";
import { deviceSpelledName, displayNameOf, mcpServerOf, toolCategoryOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { opt } from "./opt.js";

// The tool card every runtime builds the same way, and what it is built from: a call's bounded input, its own words,
// the files it names and a diff's two sides. Shared by the daemon's runtimes and a computer's turns, so one call reads
// the same on a card wherever its agent ran.

// How a path an agent names becomes one relative to where its turn runs; undefined for one the caller cannot address.
export type PathReading = (raw: string, cwd: string) => string | undefined;

// A folder as Windows names one: a drive (`C:\`, `C:/`) or a share (`\\server\share`, `\\wsl.localhost\distro`).
const WINDOWS_FOLDER = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

/**
 * A path the agent named, relative to the turn's folder and forward-slashed; undefined when it lies outside that folder
 * (or is the folder itself). A relative input is already relative to it. The separators read are the folder's own, not
 * this machine's: a Windows folder reads `\` and drive letters as Windows does, any other is POSIX, so a harness inside
 * a WSL distro is read correctly by a process on the Windows side.
 */
export const pathUnder: PathReading = (raw, cwd) => {
    const windows = WINDOWS_FOLDER.test(cwd);
    const path = windows ? win32 : posix;
    const relative = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw;
    const slashed = windows ? relative.replaceAll("\\", "/") : relative;
    // Another drive leaves an absolute path behind: outside the folder, like any `..`.
    if (slashed === "" || slashed === "." || slashed === ".." || slashed.startsWith("../") || path.isAbsolute(relative)) {
        return undefined;
    }
    return slashed;
};

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path"] as const;

// A call's input, read for the one file it names and where in it (Read's 1-based `offset`). The input is the loop's own
// (`ToolCardCall.input`): any shape, parsed here for the few keys a card reads.
const LocatedInputSchema = z.record(z.string(), z.unknown());

// The files a tool call touches under the turn's folder, for clickable cards and live-writes; `line` comes from Read's
// 1-based `offset`. Undefined when the input names no file the caller can address.
export const toolLocations = (input: ToolCardCall["input"], cwd: string, pathOf: PathReading = pathUnder): ToolCallLocation[] | undefined => {
    const record = LocatedInputSchema.safeParse(input).data;
    if (record === undefined) {
        return undefined;
    }
    for (const key of PATH_KEYS) {
        const value = z.string().safeParse(record[key]).data;
        if (value === undefined) {
            continue;
        }
        const path = pathOf(value, cwd);
        if (path === undefined) {
            return undefined;
        }
        const offset = z.number().positive().safeParse(record["offset"]).data;
        return [{ path, ...opt("line", offset) }];
    }
    return undefined;
};

// Caps one side of a diff so a giant Write can't flood the event stream.
const DIFF_SIDE_CAP = 32_000;
const capSide = (text: string): { text: string; clipped: boolean } =>
    text.length > DIFF_SIDE_CAP ? { text: text.slice(0, DIFF_SIDE_CAP), clipped: true } : { text, clipped: false };

// The one constructor every diff on the wire goes through, whether derived from an Edit/Write input or arriving
// ready-made from an ACP agent.
export const diffContent = (path: string, oldText: string | undefined, newText: string): ToolCallContent => {
    const oldCapped = oldText === undefined ? undefined : capSide(oldText);
    const newCapped = capSide(newText);
    return {
        type: "diff",
        path,
        ...opt("oldText", oldCapped?.text),
        newText: newCapped.text,
        ...opt("truncated", oldCapped?.clipped === true || newCapped.clipped ? true : undefined),
    };
};

// Ceiling on the input a card keeps, in characters: enough for a delegation's prompt or an MCP call's arguments to say
// what was asked, without a call that carried a whole file doubling the record's size.
export const TOOL_INPUT_CHARS = 4_000;

// Ceiling on a call's own description, in characters: a sentence, not a second prompt.
const TOOL_DESCRIPTION_CHARS = 300;

// The agent's own words for a call that has a target (Bash's `description`: "Show working tree status"), which the
// card says beside the command. A call with no target keeps its whole input instead (toolInput), words and all.
const DescribedInputSchema = z.object({ description: z.string().trim().min(1) });

export const toolDescription = (call: { readonly input?: unknown }, target: string | undefined): string | undefined => {
    const parsed = target === undefined ? undefined : DescribedInputSchema.safeParse(call.input).data;
    const words = parsed?.description;
    return words === undefined || words.length <= TOOL_DESCRIPTION_CHARS ? words : `${words.slice(0, TOOL_DESCRIPTION_CHARS)}…`;
};

// What a call was given, as JSON text cut at TOOL_INPUT_CHARS, for a card with no one-line `target` (an MCP tool, the
// Agent/Task tool), which otherwise records nothing of what was asked. A call with a target keeps only that, as it
// always has; an empty or unserializable input is no input.
export const toolInput = (input: ToolCardCall["input"], target: string | undefined): string | undefined => {
    if (target !== undefined || input === undefined || input === null) {
        return undefined;
    }
    let json: string | undefined;
    try {
        json = JSON.stringify(input);
    } catch {
        // allow(silent-catch): a cyclic or BigInt-bearing input is one the card cannot carry, not a failed call.
        return undefined;
    }
    if (json === undefined || json === "{}" || json === "[]") {
        return undefined;
    }
    return json.length > TOOL_INPUT_CHARS ? `${json.slice(0, TOOL_INPUT_CHARS)}…` : json;
};

// A tool call's opening frame: the shared taxonomy's category unless the vendor names one, and running unless it says.
// `parentToolUseId` is the call that started the subagent making this one, which nests it under that call's card.
export const toolCallOpened = (call: {
    readonly id: string;
    readonly name: string;
    readonly category?: ToolKind;
    readonly status?: ToolCallStatus;
    readonly target?: string | undefined;
    readonly locations?: ToolCallLocation[] | undefined;
    readonly content?: ToolCallContent[] | undefined;
    // The call's input as bounded JSON text, for a call with no target (`toolInput`).
    readonly input?: string | undefined;
    // The agent's own words for a call that has a target (`toolDescription`).
    readonly description?: string | undefined;
    // The MCP server the call went to, which the display name drops (agent-context mcpServerOf).
    readonly server?: string | undefined;
    readonly parentToolUseId?: string | undefined;
}): Extract<AgentEvent, { kind: "tool_call" }> => ({
    kind: "tool_call",
    id: call.id,
    name: call.name,
    category: call.category ?? toolCategoryOf(call.name),
    status: call.status ?? "in_progress",
    ...opt("target", call.target),
    ...opt("locations", call.locations),
    ...opt("content", call.content),
    ...opt("input", call.input),
    ...opt("description", call.description),
    ...opt("server", call.server),
    ...opt("parentToolUseId", call.parentToolUseId),
});

// What a loop said of one call, as `toolCard` takes it.
export interface ToolCardCall {
    readonly id: string;
    readonly name: string;
    // The call's arguments as the loop handed them, before any reading of them.
    readonly input?: unknown;
    // Where the loop ran, against which the files it names are read; absent names none.
    readonly cwd?: string | undefined;
    // How a file the input names is read against `cwd`; `pathUnder` unless the caller has places of its own.
    readonly pathOf?: PathReading | undefined;
    readonly category?: ToolKind;
    readonly status?: ToolCallStatus;
    readonly target?: string | undefined;
    readonly locations?: ToolCallLocation[] | undefined;
    readonly content?: ToolCallContent[] | undefined;
    readonly parentToolUseId?: string | undefined;
}

/**
 * A tool call's card from what the loop said of it, built one way for every mapper: shown under the shared display name
 * and categorized by the canonical one (`mcp__browser__browser_navigate` is a fetch whatever a loop prints for it), its
 * target, the files it names, and, where no one-line target says what it does, its own arguments (a browser call's
 * `account` among them). `name` is the canonical name, or the loop's own where it has no other; a vendor's own words
 * for any part win.
 */
export const toolCard = (call: ToolCardCall): Extract<AgentEvent, { kind: "tool_call" }> => {
    const target = call.target ?? toolTarget(call.input);
    // A devices call reads under the computer it went to (agent-context deviceSpelledName).
    const spelled = deviceSpelledName(call.name, call.input);
    const name = displayNameOf(spelled);
    // A loop's own spelling the taxonomy does not know (OpenCode's `shell`) is read by the name it is shown under.
    const category = toolCategoryOf(call.name);
    return toolCallOpened({
        id: call.id,
        name,
        category: call.category ?? (category === "other" ? toolCategoryOf(name) : category),
        ...opt("status", call.status),
        target,
        locations: call.locations ?? (call.cwd === undefined ? undefined : toolLocations(call.input, call.cwd, call.pathOf ?? pathUnder)),
        content: call.content,
        input: toolInput(call.input, target),
        description: toolDescription(call, target),
        server: mcpServerOf(spelled),
        parentToolUseId: call.parentToolUseId,
    });
};
