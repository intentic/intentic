import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { PUBLIC_DIR } from "@intentic/workspace-ignore";
import type { Refusal } from "../panels/interstitial.js";
import { escapeHtml } from "../panels/interstitial.js";

/* THE OUTBOX'S RULES — what a request for a published file resolves to, and what the /public route lists.
 *
 * Everything under the workspace's `public/` directory is served to anyone who has the URL, with no auth in
 * front of it (public-serve.ts). The directory's existence is the user's decision to publish; these rules are
 * the part that has to hold even when a file landed there by accident, because the write path cannot be
 * trusted — a `cp -r` from an agent that misread a task writes files just as effectively as the user does.
 * So every guard below runs at SERVE time against the bytes on disk, not once at the moment something was
 * copied in: the same file can be safe on Monday and a credential dump on Tuesday.
 *
 * The guards, in the order a request meets them:
 *   1. Containment, through realpath. A symlink is the one way a path inside `public/` addresses bytes outside
 *      it (`ln -s ~/.aws/credentials public/x`), so the resolved REAL path is re-checked against the real root.
 *   2. Hidden segments. Any path component starting with "." is refused, which retires `.env`, `.git`, `.ssh`
 *      and `.npmrc` in one rule rather than a list that has to keep up.
 *   3. Credential-shaped names — the high-RECALL half: `*.pem`, `*.key`, `id_rsa`, `credentials`. Cheap, and it
 *      catches the files whose whole content is a secret.
 *   4. No directory listing, ever. A directory serves its `index.html` (the static-site case is the point) or
 *      nothing. Without a listing, an outsider needs the 12-hex hostname slot AND the filename to reach
 *      anything, which is the difference between "unguessable" and "one leaked link exposes the folder".
 *   5. A content sniff — the high-PRECISION half. Only patterns that are self-identifying (a PEM block, an AWS
 *      AKIA, a `ghp_`/`sk-`/`xox…` token) qualify. The tempting generic rule, `secret|token|password` followed
 *      by a long value, is deliberately absent: it fires on a Firebase config, on a form field, on any docs page
 *      that quotes a fake key, and a publisher whose legitimate page is refused for no visible reason learns to
 *      distrust the whole feature. Recall lives in rules 2 and 3, where a false positive costs a rename.
 *   6. A size ceiling. A backstop against a public URL becoming someone's CDN, not a policy about file types. */

// The outbox on disk. Absent by definition until the user publishes something — its existence IS the switch.
export const publicRoot = (workspaceRoot: string): string => join(workspaceRoot, PUBLIC_DIR);

// Beyond this a file is refused rather than streamed. Generous on purpose: a screen recording is a normal thing
// to hand someone, and this exists to stop a dev box quietly becoming a download mirror.
const MAX_BYTES = 512 * 1024 * 1024;

// Bounds on the listing walk (the /public route), not on serving: a published `dist/` is thousands of files and
// the view showing them is not where that has to be paginated.
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 8;

// Extension → what the browser is told, and whether it may render it inline. Everything absent from this map is
// served as an attachment: an unknown type is either a download (a .zip, a .tar.gz) or something whose renderer
// nobody has audited, and "download it" is the honest answer for both. The one type worth calling out is `.svg`,
// which is a document that can carry script — it is served with a CSP that leaves presentation intact and takes
// scripting away, because publishing a diagram must not also publish an execution context on the outbox origin.
const TYPES: Record<string, { readonly type: string; readonly inline: boolean }> = {
    ".html": { type: "text/html; charset=utf-8", inline: true },
    ".htm": { type: "text/html; charset=utf-8", inline: true },
    ".css": { type: "text/css; charset=utf-8", inline: true },
    ".js": { type: "text/javascript; charset=utf-8", inline: true },
    ".mjs": { type: "text/javascript; charset=utf-8", inline: true },
    ".json": { type: "application/json; charset=utf-8", inline: true },
    ".map": { type: "application/json; charset=utf-8", inline: true },
    ".txt": { type: "text/plain; charset=utf-8", inline: true },
    ".md": { type: "text/plain; charset=utf-8", inline: true },
    ".csv": { type: "text/csv; charset=utf-8", inline: true },
    ".xml": { type: "application/xml; charset=utf-8", inline: true },
    ".svg": { type: "image/svg+xml", inline: true },
    ".png": { type: "image/png", inline: true },
    ".jpg": { type: "image/jpeg", inline: true },
    ".jpeg": { type: "image/jpeg", inline: true },
    ".gif": { type: "image/gif", inline: true },
    ".webp": { type: "image/webp", inline: true },
    ".avif": { type: "image/avif", inline: true },
    ".ico": { type: "image/x-icon", inline: true },
    ".pdf": { type: "application/pdf", inline: true },
    ".mp4": { type: "video/mp4", inline: true },
    ".webm": { type: "video/webm", inline: true },
    ".mov": { type: "video/quicktime", inline: true },
    ".mp3": { type: "audio/mpeg", inline: true },
    ".wav": { type: "audio/wav", inline: true },
    ".ogg": { type: "audio/ogg", inline: true },
    ".woff": { type: "font/woff", inline: true },
    ".woff2": { type: "font/woff2", inline: true },
    ".wasm": { type: "application/wasm", inline: true },
};
const DOWNLOAD = { type: "application/octet-stream", inline: false } as const;

