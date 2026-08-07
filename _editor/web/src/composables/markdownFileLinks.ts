import { FILE_REF, parseRef, resolveInTree, toWorkspacePath } from "./workspace/fileRefs";

/* File mentions inside rendered markdown become clickable, VS Code style: when the agent writes
 * `src/foo.ts:42` in its answer — as a markdown link, in backticks, or as bare prose — clicking it opens that
 * file in the Workspace main view at that line, shown as `foo.ts:42` (see linkLabel).
 *
 * Both halves of that — where the link goes and what it reads as — are decided HERE rather than asked of the
 * model. A path in an answer is written for a human: abbreviated once the area is established, in whatever
 * line notation the last tool used. Prompting for a stricter form would spend context on every turn, bind the
 * result to one provider, and still leave every transcript already written broken. So the reference is matched
 * back onto the real file (resolveInTree, then the daemon on click) and displayed by its filename.
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

/* A LINK THAT POINTS BACK AT US, written out in full — `https://localhost:47145/workspace/docs/plan.md`.
 *
 * Models write these. Given any glimpse of the app's own address they will reach for the complete URL rather
 * than the path, and read literally it is an EXTERNAL link: it opened a second browser tab, reloaded the whole
 * app in it, dropped the line number the fragment carried, and — because a full URL carries no conversation —
 * landed on the shared tree's version of a file that may only exist in the agent's own. Every one of this
 * module's rules was skipped, for a link that was pointing at this very view.
 *
 * So a same-origin `/workspace/…` address is unwrapped back into the reference it is. Same-origin only, and
 * only that one route: any other host is genuinely somebody else's, and guessing more broadly would hijack
 * links this app has no business intercepting. */
const WORKSPACE_ROUTE = `/workspace/`;
const ownWorkspaceRef = (href: string): string | undefined => {
    const url = URL.parse(href, window.location.href);
    if (url === null || url.origin !== window.location.origin || !url.pathname.startsWith(WORKSPACE_ROUTE)) {
        return undefined;
    }
    // The route's own splat is percent-encoded per segment (workspaceHref), and a line can ride as `#L12`.
    const path = decodeURIComponent(url.pathname.slice(WORKSPACE_ROUTE.length));
    return path === `` ? undefined : `${path}${url.hash}`;
};

/* The workspace route for a file (`/workspace/src/foo.ts` — see router/index.ts). A real, shareable URL rather
 * than a dead `href="#"`, so the link keeps every gesture an anchor normally has: middle-click and ⌘-click open
 * the file in a new browser tab, "Copy link address" yields something that works, and the status bar shows
 * where the click leads.
 *
 * `?agent=` rides along when the prose belongs to an isolated conversation, because a path alone is only half
 * an address (see workspaceScope): opened in a new tab without it, the link would quietly show the shared
 * tree's file instead of the one the agent was describing. */
const workspaceHref = (path: string, agent: string | undefined): string => {
    const route = `/workspace/${path.split(`/`).map(encodeURIComponent).join(`/`)}`;
    return agent === undefined ? route : `${route}?agent=${encodeURIComponent(agent)}`;
};

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

/* The workspace-relative file a reference names, or undefined when it points outside the workspace (a
 * /usr/lib/… stack frame). An absolute path is already anchored at the container root, so only a relative one
 * is resolved against the document.
 *
 * The result is then matched against the workspace tree, because a path the model wrote is often only the tail
 * of the real one (`pages/workspace/Foo.vue` for a file under `_editor/web/src`). A reference the client's copy
 * of the tree can't place is marked up as written and matched again — daemon-side, against the full sweep —
 * when it is actually clicked (openWorkspaceRef), so a link is never withheld waiting on a request. */
const linkTarget = (rawPath: string, dir: string | undefined): string | undefined => {
    const target = toWorkspacePath(rawPath);
    if (target === undefined || rawPath.startsWith(`/`)) {
        return target;
    }
    const named = resolveIn(dir, target);
    return resolveInTree(named) ?? named;
};

