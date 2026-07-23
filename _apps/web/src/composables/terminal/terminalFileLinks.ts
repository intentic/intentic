import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";
import type { WorkspaceTreeResponse } from "@intentic-app/api-contract";
import { queryClient } from "../queryPersistence";
import { useWorkspaceTabs } from "../workspace/useWorkspaceTabs";
import { router } from "../../router";

/* Ctrl/Cmd+click a file reference in terminal output → open it in the workspace editor at the referenced line.
 * Reuses xterm's own WebLinksAddon (its wrapped-line link computer) by handing it a file-path regex instead of
 * the default URL one, so the gesture and hover-underline match the web links we already register — only the
 * activate handler differs. The value here is the integrated editor: a tsc/eslint/vitest error or a node stack
 * trace becomes click-to-open. Absolute paths (stack traces) are mapped back to the workspace-relative path the
 * editor speaks via the container root; relative paths (build-tool output run at the repo root) pass through. */

// A file reference: an optional /, ./, ../ or ~/ lead, one or more directory segments (so a bare word is never a
// link — a reference needs a slash), a filename with an extension, and an optional line[:col] or (line,col) tail
// (the forms tsc / eslint / vitest / node stack traces emit). The leading boundary lookbehind keeps the match
// from starting mid-token — e.g. inside a URL's `example.com/foo.ts` tail, which the URL addon already owns.
const FILE_LINK = /(?<![\w./:@-])(?:[~.]{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?|\(\d+,\d+\))?/;

// The container workspace root (e.g. /work), read from the cached workspace-tree response (the file explorer's
// query). Empty until the tree has been fetched once — until then an absolute reference simply isn't opened
// (relative ones still are). getQueriesData prefix-matches, so the sandbox-id suffix on the key doesn't matter.
const containerRoot = (): string => {
    for (const [, data] of queryClient.getQueriesData<WorkspaceTreeResponse>({ queryKey: [`workspace`, `tree`] })) {
        if (data?.root !== undefined && data.root !== ``) {
            return data.root;
        }
    }
    return ``;
};

// Git diff output prefixes each side of a file with a one-segment marker: `a/` `b/` by default, `i/` (index)
// `w/` (working tree) `c/` (commit) `o/` (object) under `diff.mnemonicPrefix`, and `1/` `2/` from
// `git diff --no-index`. A real workspace path effectively never starts with one of these bare single-char
// segments, so a copied `a/src/foo.ts` diff path should open the actual src/foo.ts (VS Code 1.130 parity — the
// prior code opened the literal a/… path and landed on the not-found state).
const DIFF_PREFIX = /^[abiwco12]\//;

// Split a matched reference into its path and 1-based line: `foo.ts:12:3` and `foo.ts(12,3)` both yield line 12.
export const parseRef = (ref: string): { readonly path: string; readonly line?: number } => {
    const colon = /^(.*?):(\d+)(?::\d+)?$/.exec(ref);
    if (colon?.[1] !== undefined) {
        return { path: colon[1], line: Number(colon[2]) };
    }
    const paren = /^(.*?)\((\d+),\d+\)$/.exec(ref);
    if (paren?.[1] !== undefined) {
        return { path: paren[1], line: Number(paren[2]) };
    }
    return { path: ref };
};

// Map a matched path to the root-relative path the editor opens, or undefined if it points outside the workspace
// (a system path like /usr/lib/…, or an absolute path under some other root the client can't map).
export const toWorkspacePath = (rawPath: string): string | undefined => {
    if (!rawPath.startsWith(`/`)) {
        // An explicit `./` lead is a tool-emitted relative path, never a diff side — strip only the `./`.
        // Anything else may carry a git-diff prefix (a/ b/ i/ w/ …), which is stripped to the real path.
        return rawPath.startsWith(`./`) ? rawPath.slice(2) : rawPath.replace(DIFF_PREFIX, ``);
    }
    const root = containerRoot();
    if (root === `` || !rawPath.startsWith(`${root}/`)) {
        return undefined;
    }
    return rawPath.slice(root.length + 1);
};

// Ctrl/Cmd-gated to match the web-link gesture: a plain click stays a selection/tmux gesture (the session's drag
// gate owns it), so only a modifier click reaches this as a trusted activation. A path that doesn't resolve on
// disk lands on the file viewer's not-found state rather than failing here.
const openFileRef = (event: MouseEvent, ref: string): void => {
    if (!event.ctrlKey && !event.metaKey) {
        return;
    }
    const { path, line } = parseRef(ref);
    const target = toWorkspacePath(path);
    if (target === undefined) {
        return;
    }
    const { openAtLine, openFile } = useWorkspaceTabs();
    if (line !== undefined) {
        openAtLine(target, line);
    } else {
        openFile(target);
    }
    // Surface the editor (no-op when already on the workspace route — its watchers' equality guards hold).
    void router.push({ name: `workspace`, params: { path: target.split(`/`) } });
};

export const registerFilePathLinks = (term: Terminal): void => {
    term.loadAddon(new WebLinksAddon(openFileRef, { urlRegex: FILE_LINK }));
};
