import { stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { IGNORED_DIRS, isAgentWorktreePath, isReferencePath } from "@intentic/workspace-ignore";
import { STATE_DIR } from "@intentic/constants";
import { detectFormat, type Format } from "./formats.js";
import { deriverStamp, neutralizeDoc, type DerivedDoc, type Deriver } from "./derivers/deriver.js";
import { docxDeriver } from "./derivers/docx.js";
import { htmlDeriver } from "./derivers/html.js";
import { imageDeriver } from "./derivers/image.js";
import { mediaDeriver } from "./derivers/media.js";
import { pdfDeriver } from "./derivers/pdf.js";
import { pptxDeriver } from "./derivers/pptx.js";
import { xlsxDeriver } from "./derivers/xlsx.js";
import { isFresh, readSidecar, removeSidecar, sidecarBody, sidecarPathFor, sha256OfFile, writeSidecar } from "./sidecar.js";
import { tokensOf } from "./env.js";

/* The pipeline both commands and the daemon's sweep run: place the file, recognize it, route it, keep its
 * shadow honest. One module so `read` and `derive` cannot disagree about what a file's markdown is. */

export const DERIVERS: Record<Format, Deriver> = {
    docx: docxDeriver,
    xlsx: xlsxDeriver,
    pptx: pptxDeriver,
    pdf: pdfDeriver,
    image: imageDeriver,
    media: mediaDeriver,
    html: htmlDeriver,
};

/* Above this a derivation stops being background-cheap (hashing alone reads every byte) and a file this size
 * is data to process programmatically, not a document to shadow. Skipped loudly, per the no-silent-caps rule. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

/** Workspace-relative path when `abs` sits under `root`; undefined outside it (no sidecar can exist there). */
export const relPathIn = (root: string, abs: string): string | undefined => {
    const rel = relative(root, abs);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
};

/* What the shadow tree refuses to shadow, the CLI's own floor rather than trust in its callers: machine
 * subtrees (node_modules and friends), the daemon's state (a sidecar of a sidecar), the root-level reference
 * shelf (excluded from workspace attention on purpose), and agent worktrees (transient whole checkouts). */
export const isDeriveIgnored = (relPath: string): boolean => {
    const segments = relPath.split("/");
    return segments.some((segment) => IGNORED_DIRS.has(segment) || segment === STATE_DIR) || isReferencePath(relPath) || isAgentWorktreePath(relPath);
};

export type Outcome =
    | { readonly kind: "derived"; readonly relPath: string; readonly format: Format; readonly sidecarPath: string; readonly body: string; readonly doc: DerivedDoc; readonly tokens: number }
    | { readonly kind: "fresh"; readonly relPath: string; readonly format: Format; readonly sidecarPath: string; readonly body: string; readonly tokens: number }
    | { readonly kind: "removed"; readonly relPath: string; readonly sidecarPath: string }
    | { readonly kind: "skipped"; readonly relPath: string; readonly reason: string };

/** Converge one workspace file's sidecar with its source: derive when stale, reuse when fresh, remove when
 * the source is gone. The daemon's eager path and the CLI's lazy path are both exactly this call. */
export const ensureSidecar = async (workspaceRoot: string, absPath: string, now: () => Date = () => new Date()): Promise<Outcome> => {
    const relPath = relPathIn(workspaceRoot, absPath);
    if (relPath === undefined) {
        return { kind: "skipped", relPath: absPath, reason: "outside-workspace" };
    }
    if (isDeriveIgnored(relPath)) {
        return { kind: "skipped", relPath, reason: "ignored-path" };
    }
    const sidecarPath = sidecarPathFor(workspaceRoot, relPath);
    const source = await stat(absPath).catch(() => undefined);
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
        return { kind: "fresh", relPath, format, sidecarPath, body, tokens: tokensOf(body) };
    }
    // Neutralized here at the pipeline boundary so every consumer — the capsule on stdout as much as the
    // sidecar — gets folded text; a forged marker in a pdf's Title must not reach a transcript either.
    const doc = neutralizeDoc(await deriver.derive(absPath));
    const written = await writeSidecar(workspaceRoot, { relPath, sourceSha, deriverStamp: stamp, doc, derivedAt: now() });
    return { kind: "derived", relPath, format, sidecarPath: written.path, body: written.body, doc, tokens: written.tokens };
};