// Rule 3: names whose content is a credential by construction. Matched on the file name alone, case-insensitive.
const CREDENTIAL_NAMES = /^(?:id_[rd]sa|id_ecdsa|id_ed25519|credentials|\.?netrc|\.?htpasswd)$/i;
const CREDENTIAL_EXTS = new Set([".pem", ".key", ".p12", ".pfx", ".ppk", ".jks", ".keystore", ".kdbx", ".asc", ".gpg"]);

/* Rule 5: self-identifying secrets only — every pattern here names its own issuer, so a match is evidence
 * rather than a guess. Deliberately NOT a general `key = <long string>` rule; see the header.
 *
 * Exported because a conversation published as a page (src/share) has to be held to the SAME rule, and from
 * the other direction: a file is REFUSED for matching one of these, but a shared page is rewritten to remove
 * them. The two have to be one list — a share redacted against a shorter list would be a page the outbox then
 * refuses to serve, which reads to its owner as a broken feature rather than as a guard doing its job. */
export const SECRET_PATTERNS = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
];
// How much of a file the sniff reads. A credential dump announces itself in its first lines; reading further
// would turn every request into a full scan of a file we are about to stream anyway.
const SNIFF_BYTES = 8192;
// Which types are sniffed at all: a PNG cannot contain a PEM block in any sense that matters, and scanning
// binaries would only produce false positives on compressed bytes.
const sniffable = (type: string): boolean => type.startsWith("text/") || type.startsWith("application/json") || type.startsWith("application/xml");

// Why a file that IS in the outbox still isn't served. Reported per entry by the listing so the Public view can
// say so next to the file, instead of the user discovering it from a stranger's 404.
export type PublicBlock = "hidden" | "credential-name" | "credential-content" | "too-large" | "escapes";

export const BLOCK_REASON: Record<PublicBlock, string> = {
    hidden: "hidden files are never served",
    "credential-name": "the name says this is a credential",
    "credential-content": "the contents look like a credential",
    "too-large": "larger than the 512 MB ceiling",
    escapes: "a symlink pointing outside the folder",
};

// Rules 2 + 3, on a single path — the checks that need only the name, so the listing can apply them without
// opening anything.
export const blockByName = (relPath: string): PublicBlock | undefined => {
    const segments = relPath.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment.startsWith("."))) {
        return "hidden";
    }
    const name = segments[segments.length - 1] ?? "";
    return CREDENTIAL_NAMES.test(name) || CREDENTIAL_EXTS.has(extname(name).toLowerCase()) ? "credential-name" : undefined;
};

// Rule 5, on the bytes. Reads the head of the file, never the whole thing.
const blockByContent = async (absPath: string, contentType: string): Promise<PublicBlock | undefined> => {
    if (!sniffable(contentType)) {
        return undefined;
    }
    const handle = await open(absPath, "r").catch(() => undefined);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const buffer = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
        const head = buffer.subarray(0, bytesRead).toString("utf8");
        return SECRET_PATTERNS.some((pattern) => pattern.test(head)) ? "credential-content" : undefined;
    } finally {
        await handle.close();
    }
};

const contentTypeOf = (name: string): { readonly type: string; readonly inline: boolean } => TYPES[extname(name).toLowerCase()] ?? DOWNLOAD;

// What the outbox answers with: a file to stream, or a branded status page.
export type PublicResolution =
    | {
          readonly kind: "file";
          readonly absPath: string;
          readonly size: number;
          readonly mtimeMs: number;
          readonly type: string;
          readonly inline: boolean;
      }
    | ({ readonly kind: "refused" } & Refusal);

