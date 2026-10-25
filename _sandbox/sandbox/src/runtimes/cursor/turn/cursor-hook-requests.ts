// The fields Cursor's hook payloads carry that the hooks read (cursor-hooks.ts), as they arrive: unparsed, each one
// narrowed where it is used.

// Only the three fields this reads are named; the payload carries more (model, generation_id, workspace roots) and none
// of it changes the verdict.
export interface GateRequest {
    readonly command?: unknown;
    readonly conversation_id?: unknown;
    readonly cwd?: unknown;
}

// Both hooks that answer from a turn's own state rather than from the rulebook; neither reads anything else it carries.
export interface TurnScopedRequest {
    readonly conversation_id?: unknown;
}

// The privacy shield's hooks, each with what the script adds from its side of a mount namespace.
export interface ReadRequest extends TurnScopedRequest {
    readonly file_path?: unknown;
    readonly content?: unknown;
    readonly image_base64?: unknown;
    readonly document_base64?: unknown;
    readonly opaque?: unknown;
}
export interface ToolRequest extends TurnScopedRequest {
    readonly tool_name?: unknown;
    readonly tool_input?: unknown;
    readonly existing_content?: unknown;
}
export interface ShellCommandRequest extends TurnScopedRequest {
    readonly id?: unknown;
}
export interface ShellOutputRequest extends TurnScopedRequest {
    readonly output?: unknown;
    readonly aimed?: unknown;
}
export interface McpRequest extends TurnScopedRequest {
    readonly tool_name?: unknown;
    readonly mcp_server_name?: unknown;
}
export interface EditedRequest extends TurnScopedRequest {
    readonly content?: unknown;
    readonly edits?: unknown;
}