/* What a scanned reference READS as once it is a link: the filename and, where one was given, the line —
 * `WorkspaceDesktop.vue:640` for a path six directories deep, in whichever notation it arrived in.
 *
 * The path a model writes is addressing, not prose: a sentence broken by forty characters of directory is
 * harder to read, and the part that identifies the file is the tail. Nothing is lost by dropping the rest —
 * the full path is the href, the tooltip, and the tab that opens. Deliberately NOT applied to a link markdown
 * itself authored (`[the config](src/foo.ts)`), whose text is the author's own words.
 *
 * The alternative was to ask the agent to write short labels and full targets, the way IDE surfaces do. This
 * needs nothing of the model at all, works on transcripts already written, and holds for every provider. */
const linkLabel = (rawPath: string, line: number | undefined): string => {
    const name = rawPath.slice(rawPath.lastIndexOf(`/`) + 1);
    return line === undefined ? name : `${name}:${line}`;
};

// Turn an anchor into a workspace file link. The line rides in a data attribute rather than the URL because the
// route has nowhere to put it; a plain click reads it back, a new-tab click loses it and lands on line 1. The
// scope does NOT ride a data attribute — it is in the href, which is what makes a new-tab click land in the
// right tree instead of on the shared one's namesake.
const markFileLink = (anchor: HTMLAnchorElement, path: string, line: number | undefined, agent: string | undefined): void => {
    anchor.classList.add(`md-file-link`);
    anchor.setAttribute(`href`, workspaceHref(path, agent));
    anchor.dataset[`file`] = path;
    if (line !== undefined) {
        anchor.dataset[`line`] = String(line);
    }
    if (agent !== undefined) {
        anchor.dataset[`agent`] = agent;
    }
    // The link text can be prose (`[the config](src/foo.ts)`), so name the destination on hover.
    anchor.title = line === undefined ? path : `${path}:${line}`;
};

/* An anchor markdown itself produced. A relative target is a file reference — a model reaching for the
 * `[label](path#L42)` form IDE surfaces ask for lands here — and left alone it would be a browser navigation
 * to a URL this app has no route for. An outbound one is sent to its own tab: the chat's state IS the
 * conversation, and following a link in place tears the running session's view down. */
const linkifyAnchor = (anchor: HTMLAnchorElement, dir: string | undefined, agent: string | undefined): void => {
    const href = anchor.getAttribute(`href`);
    if (href === null || href === `` || href.startsWith(`#`)) {
        return;
    }
    // Our own address written out in full is a file reference, not an outbound link — checked BEFORE the
    // external test, which is what used to claim it (see ownWorkspaceRef).
    const own = EXTERNAL.test(href) ? ownWorkspaceRef(href) : undefined;
    if (own === undefined && EXTERNAL.test(href)) {
        anchor.setAttribute(`target`, `_blank`);
        anchor.setAttribute(`rel`, `noopener noreferrer`);
        return;
    }
    const { path, line } = parseRef(own ?? href);
    const target = linkTarget(path, dir);
    if (target === undefined) {
        return;
    }
    markFileLink(anchor, target, line, agent);
};

// Split one text node around every file reference in it. Untouched — and so left as the single original node —
// when it holds no reference that maps into the workspace.
const linkifyText = (node: Text, dir: string | undefined, agent: string | undefined): void => {
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
        anchor.textContent = linkLabel(path, line);
        markFileLink(anchor, target, line, agent);
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
 * names files from the workspace root. `agent` is whose copy of the workspace the prose is about
 * (workspaceScope), undefined for the shared tree.
 *
 * Text inside an <a> is skipped — that anchor already owns its target — and so is text inside a <pre>, which at
 * this point is the empty placeholder markdown/code.ts substitutes a real, separately-styled code block into later.
 * Inline <code> IS scanned: `src/foo.ts` in backticks is the form agents reach for most. */
export const linkifyFileRefs = (fragment: DocumentFragment, dir: string | undefined, agent: string | undefined): void => {
    fragment.querySelectorAll(`a`).forEach((anchor) => linkifyAnchor(anchor, dir, agent));
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
    texts.forEach((text) => linkifyText(text, dir, agent));
};
