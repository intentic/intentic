// Merges memory exported from another AI assistant into the workspace's memory file (MEMORY_FILE at the workspace
// root), which the daemon composes into every turn's instructions whatever runtime serves it. Pure module so
// mergeMemory is unit-tested directly; the card handles daemon I/O via useWorkspaceTree.

// Pasted into the user's other AI assistant; fixed headings keep the merged block's shape provider-agnostic.
export const IMPORT_PROMPT = `Export everything you know about me from our past conversations so I can bring it to another AI assistant.

Preserve my wording verbatim where possible, especially for instructions and preferences. Write it as Markdown under these headings, in this order, and skip any that would be empty:

## About me
## Preferences & working style
## Standing instructions
## Projects & context
## Tools, stack & environment
## Other useful context

Output only the Markdown: no preamble or closing remarks.`;

// HTML-comment fences so the block is invisible in rendered markdown yet locatable for replace-on-reimport.
const START = `<!-- intentic:imported-memory:start -->`;
const END = `<!-- intentic:imported-memory:end -->`;

// Replaces the managed block if present, else appends it: re-importing overwrites instead of duplicating, and memory
// outside the block is preserved.
export const mergeMemory = (existing: string, imported: string): string => {
    const block = `${START}\n## Imported memory\n\n${imported.trim()}\n${END}`;
    const start = existing.indexOf(START);
    if (start === -1) {
        return existing.trim() === `` ? `${block}\n` : `${existing.trimEnd()}\n\n${block}\n`;
    }
    const endIdx = existing.indexOf(END);
    // Tolerate a corrupted (unterminated) block: replace from the start marker to end of file.
    const end = endIdx === -1 ? existing.length : endIdx + END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
};
