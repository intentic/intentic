import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { estimateTokens } from "@intentic/base/format";
import { errnoCode, errorMessage, isMissing } from "@intentic/base/errors";
import { IGNORED_DIRS, isAgentWorktreePath, isReferencePath } from "@intentic/workspace-ignore";
import { STATE_DIR } from "@intentic/constants";
import { detectFormat, type Format } from "./formats.js";
import { deriverStamp, neutralizeDoc, type DerivedDoc, type Deriver } from "./derivers/deriver.js";
import { archiveDeriver } from "./derivers/archive.js";
import { docxDeriver } from "./derivers/docx.js";
import { epubDeriver } from "./derivers/epub.js";
import { htmlDeriver } from "./derivers/html.js";
import { imageDeriver } from "./derivers/image.js";
import { ipynbDeriver } from "./derivers/ipynb.js";
import { mediaDeriver } from "./derivers/media.js";
import { odpDeriver } from "./derivers/odp.js";
import { odsDeriver } from "./derivers/ods.js";
import { odtDeriver } from "./derivers/odt.js";
import { pdfDeriver } from "./derivers/pdf.js";
import { pptxDeriver } from "./derivers/pptx.js";
import { profileDeriver } from "./derivers/profile.js";
import { rtfDeriver } from "./derivers/rtf.js";
import { xlsxDeriver } from "./derivers/xlsx.js";
import { cacheRendering, readCachedRendering } from "./content-cache.js";
import { isFresh, readSidecar, removeSidecar, sidecarBody, sidecarPathFor, sha256OfFile, writeSidecar } from "./sidecar.js";

// Pipeline `read` and `derive` both run: place the file, recognize it, route it, keep its shadow honest.
// One module, so `read` and `derive` cannot disagree about a file's markdown.

export const DERIVERS: Record<Format, Deriver> = {
    docx: docxDeriver,
    xlsx: xlsxDeriver,
    pptx: pptxDeriver,
    pdf: pdfDeriver,
    image: imageDeriver,
    media: mediaDeriver,
    html: htmlDeriver,
    ipynb: ipynbDeriver,
    odt: odtDeriver,
    ods: odsDeriver,
    odp: odpDeriver,
    rtf: rtfDeriver,
    epub: epubDeriver,
    archive: archiveDeriver,
    profile: profileDeriver,
};

// Above this, a derivation isn't cheap and the file is data to process, not shadow; skipped loudly.
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

/** Workspace-relative path when `abs` sits under `root`; undefined outside it (no sidecar can exist there). */
export const relPathIn = (root: string, abs: string): string | undefined => {
    const rel = relative(root, abs);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
};

// What the shadow tree refuses: machine subtrees, the daemon's own state, the reference shelf, agent worktrees.
export const isDeriveIgnored = (relPath: string): boolean => {
    const segments = relPath.split("/");
    return segments.some((segment) => IGNORED_DIRS.has(segment) || segment === STATE_DIR) || isReferencePath(relPath) || isAgentWorktreePath(relPath);
};

export type Outcome =
    | {
          readonly kind: "derived";
          readonly relPath: string;
          readonly format: Format;
          readonly sidecarPath: string;
          readonly body: string;
          readonly doc: DerivedDoc;
          readonly tokens: number;
      }
    | {
          readonly kind: "fresh";
          readonly relPath: string;
          readonly format: Format;
          readonly sidecarPath: string;
          readonly body: string;
          readonly tokens: number;
      }
    | { readonly kind: "removed"; readonly relPath: string; readonly sidecarPath: string }
    | { readonly kind: "skipped"; readonly relPath: string; readonly reason: string };

interface Rendered {
    readonly kind: "derived" | "fresh";
    readonly doc: DerivedDoc;
    readonly derivedAt: Date;
    /** The content-cache entry holding it whole; undefined when the cache could not be written. */
    readonly cachedPath: string | undefined;
}

// These bytes as this deriver renders them: from the content cache when rendered before, else derived and stored there.
// Throws only what the deriver throws.
const renderCached = async (
    workspaceRoot: string | undefined,
    absPath: string,
    deriver: Deriver,
    sourceSha: string,
    now: () => Date,
): Promise<Rendered> => {
    const stamp = deriverStamp(deriver);
    const cached = await readCachedRendering(workspaceRoot, sourceSha, stamp);
    if (cached !== undefined) {
        return { kind: "fresh", doc: cached.doc, derivedAt: cached.derivedAt, cachedPath: cached.path };
    }
    // Neutralized once here so every consumer gets folded text.
    const doc = neutralizeDoc(await deriver.derive(absPath));
    const derivedAt = now();
    return { kind: "derived", doc, derivedAt, cachedPath: await cacheRendering(workspaceRoot, { sourceSha, deriverStamp: stamp, doc, derivedAt }) };
};

