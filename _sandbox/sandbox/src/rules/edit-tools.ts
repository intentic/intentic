/* THE TOOLS THAT WRITE A FILE, as one matcher and one reader, shared by every hook set that listens for an edit. */
export const EDIT_TOOL_NAMES = ["Edit", "Write", "NotebookEdit", "mcp__hashline__edit", "mcp__hashline__write"] as const;

// The same list as a hook matcher; readers deciding per tool name (the permission gate's plan posture) take the names.
export const EDIT_TOOLS = EDIT_TOOL_NAMES.join("|");

// The native tools name it `file_path`, NotebookEdit `notebook_path`, the hashline ones `path`. One reader over
// all of them, because which spelling arrives is a setting the owner flipped and not a fact about the edit.
export const editedPath = (input: unknown): string | undefined => {
    const named = input as { file_path?: unknown; notebook_path?: unknown; path?: unknown };
    const path = typeof named.file_path === "string" ? named.file_path : typeof named.notebook_path === "string" ? named.notebook_path : named.path;
    return typeof path === "string" && path !== "" ? path : undefined;
};
