import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { PUBLIC_DIR } from "@intentic/workspace-ignore";
import type { Refusal } from "../panels/interstitial.js";
import { escapeHtml } from "../panels/interstitial.js";

// Everything under public/ is served to anyone with the URL, no auth. Every guard runs at serve time against the bytes
// on disk, since the write path can't be trusted and a file safe today may not be tomorrow.
// 1. Containment: the resolved realpath is checked against the root, since a symlink can name bytes outside public/.
// 2. Hidden segments: any path component starting with "." is refused (.env, .git, .ssh, .npmrc).
// 3. Credential-shaped names (*.pem, *.key, id_rsa, credentials): high recall, catches files that are wholly a secret.
// 4. No directory listing, ever: a directory serves only its index.html.
// 5. Content sniff, high precision: only self-identifying patterns (PEM block, AWS key, gh_/sk-/xox token), never a
//    generic secret-near-a-value rule.
// 6. A size ceiling, so the outbox can't become someone's CDN.

// The outbox on disk; its existence is the publish switch, absent until the user publishes something.
export const publicRoot = (workspaceRoot: string): string => join(workspaceRoot, PUBLIC_DIR);

// Files past this are refused; generous, since this only stops the outbox becoming a download mirror.
const MAX_BYTES = 512 * 1024 * 1024;

// Bounds the listing walk, not serving; a published dist/ can be thousands of files.
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 8;

// Unlisted extensions download as attachments; `.svg` gets a CSP stripping script, since it can carry one.
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

// Rule 3: names that are a credential by construction, matched case-insensitively on the name alone.
const CREDENTIAL_NAMES = /^(?:id_[rd]sa|id_ecdsa|id_ed25519|credentials|\.?netrc|\.?htpasswd)$/i;
const CREDENTIAL_EXTS = new Set([".pem", ".key", ".p12", ".pfx", ".ppk", ".jks", ".keystore", ".kdbx", ".asc", ".gpg"]);

// Rule 5: self-identifying patterns only, each naming its own issuer. Exported so src/share redacts against this same
// list, not a shorter one that would leave a redacted page still refused.
export const SECRET_PATTERNS = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
];
// How much of a file the sniff reads; a credential dump announces itself in its first lines.
const SNIFF_BYTES = 8192;
// Only text-like types are sniffed; scanning binaries would only false-positive on compressed bytes.
const sniffable = (type: string): boolean => type.startsWith("text/") || type.startsWith("application/json") || type.startsWith("application/xml");

// Why a file in the outbox still isn't served; the listing reports it per entry for the Public view.
export type PublicBlock = "hidden" | "credential-name" | "credential-content" | "too-large" | "escapes";

export const BLOCK_REASON: Record<PublicBlock, string> = {
    hidden: "hidden files are never served",
    "credential-name": "the name says this is a credential",
    "credential-content": "the contents look like a credential",
    "too-large": "larger than the 512 MB ceiling",
    escapes: "a symlink pointing outside the folder",
};

// Rules 2 and 3: name-only checks, so the listing can apply them without opening the file.
export const blockByName = (relPath: string): PublicBlock | undefined => {
    const segments = relPath.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment.startsWith("."))) {
        return "hidden";
    }
    const name = segments.at(-1) ?? "";
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

// Every refusal answers 404 identically; telling a stranger which reason would turn the outbox into an oracle for
// probing the folder. The publisher gets the real reason in the Public view.
const notFound = (): PublicResolution => ({
    kind: "refused",
    status: 404,
    title: "Nothing published here",
    message: "This address doesn't point at a published file.",
});

// Path minus query/fragment, percent-decoded; undefined for bad encoding or an embedded NUL.
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

// One request to what to serve; a missing `root` is just "publishing is off", answered like a missing file.
export const resolvePublicFile = async (root: string, url: string | undefined): Promise<PublicResolution> => {
    const requested = requestPath(url);
    if (requested === undefined) {
        return notFound();
    }
    // Resolved once, or a symlinked workspace mount would fail containment for every legitimate request.
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
    // A directory serves its index.html and nothing else, never a listing (rule 4).
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
    // Rules 2, 3 and 5 judge the resolved name, not the requested one, or a same-outbox symlink launders both:
    // `logo.png -> .env` would serve, and its `.png` extension would skip the sniff too.
    const relPath = relative(realRoot, target).split(sep).join("/");
    const realRel = relative(realRoot, real).split(sep).join("/");
    if (blockByName(realRel) !== undefined) {
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
    const { type, inline } = contentTypeOf(realRel);
    if ((await blockByContent(real, type)) !== undefined) {
        return notFound();
    }
    return { kind: "file", absPath: real, size: stats.size, mtimeMs: stats.mtimeMs, type, inline };
};

// One published file, as the Public view lists it.
export interface PublicEntry {
    // Outbox-relative, forward-slash path; the path that rides the public URL.
    readonly path: string;
    readonly size: number;
    readonly modifiedAt: number;
    // Absent when served; present with the reason when a guard refuses it.
    readonly blocked?: PublicBlock;
}

// Every outbox file with its verdict, running the same guards (including the content sniff) the serve path runs. An
// absent outbox lists as empty.
export const listPublicFiles = async (root: string): Promise<PublicEntry[]> => {
    const entries: PublicEntry[] = [];
    // Resolved once, same as the serve path, or a symlinked workspace mount would call every file an escape.
    const realRoot = await realpath(root).catch(() => undefined);
    if (realRoot === undefined) {
        return entries;
    }
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
            const abs = join(dir, dirent.name);
            const stats = await stat(abs).catch(() => undefined);
            if (stats === undefined || !stats.isFile()) {
                continue;
            }
            const entry = { path, size: stats.size, modifiedAt: stats.mtimeMs };
            // Judged on the resolved name, like the serve path, so the two can never disagree about a symlink; one
            // whose bytes escape reports here as `escapes`.
            const real = await realpath(abs).catch(() => undefined);
            if (real === undefined || !real.startsWith(realRoot + sep)) {
                entries.push({ ...entry, blocked: "escapes" });
                continue;
            }
            const realRel = relative(realRoot, real).split(sep).join("/");
            const blocked =
                blockByName(realRel) ?? (stats.size > MAX_BYTES ? ("too-large" as const) : await blockByContent(real, contentTypeOf(realRel).type));
            entries.push(blocked === undefined ? entry : { ...entry, blocked });
        }
    };
    await walk(root, "", 1);
    return entries.toSorted((left, right) => left.path.localeCompare(right.path));
};