// Every refusal answers 404 with the same sentence, whatever the reason. A viewer is not owed the difference
// between "no such file" and "that one is a private key", and telling them would turn the outbox into an oracle
// for probing what the folder holds. The publisher gets the real reason — in the Public view, where it belongs.
const notFound = (): PublicResolution => ({
    kind: "refused",
    status: 404,
    title: "Nothing published here",
    message: "This address doesn't point at a published file.",
});

// The request path, minus query/fragment and percent-decoded. undefined for malformed encoding or an embedded
// NUL — both are only ever an attempt to confuse the path resolution below.
const requestPath = (url: string | undefined): string | undefined => {
    const raw = (url ?? "/").split("?")[0]?.split("#")[0] ?? "/";
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return undefined;
    }
    return decoded.includes("\0") ? undefined : decoded;
};

/* One request → what to serve. `root` is the outbox directory; it not existing is the ordinary "publishing is
 * off" state and answers exactly like a missing file. */
export const resolvePublicFile = async (root: string, url: string | undefined): Promise<PublicResolution> => {
    const requested = requestPath(url);
    if (requested === undefined) {
        return notFound();
    }
    // realpath the root once: with the workspace on a symlinked mount, comparing a real file path against a
    // symlinked root would fail containment for every legitimate request.
    const realRoot = await realpath(root).catch(() => undefined);
    if (realRoot === undefined) {
        return notFound();
    }
    const target = resolve(realRoot, `.${requested}`);
    if (target !== realRoot && !target.startsWith(realRoot + sep)) {
        return notFound();
    }
    const stats = await stat(target).catch(() => undefined);
    if (stats === undefined) {
        return notFound();
    }
    // A directory serves its index.html and nothing else — never a listing (rule 4).
    if (stats.isDirectory()) {
        return resolvePublicFile(root, `${requested.replace(/\/+$/, "")}/index.html`);
    }
    if (!stats.isFile()) {
        return notFound();
    }
    // Rule 1: the path is inside the root, but a symlink can still point its bytes elsewhere.
    const real = await realpath(target).catch(() => undefined);
    if (real === undefined || !real.startsWith(realRoot + sep)) {
        return notFound();
    }
    const relPath = relative(realRoot, target).split(sep).join("/");
    if (blockByName(relPath) !== undefined) {
        return notFound();
    }
    if (stats.size > MAX_BYTES) {
        return {
            kind: "refused",
            status: 413,
            title: "File too large",
            message: `"${escapeHtml(relPath)}" is larger than the 512 MB ceiling the sandbox publishes up to.`,
        };
    }
    const { type, inline } = contentTypeOf(relPath);
    if ((await blockByContent(real, type)) !== undefined) {
        return notFound();
    }
    return { kind: "file", absPath: real, size: stats.size, mtimeMs: stats.mtimeMs, type, inline };
};

// One published file, as the Public view lists it.
export interface PublicEntry {
    // Outbox-relative, forward-slash ("report.pdf", "site/index.html") — the path that rides the public URL.
    readonly path: string;
    readonly size: number;
    readonly modifiedAt: number;
    // Absent when the file is served. Present with the reason when a guard refuses it, so the publisher learns
    // it from their own screen rather than from a stranger reporting a 404.
    readonly blocked?: PublicBlock;
}

/* Everything in the outbox, with each file's verdict. Runs the same guards the serve path runs — including the
 * content sniff, which is why this is the honest answer to "what did I publish?" rather than a directory
 * listing with a different opinion. An absent outbox lists as empty: publishing is simply off. */
export const listPublicFiles = async (root: string): Promise<PublicEntry[]> => {
    const entries: PublicEntry[] = [];
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) {
            return;
        }
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const dirent of dirents) {
            if (entries.length >= MAX_ENTRIES) {
                return;
            }
            const path = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
            if (dirent.isDirectory()) {
                await walk(join(dir, dirent.name), path, depth + 1);
                continue;
            }
            const stats = await stat(join(dir, dirent.name)).catch(() => undefined);
            if (stats === undefined || !stats.isFile()) {
                continue;
            }
            const entry = { path, size: stats.size, modifiedAt: stats.mtimeMs };
            const blocked =
                blockByName(path) ??
                (stats.size > MAX_BYTES ? ("too-large" as const) : await blockByContent(join(dir, dirent.name), contentTypeOf(path).type));
            entries.push(blocked === undefined ? entry : { ...entry, blocked });
        }
    };
    await walk(root, "", 1);
    return entries.toSorted((left, right) => left.path.localeCompare(right.path));
};