/** Converges a workspace file's sidecar with its source: derive when stale, reuse fresh, remove when gone. */
export const ensureSidecar = async (workspaceRoot: string, absPath: string, now: () => Date = () => new Date()): Promise<Outcome> => {
    const relPath = relPathIn(workspaceRoot, absPath);
    if (relPath === undefined) {
        return { kind: "skipped", relPath: absPath, reason: "outside-workspace" };
    }
    if (isDeriveIgnored(relPath)) {
        return { kind: "skipped", relPath, reason: "ignored-path" };
    }
    const sidecarPath = sidecarPathFor(workspaceRoot, relPath);
    let source: Stats | undefined;
    try {
        source = await stat(absPath);
    } catch (error) {
        // Only a source that is gone takes its sidecar with it; one this process cannot stat is still there.
        if (!isMissing(error)) {
            return { kind: "skipped", relPath, reason: `unreadable (${errnoCode(error) ?? errorMessage(error)})` };
        }
    }
    if (source === undefined || !source.isFile()) {
        const removed = await removeSidecar(workspaceRoot, relPath);
        return removed ? { kind: "removed", relPath, sidecarPath } : { kind: "skipped", relPath, reason: "missing" };
    }
    if (source.size > MAX_SOURCE_BYTES) {
        return { kind: "skipped", relPath, reason: `too-large (${Math.round(source.size / 1024 / 1024)} MB)` };
    }
    const format = await detectFormat(absPath);
    if (format === undefined) {
        return { kind: "skipped", relPath, reason: "unsupported" };
    }
    const deriver = DERIVERS[format];
    const stamp = deriverStamp(deriver);
    const sourceSha = await sha256OfFile(absPath);
    const existing = await readSidecar(sidecarPath);
    if (isFresh(existing, sourceSha, stamp)) {
        const body = sidecarBody(existing ?? "");
        return { kind: "fresh", relPath, format, sidecarPath, body, tokens: estimateTokens(body) };
    }
    // A corrupt file's failure is a loud skip, not fatal.
    let rendered: Rendered;
    try {
        rendered = await renderCached(workspaceRoot, absPath, deriver, sourceSha, now);
    } catch (error) {
        const detail = errorMessage(error).split("\n")[0];
        return { kind: "skipped", relPath, reason: `derive-failed (${format}): ${detail}` };
    }
    const written = await writeSidecar(workspaceRoot, { relPath, sourceSha, deriverStamp: stamp, doc: rendered.doc, derivedAt: rendered.derivedAt });
    return rendered.kind === "fresh"
        ? { kind: "fresh", relPath, format, sidecarPath: written.path, body: written.body, tokens: written.tokens }
        : { kind: "derived", relPath, format, sidecarPath: written.path, body: written.body, doc: rendered.doc, tokens: written.tokens };
};

export type ContentOutcome =
    | { readonly kind: "derived" | "fresh"; readonly format: Format; readonly doc: DerivedDoc; readonly cachedPath: string | undefined }
    | { readonly kind: "failed"; readonly reason: string };

/** A file no sidecar shadows (outside the workspace, a git blob's temp copy) as markdown, through the content cache alone. */
export const renderByContent = async (
    workspaceRoot: string | undefined,
    absPath: string,
    now: () => Date = () => new Date(),
): Promise<ContentOutcome> => {
    const format = await detectFormat(absPath).catch(() => undefined);
    if (format === undefined) {
        return { kind: "failed", reason: "unsupported or missing" };
    }
    let sourceSha: string;
    try {
        sourceSha = await sha256OfFile(absPath);
    } catch (error) {
        return { kind: "failed", reason: isMissing(error) ? "missing" : `unreadable (${errnoCode(error) ?? errorMessage(error)})` };
    }
    try {
        const rendered = await renderCached(workspaceRoot, absPath, DERIVERS[format], sourceSha, now);
        return { kind: rendered.kind, format, doc: rendered.doc, cachedPath: rendered.cachedPath };
    } catch (error) {
        return { kind: "failed", reason: `derive-failed (${format}): ${errorMessage(error).split("\n")[0]}` };
    }
};
