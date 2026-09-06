/* "Import memory from other AI providers": the user runs IMPORT_PROMPT in their old assistant, pastes the
 * exported markdown back, and we merge it into the workspace's per-agent memory files. Cross-agentic. Claude
 * reads /work/CLAUDE.md (settingSources project memory), Codex/GPT reads /work/AGENTS.md (its working-dir doc);
 * both live at the workspace root, so the same block goes into each. Pure module (no Vue) so mergeMemory is
 * unit-tested directly; the dialog does the daemon I/O via useWorkspaceTree. */

// The two agents' native project-memory files at the workspace root. Both are written verbatim.
export const MEMORY_FILES = [`CLAUDE.md`, `AGENTS.md`] as const;

// Handed to the user to paste into their other AI assistant. Generic across providers (ChatGPT, Gemini, …);
// the fixed headings give the merged block a predictable shape without per-provider prompts.
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

// Replace the managed block if present, else append it, so re-importing overwrites rather than duplicates,
// and hand-written memory around the block is preserved.
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
