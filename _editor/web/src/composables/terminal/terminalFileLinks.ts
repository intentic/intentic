import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";
import { FILE_REF, parseRef, toWorkspacePath } from "../workspace/fileRefs";
import { openWorkspaceRef } from "../workspace/openFileRef";

/* Ctrl/Cmd+click a file reference in terminal output → open it in the workspace editor at the referenced line.
 * Reuses xterm's own WebLinksAddon (its wrapped-line link device) by handing it a file-path regex instead of
 * the default URL one, so the gesture and hover-underline match the web links we already register, only the
 * activate handler differs. The value here is the integrated editor: a tsc/eslint/vitest error or a node stack
 * trace becomes click-to-open. The reference grammar and the navigation are shared with the chat's markdown
 * links (see fileRefs / openFileRef), so a path opens the same file wherever it is clicked. */

// Ctrl/Cmd-gated to match the web-link gesture: a plain click stays a selection/tmux gesture (the session's drag
// gate owns it), so only a modifier click reaches this as a trusted activation.
const openFileRef = (event: MouseEvent, ref: string): void => {
    if (!event.ctrlKey && !event.metaKey) {
        return;
    }
    const { path, line } = parseRef(ref);
    const target = toWorkspacePath(path);
    if (target === undefined) {
        return;
    }
    void openWorkspaceRef(target, line);
};

export const registerFilePathLinks = (term: Terminal): void => {
    term.loadAddon(new WebLinksAddon(openFileRef, { urlRegex: FILE_REF }));
};
