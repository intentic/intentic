import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";
import { FILE_REF, parseRef, toWorkspacePath } from "../workspace/files/fileRefs";
import { openWorkspaceRef } from "../workspace/files/openFileRef";

/* Ctrl/Cmd+click a file reference in terminal output → open it in the workspace editor at the referenced line. */

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
