import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { displayNameOf, toolCategoryOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { opt } from "../../opt.js";
import { type CalledTool, editDiffContent, mayShowPicture, resultContent, toolInput, toolLocations } from "./tool-calls.js";

// A tool_use block that can be correlated to its result; real streams always carry an id and a name.
export interface ToolUseBlock {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
}

// A tool_result block correlated to its call: what the SDK answered, as it answered it (resultContent reads it).
export interface ToolAnswer {
    readonly id: string;
    readonly content: unknown;
    readonly failed: boolean;
}

type ToolCallFrame = Extract<AgentEvent, { kind: "tool_call" }>;
type ToolResultFrame = Extract<AgentEvent, { kind: "tool_call_update" }>;

// ONE CARD PER SDK CALL, WHICHEVER WAY THE CALL IS READ. The live stream (sdk-stream.ts) and a session read back from the
// provider's own store (sessions.ts) both turn a call and its result into frames here, and both hand those frames to the
// one fold (transcript-fold.ts), so a card drawn live and the same card read back are the same card: name, target,
// input, the call-time diff, and a picture its answer carried.
export class SdkCallFrames {
    // Calls whose call-time diff stands: a successful 'file updated' result is a redundant confirmation, an error replaces it.
    private readonly diffed = new Set<string>();
    // Calls whose answer can be a picture (mayShowPicture), read against their result.
    private readonly pictures = new Map<string, CalledTool>();

    constructor(
        // The turn's working dir, which paths in a call's input resolve against.
        private readonly cwd: string,
        // Where the browser tools write their pictures, for an answer that names one.
        private readonly browserOutputDir: string | undefined,
    ) {}

    call(block: ToolUseBlock, parent?: string): ToolCallFrame {
        const diff = editDiffContent(block.name, block.input, this.cwd);
        if (diff !== undefined) {
            this.diffed.add(block.id);
        }
        if (mayShowPicture(block.name)) {
            this.pictures.set(block.id, { name: block.name, input: block.input });
        }
        const target = toolTarget(block.input);
        return {
            kind: "tool_call",
            id: block.id,
            // Through the shared tool-name vocabulary, so an MCP browser tool never shows its raw `mcp__web__` name.
            name: displayNameOf(block.name),
            category: toolCategoryOf(block.name),
            // No result yet; a stored call that never got one is a turn interrupted mid-call, not a completed one.
            status: "in_progress",
            ...opt("target", target),
            // An MCP or Agent call has no target; its input is what the record would otherwise lose.
            ...opt("input", toolInput(block.input, target)),
            ...opt("locations", toolLocations(block.input, this.cwd)),
            ...opt("content", diff === undefined ? undefined : [diff]),
            ...opt("parentToolUseId", parent),
        };
    }

    result({ id, content, failed }: ToolAnswer): ToolResultFrame {
        const picture = failed ? undefined : this.pictures.get(id);
        const kept = this.diffed.has(id) && !failed;
        return {
            kind: "tool_call_update",
            id,
            status: failed ? "failed" : "completed",
            ...opt("content", kept ? undefined : resultContent(content, this.cwd, this.browserOutputDir, picture)),
        };
    }
}
