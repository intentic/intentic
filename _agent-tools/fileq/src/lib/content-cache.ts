import { join } from "node:path";
import { toolHome } from "@intentic/agent-cli/env";
import type { DerivedDoc } from "./derivers/deriver.js";
import { DERIVED_DIR, ignoreShadowsInGit, isFresh, parseSidecarFront, readSidecar, sidecarBody, writeDerived, type DerivedEntry } from "./sidecar.js";

// Renderings keyed by what they are a function of, the source's sha256 and the deriver stamp, never by its path: the
// same bytes read again (the same file, a copy or a move, a download, a git blob) answer from here without a deriver.
// Kept in the workspace's derived tree when there is a workspace, so its .gitignore covers them, else in the per-user
// cache. A cache that cannot be read or written costs the speed-up, never the read.

export const contentCacheDir = (workspaceRoot: string | undefined): string =>
    workspaceRoot === undefined ? join(toolHome("fileq"), "by-hash") : join(workspaceRoot, DERIVED_DIR, ".by-hash");

// The stamp made safe for a file name (`docx v2` → `docx-v2`); a hit is checked against the entry's own front matter.
export const contentCachePathFor = (workspaceRoot: string | undefined, sourceSha: string, deriverStamp: string): string =>
    join(contentCacheDir(workspaceRoot), `${sourceSha}.${deriverStamp.replaceAll(/[^A-Za-z0-9.+-]/g, "-")}.md`);

export interface CachedRendering {
    readonly path: string;
    readonly doc: DerivedDoc;
    readonly derivedAt: Date;
}

/** The stored rendering of these bytes by this deriver; undefined when there is none, or none that still matches. */
export const readCachedRendering = async (
    workspaceRoot: string | undefined,
    sourceSha: string,
    deriverStamp: string,
): Promise<CachedRendering | undefined> => {
    const path = contentCachePathFor(workspaceRoot, sourceSha, deriverStamp);
    const content = await readSidecar(path);
    if (content === undefined || !isFresh(content, sourceSha, deriverStamp)) {
        return undefined;
    }
    const front = parseSidecarFront(content);
    const derivedAt = new Date(front.derivedAt ?? Number.NaN);
    if (Number.isNaN(derivedAt.getTime())) {
        return undefined;
    }
    const body = sidecarBody(content);
    // writeDerived ends a non-empty body with one newline of its own.
    const markdown = body.endsWith("\n") ? body.slice(0, -1) : body;
    return { path, doc: { markdown, title: front.title, notes: [...front.notes] }, derivedAt };
};

/** Stores a rendering under its content key; answers the entry's path, or undefined when it could not be written. */
export const cacheRendering = async (workspaceRoot: string | undefined, entry: Omit<DerivedEntry, "source">): Promise<string | undefined> => {
    try {
        const written = await writeDerived(contentCachePathFor(workspaceRoot, entry.sourceSha, entry.deriverStamp), entry);
        if (workspaceRoot !== undefined) {
            await ignoreShadowsInGit(workspaceRoot);
        }
        return written.path;
    } catch {
        // allow(silent-catch): an unwritable cache costs the next read its speed-up, never this read its rendering.
        return undefined;
    }
};
