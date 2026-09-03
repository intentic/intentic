/* THE TOOLS THAT WRITE A FILE, as one matcher and one reader, shared by every hook set that listens for an
 * edit: the diagnostics after it (agent/agent-diagnostics.ts), the rules that run on it (file-edited.ts), and
 * the ledgers the Stop reads (turn-ending.ts).
 *
 * The hashline pair belongs here because turning `hashlineEdits` on DISABLES the native Edit and Write
 * (hashline/hashline-tools.ts): a matcher naming only those two goes quiet in exactly the configuration a user
 * chooses for heavy editing, so every listener below would have recorded nothing and said so confidently. */
export const EDIT_TOOLS = "Edit|Write|NotebookEdit|mcp__hashline__edit|mcp__hashline__write";

// The native tools name it `file_path`, NotebookEdit `notebook_path`, the hashline ones `path`. One reader over
// all of them, because which spelling arrives is a setting the owner flipped and not a fact about the edit.
export const editedPath = (input: unknown): string | undefined => {
    const named = input as { file_path?: unknown; notebook_path?: unknown; path?: unknown };
    const path = typeof named.file_path === "string" ? named.file_path : typeof named.notebook_path === "string" ? named.notebook_path : named.path;
    return typeof path === "string" && path !== "" ? path : undefined;
};
