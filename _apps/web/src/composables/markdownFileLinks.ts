import { FILE_REF, parseRef, toWorkspacePath } from "./workspace/fileRefs";

/* File mentions inside rendered markdown become clickable, VS Code style: when the agent writes
 * `src/foo.ts:42` in its answer — as a markdown link, in backticks, or as bare prose — clicking it opens that
 * file in the Workspace main view at that line.
 *
 * This runs on the SANITIZED DOM (see renderMarkdown), not on the markdown source and not on an HTML string.
 * Rewriting a string with a regex would have to distinguish text from markup by hand — one path mentioned
 * inside an attribute value and the output is corrupt — whereas a text-node walk can only ever touch text.
 * Only the markup is produced here; the click that acts on it lives in openFileRef, which the prose surfaces
 * bind as one delegated listener (the anchors are injected via v-html, so they can hold no component).
 *
 * Sanitize-then-linkify also means the anchors we add are never re-inspected by DOMPurify, so `data-file` and
 * the rewritten href survive as written. Nothing untrusted rides along: the href is built from a path the
 * reference grammar already constrained, and the link text is set as a text node. */

// The global twin of the shared grammar — a text node is scanned for EVERY reference in it, while xterm's link
// addon wants a single-match regex. One pattern, two flag needs.
const FILE_REF_ALL = new RegExp(FILE_REF.source, `g`);

// An href that leaves the app: any scheme (http:, mailto:, vscode:) or a protocol-relative `//host`. Everything
// else is a path, and so a candidate file reference.
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// The workspace route for a file (`/workspace/src/foo.ts` — see router/index.ts). A real, shareable URL rather
// than a dead `href="#"`, so the link keeps every gesture an anchor normally has: middle-click and ⌘-click open
// the file in a new browser tab, "Copy link address" yields something that works, and the status bar shows
// where the click leads.
const workspaceHref = (path: string): string => `/workspace/${path.split(`/`).map(encodeURIComponent).join(`/`)}`;

/* Resolve a relative reference against the directory the document lives in — markdown's own rule, and the one
 * a doc tree depends on (`docs/a.md` linking `./b.md` means `docs/b.md`, not `b.md`). `dir` is empty for a
 * root-level document and undefined for agent and tool output, which names files from the workspace root. */
const resolveIn = (dir: string | undefined, path: string): string => {
    if (dir === undefined || dir === ``) {
        return path;
    }
    const segments = dir.split(`/`).filter((segment) => segment !== ``);
    for (const segment of path.split(`/`)) {
        if (segment === `` || segment === `.`) {
            continue;
        }
        if (segment === `..`) {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join(`/`);
};

// The workspace-relative file a reference names, or undefined when it points outside the workspace (a
// /usr/lib/… stack frame). An absolute path is already anchored at the container root, so only a relative one
// is resolved against the document.
const linkTarget = (rawPath: string, dir: string | undefined): string | undefined => {
    const target = toWorkspacePath(rawPath);
    if (target === undefined || rawPath.startsWith(`/`)) {
        return target;
    }
    return resolveIn(dir, target);
};

// Turn an anchor into a workspace file link. The line rides in a data attribute rather than the URL because the
// route has nowhere to put it; a plain click reads it back, a new-tab click loses it and lands on line 1.
const markFileLink = (anchor: HTMLAnchorElement, path: string, line: number | undefined): void => {
    anchor.classList.add(`md-file-link`);
    anchor.setAttribute(`href`, workspaceHref(path));
    anchor.dataset[`file`] = path;
    if (line !== undefined) {
        anchor.dataset[`line`] = String(line);
    }
    // The link text can be prose (`[the config](src/foo.ts)`), so name the destination on hover.
    anchor.title = line === undefined ? path : `${path}:${line}`;
};

/* An anchor markdown itself produced. A relative target is a file reference — that is the form the agent is
 * asked for, and left alone it would be a browser navigation to a URL this app has no route for. An outbound
 * one is sent to its own tab: the chat's state IS the conversation, and following a link in place tears the
 * running session's view down. */
const linkifyAnchor = (anchor: HTMLAnchorElement, dir: string | undefined): void => {
    const href = anchor.getAttribute(`href`);
    if (href === null || href === `` || href.startsWith(`#`)) {
        return;
    }
    if (EXTERNAL.test(href)) {
        anchor.setAttribute(`target`, `_blank`);
        anchor.setAttribute(`rel`, `noopener noreferrer`);
        return;
    }
    const { path, line } = parseRef(href);
    const target = linkTarget(path, dir);
    if (target === undefined) {
        return;
    }
    markFileLink(anchor, target, line);
};

// Split one text node around every file reference in it. Untouched — and so left as the single original node —
// when it holds no reference that maps into the workspace.
const linkifyText = (node: Text, dir: string | undefined): void => {
    const text = node.data;
    FILE_REF_ALL.lastIndex = 0;
    const parts = document.createDocumentFragment();
    // How much of `text` has been moved into `parts`; still 0 at the end means nothing matched.
    let taken = 0;
    for (let match = FILE_REF_ALL.exec(text); match !== null; match = FILE_REF_ALL.exec(text)) {
        const { path, line } = parseRef(match[0]);
        const target = linkTarget(path, dir);
        if (target === undefined) {
            // A path outside the workspace stays plain text, and the scan carries on to the next match.
            continue;
        }
        parts.append(text.slice(taken, match.index));
        const anchor = document.createElement(`a`);
        anchor.textContent = match[0];
        markFileLink(anchor, target, line);
        parts.append(anchor);
        taken = match.index + match[0].length;
    }
    if (taken === 0) {
        return;
    }
    parts.append(text.slice(taken));
    node.replaceWith(parts);
};

/* Linkify every file reference in a sanitized markdown fragment, in place. `dir` is the directory a relative
 * reference is resolved against — the previewed document's own, or undefined for agent and tool output, which
 * names files from the workspace root.
 *
 * Text inside an <a> is skipped — that anchor already owns its target — and so is text inside a <pre>, which at
 * this point is the empty placeholder markdownCode substitutes a real, separately-styled code block into later.
 * Inline <code> IS scanned: `src/foo.ts` in backticks is the form agents reach for most. */
export const linkifyFileRefs = (fragment: DocumentFragment, dir: string | undefined): void => {
    fragment.querySelectorAll(`a`).forEach((anchor) => linkifyAnchor(anchor, dir));
    // Collected before any rewriting: replacing a node mid-walk invalidates the walker's position.
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        // A text node sitting directly in the fragment (a bare top-level string) has no parent element at all.
        const parent = (node as Text).parentElement;
        if (parent === null || parent.closest(`a, pre`) === null) {
            texts.push(node as Text);
        }
    }
    texts.forEach((text) => linkifyText(text, dir));
};
