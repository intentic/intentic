import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { shadowSearchText } from "@intentic/base/shadow-text";
import { DERIVED_SHADOWS_DIR, SHADOWED_DOCUMENT_EXTENSIONS } from "@intentic/constants";
import type { FileEntry } from "../types.js";

// Documents (pdf, docx, xlsx, pptx, odt, ods, odp, rtf, epub) are searched by their text, under their own paths. The
// text is fileq's shadow at .intentic/local/cache/derived/<path>.md, which the daemon's shadow keeper keeps current;
// iq reads it in place of the bytes, page-marked the way the ripgrep preprocessor prints it (`[p. 12] …`), so a hit's
// line and page match what `rg -n` says for the same document. The floor is untouched: the shadow is read as the
// document's content and never surfaces under its own path, and nothing else under .intentic becomes searchable.

const DOCUMENT_EXTENSIONS = new Set(SHADOWED_DOCUMENT_EXTENSIONS);

export const isDocumentPath = (path: string): boolean => DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase());

export const shadowPathOf = (root: string, path: string): string => join(root, DERIVED_SHADOWS_DIR, `${path}.md`);

// Every shadow under the mirror tree, by the workspace path it shadows. One walk of the (small) shadow tree rather than
// a stat per swept file; `.by-hash` and `.gitignore` at its top are fileq's own.
const listShadows = async (root: string): Promise<Set<string>> => {
    const found = new Set<string>();
    const walk = async (dir: string, rel: string): Promise<void> => {
        // allow(silent-catch): an unreadable or absent shadow folder only means its documents are indexed by their bytes.
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        await Promise.all(
            entries.map(async (entry) => {
                if (rel === "" && entry.name.startsWith(".")) {
                    return;
                }
                const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
                if (entry.isDirectory()) {
                    await walk(join(dir, entry.name), relPath);
                } else if (entry.isFile() && entry.name.endsWith(".md") && isDocumentPath(relPath.slice(0, -3))) {
                    found.add(relPath.slice(0, -3));
                }
            }),
        );
    };
    await walk(join(root, DERIVED_SHADOWS_DIR), "");
    return found;
};

/**
 * Swept entries with each shadowed document pointed at its shadow: `text` names the file to read, and mtime and size
 * are the shadow's, so the index re-reads a document exactly when its shadow changes. A document with no shadow is left
 * as it was (its bytes, which the indexer keeps as a bare binary row).
 */
export const withShadows = async (root: string, entries: readonly FileEntry[]): Promise<FileEntry[]> => {
    if (!entries.some((entry) => isDocumentPath(entry.path))) {
        return [...entries];
    }
    const shadows = await listShadows(root);
    return Promise.all(
        entries.map(async (entry) => {
            if (!shadows.has(entry.path)) {
                return entry;
            }
            const text = shadowPathOf(root, entry.path);
            const stats = await stat(text).catch(undefinedIfMissing);
            return stats === undefined ? entry : { ...entry, text, mtimeMs: stats.mtimeMs, size: stats.size };
        }),
    );
};

/** A document's searchable text (shadow body, page-marked); undefined for a non-document or one with no shadow. */
export const readDocumentText = async (root: string, path: string): Promise<string | undefined> => {
    if (!isDocumentPath(path)) {
        return undefined;
    }
    const shadow = await readFile(shadowPathOf(root, path), "utf8").catch(undefinedIfMissing);
    return shadow === undefined ? undefined : shadowSearchText(shadow);
};

/** readDocumentText, synchronously, for the verifier's line lookups. */
export const readDocumentTextSync = (root: string, path: string): string | undefined => {
    if (!isDocumentPath(path)) {
        return undefined;
    }
    try {
        return shadowSearchText(readFileSync(shadowPathOf(root, path), "utf8"));
    } catch {
        // allow(silent-catch): no shadow means the document has no text to look a line up in; the caller reads the bytes.
        return undefined;
    }
};
