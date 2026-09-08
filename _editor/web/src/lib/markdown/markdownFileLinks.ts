import { FILE_REF, parseRef, resolveInTree, toWorkspacePath } from "../../features/workspace/files/fileRefs";

// File mentions in rendered markdown become clickable: a path is matched against the workspace tree and shown by
// filename. Runs on the sanitized DOM, not the source or an HTML string, via a text-node walk, since a regex cannot
// distinguish text from markup; the click lives in openFileRef.

// Global twin of the shared grammar; a text node is scanned for every match, unlike xterm's single-match need.
const FILE_REF_ALL = new RegExp(FILE_REF.source, `g`);

// Leaves the app: any scheme (http:, mailto:, vscode:) or protocol-relative `//host`; else it's a path.
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// A same-origin `/workspace/...` link written out in full is unwrapped back into its reference; any other host or
// route is left alone, since guessing more broadly would hijack links this app has no business intercepting.
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

// The workspace route for a file (`/workspace/src/foo.ts`), a real URL so middle-click, copy-link and the status bar
// work. `?agent=` rides along for an isolated conversation, since a bare path can't tell that tree from the shared one.
const workspaceHref = (path: string, agent: string | undefined): string => {
    const route = `/workspace/${path.split(`/`).map(encodeURIComponent).join(`/`)}`;
    return agent === undefined ? route : `${route}?agent=${encodeURIComponent(agent)}`;
};

// Resolves a relative reference against the document's directory, markdown's own rule (`docs/a.md` linking `./b.md`
// means `docs/b.md`). `dir` is empty at root, undefined for agent/tool output (workspace-root-relative).
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

// The workspace-relative file a reference names, or undefined outside the workspace; matched against the tree since
// a model's path is often only the tail. An unmatched reference keeps its literal form, resolved daemon-side on click.
const linkTarget = (rawPath: string, dir: string | undefined): string | undefined => {
    const target = toWorkspacePath(rawPath);
    if (target === undefined || rawPath.startsWith(`/`)) {
        return target;
    }
    const named = resolveIn(dir, target);
    return resolveInTree(named) ?? named;
};

// What a scanned reference reads as once linked: `name.ext:line`, since the path identifies by tail, not full text.
// Never applied to a link markdown itself authored, whose text is the author's own words.
const linkLabel = (rawPath: string, line: number | undefined): string => {
    const name = rawPath.slice(rawPath.lastIndexOf(`/`) + 1);
    return line === undefined ? name : `${name}:${line}`;
};

// Turn an anchor into a workspace file link. The line rides in a data attribute, read by an in-page click, since a
// new tab would otherwise land on line 1; the agent scope rides in the href, so a new tab still opens the right tree.
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

// An anchor markdown itself produced. A relative target resolves as a file reference (`[label](path#L42)`); an
// outbound one opens its own tab instead, since navigating in place would tear down the chat's running view.
const linkifyAnchor = (anchor: HTMLAnchorElement, dir: string | undefined, agent: string | undefined): void => {
    const href = anchor.getAttribute(`href`);
    if (href === null || href === `` || href.startsWith(`#`)) {
        return;
    }
    // Checked before the external test, since a self-referencing full URL would otherwise be treated as external.
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

// Splits one text node around every file reference in it; left untouched as the original node when nothing maps
// into the workspace.
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
            // A path outside the workspace stays plain text.
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

// Linkify every reference in a sanitized fragment, in place; `dir` resolves relative refs, `agent` scopes the
// workspace copy. Skips <a> (already targeted) and <pre> (still the code placeholder); inline <code> is scanned.
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
