import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { stateRelPath } from "../../../state-paths.js";
import { isUnder, resolveRealWithin, resolveWithin } from "../workspace-files-paths.js";

// The files agents leave in the artifacts folder (a screenshot, a generated picture), as a runner's relay brings one a
// turn there showed (runners/held-turns/runner-pictures.ts) and a runner serves one: kept here, below the runners, as
// stored-pages.ts keeps pages.

// The artifacts folder, workspace-relative with its trailing slash: what a picture's path must start with to travel.
export const ARTIFACTS_DIR = `${stateRelPath(".intentic/records/artifacts/")}/`;

// Past this a file asked for whole stays where it was made: it travels inside one socket frame, as base64.
export const ARTIFACT_MAX_BYTES = 24 * 1024 * 1024;

// Past this a file stays where it was made even in pieces: a take or a trace, not a disk image.
export const ARTIFACT_FILE_MAX_BYTES = 512 * 1024 * 1024;

// One piece of a file asked for in pieces: well inside a socket frame once base64 grows it by a third.
export const ARTIFACT_CHUNK_BYTES = 8 * 1024 * 1024;

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// Where `path` (workspace-relative) lands inside the artifacts folder, links resolved; undefined for a path outside it.
// `entry` resolves only the folders above, for a file about to be written.
const artifactAt = async (workspaceRoot: string, path: string, entry = false): Promise<string | undefined> =>
    path.startsWith(ARTIFACTS_DIR)
        ? (await resolveRealWithin(join(workspaceRoot, ARTIFACTS_DIR), path.slice(ARTIFACTS_DIR.length), { entry }))?.real
        : undefined;

// Makes the folder `path` (workspace-relative, in the artifacts folder) is filed in, once it is known to land inside the
// artifacts folder: as spelled, and by the real path of the deepest folder of it that exists already, so neither `..` nor
// a link creates a folder outside it. False when it would not.
const artifactDirMade = async (workspaceRoot: string, path: string): Promise<boolean> => {
    const artifacts = join(workspaceRoot, ARTIFACTS_DIR);
    const spelled = resolveWithin(artifacts, path.slice(ARTIFACTS_DIR.length));
    if (spelled === undefined) {
        return false;
    }
    await mkdir(artifacts, { recursive: true });
    const realArtifacts = await realpath(artifacts);
    let existing = dirname(spelled);
    while ((await lstat(existing).catch(undefinedIfMissing)) === undefined) {
        existing = dirname(existing);
    }
    const real = await realpath(existing).catch(undefinedIfMissing);
    if (real === undefined || (real !== realArtifacts && isUnder(realArtifacts, real) === undefined)) {
        return false;
    }
    await mkdir(dirname(spelled), { recursive: true });
    return true;
};

export type ArtifactRead = { readonly kind: "file"; readonly bytes: Buffer } | { readonly kind: "none" } | { readonly kind: "too-large" };

/** The real path of `path` (workspace-relative) inside the artifacts folder, links resolved; undefined outside it. */
export const artifactFile = (workspaceRoot: string, path: string): Promise<string | undefined> => artifactAt(workspaceRoot, path);

/** The real path of `path` (relative to a conversation's checkout, `dir`) inside that checkout, links resolved: a
 *  picture a turn Read from its own checkout. Undefined for a path that climbs out of it or through a link. */
export const checkoutFile = async (dir: string, path: string): Promise<string | undefined> => (await resolveRealWithin(dir, path))?.real;

export type RangeRead =
    | { readonly kind: "file"; readonly bytes: Buffer; readonly size: number }
    | { readonly kind: "none" }
    | { readonly kind: "too-large"; readonly size: number };

/** `length` bytes of the regular file at `real` from `offset` on (fewer at its end), with the whole file's size; refused
 *  past `max`. A piece is never larger than ARTIFACT_CHUNK_BYTES, whatever was asked. */
export const readRange = async (real: string, offset: number, length: number, max = ARTIFACT_FILE_MAX_BYTES): Promise<RangeRead> => {
    const handle = await open(real, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return { kind: "none" };
    }
    try {
        const info = await handle.stat();
        if (!info.isFile()) {
            return { kind: "none" };
        }
        if (info.size > max) {
            return { kind: "too-large", size: info.size };
        }
        const want = Math.max(0, Math.min(length, ARTIFACT_CHUNK_BYTES, info.size - offset));
        const bytes = Buffer.alloc(want);
        const { bytesRead } = want === 0 ? { bytesRead: 0 } : await handle.read(bytes, 0, want, offset);
        return { kind: "file", bytes: bytes.subarray(0, bytesRead), size: info.size };
    } finally {
        await handle.close();
    }
};

/** The sha256 of the regular file at `real`, read as a stream; undefined when it is none or is past `max`. */
export const fileDigest = async (real: string, max = ARTIFACT_FILE_MAX_BYTES): Promise<string | undefined> => {
    const info = await stat(real).catch(undefinedIfMissing);
    if (info === undefined || !info.isFile() || info.size > max) {
        return undefined;
    }
    const hash = createHash("sha256");
    for await (const piece of createReadStream(real)) {
        // A stream opened without an encoding yields bytes.
        hash.update(Buffer.from(piece));
    }
    return hash.digest("hex");
};

// Folders of the artifacts folder a sweep leaves alone: the person's uploads (they came from the parent), pages (they
// travel with their frames, runner-pages.ts) and copies a parent already filed from its own runners.
const UNSWEPT = ["attachments/", "pages/", "runner/"];

// Past this many files a sweep stops listing: a runaway loop's frames, not a turn's evidence.
const SWEEP_MAX_FILES = 2000;

export interface ArtifactEntry {
    readonly path: string;
    readonly size: number;
    readonly mtimeMs: number;
}

/** The files in the artifacts folder modified at or after `since`, by workspace path, oldest first: what a runner's turn
 *  left there for its parent to sweep home (runners/held-turns/runner-artifacts.ts). Links are not followed. */
export const artifactsSince = async (workspaceRoot: string, since: number): Promise<ArtifactEntry[]> => {
    const found: ArtifactEntry[] = [];
    const walk = async (rel: string): Promise<void> => {
        const entries = await readdir(join(workspaceRoot, ARTIFACTS_DIR, rel), { withFileTypes: true }).catch(undefinedIfMissing);
        for (const entry of entries ?? []) {
            const child = `${rel}${entry.name}`;
            if (found.length >= SWEEP_MAX_FILES || UNSWEPT.some((skipped) => `${child}/`.startsWith(skipped))) {
                continue;
            }
            if (entry.isDirectory()) {
                await walk(`${child}/`);
            } else if (entry.isFile()) {
                const info = await lstat(join(workspaceRoot, ARTIFACTS_DIR, child)).catch(undefinedIfMissing);
                if (info !== undefined && info.mtimeMs >= since) {
                    found.push({ path: `${ARTIFACTS_DIR}${child}`, size: info.size, mtimeMs: info.mtimeMs });
                }
            }
        }
    };
    await walk("");
    return found.toSorted((a, b) => a.mtimeMs - b.mtimeMs);
};

// An artifact's bytes by the workspace path a transcript names it with. Resolved inside the artifacts folder itself,
// never the workspace: a path that climbs out of it (`../`) or through a link names a file no tool showed.
export const readArtifact = async (workspaceRoot: string, path: string): Promise<ArtifactRead> => {
    const file = await artifactAt(workspaceRoot, path);
    return file === undefined ? { kind: "none" } : readWholeFile(file);
};

/** The whole regular file at `real` (already resolved), refused past what one socket frame carries. */
export const readWholeFile = async (file: string): Promise<ArtifactRead> => {
    const info = await stat(file).catch(undefinedIfMissing);
    if (info === undefined || !info.isFile()) {
        return { kind: "none" };
    }
    if (info.size > ARTIFACT_MAX_BYTES) {
        return { kind: "too-large" };
    }
    const bytes = await readFile(file).catch(undefinedIfMissing);
    return bytes === undefined ? { kind: "none" } : { kind: "file", bytes };
};

// The sha256 of the artifact this workspace holds at `path`, undefined when it holds none (or one past the cap for a file
// in pieces, which no travelling copy can equal).
export const artifactDigest = async (workspaceRoot: string, path: string): Promise<string | undefined> => {
    const file = await artifactAt(workspaceRoot, path);
    return file === undefined ? undefined : fileDigest(file);
};

// Past this many numbered names a copy takes a clock suffix instead.
const MAX_NUMBERED = 1000;

// The names a copy of `path` may take, in order: its own, then `shot-2.png`, `shot-3.png`, as browser-artifacts.ts
// numbers a shot whose name is taken.
function* namesFor(path: string): Generator<string> {
    const ext = extname(path);
    const stem = path.slice(0, path.length - ext.length);
    yield path;
    for (let n = 2; n <= MAX_NUMBERED; n += 1) {
        yield `${stem}-${n}${ext}`;
    }
    yield `${stem}-${Date.now()}${ext}`;
}

/** A file brought in pieces, written next to where it is filed and then filed by keepArtifactCopy's rule (`keep`); the
 *  caller writes `real` and calls exactly one of `keep` and `discard`. Undefined for a path outside the artifacts folder. */
export const artifactPart = async (
    workspaceRoot: string,
    path: string,
): Promise<{ readonly real: string; readonly keep: () => Promise<string | undefined>; readonly discard: () => Promise<void> } | undefined> => {
    if (!path.startsWith(ARTIFACTS_DIR)) {
        return undefined;
    }
    if (!(await artifactDirMade(workspaceRoot, path))) {
        return undefined;
    }
    const target = await artifactAt(workspaceRoot, path, true);
    if (target === undefined) {
        return undefined;
    }
    const real = join(dirname(target), `.${basename(target)}.part-${randomBytes(6).toString("hex")}`);
    const discard = (): Promise<void> => rm(real, { force: true });
    const keep = async (): Promise<string | undefined> => {
        try {
            return await placeFile(workspaceRoot, path, real);
        } finally {
            await discard();
        }
    };
    return { real, keep, discard };
};

// Files the finished part at `part` by keepArtifactCopy's rule: a hard link, which never replaces a file.
const placeFile = async (workspaceRoot: string, path: string, part: string): Promise<string | undefined> => {
    const digest = await fileDigest(part);
    return digest === undefined ? undefined : underFreeName(workspaceRoot, path, digest, (target) => link(part, target));
};

// The first of `path`'s names (namesFor) that `put` could write, which throws EEXIST for one taken, or that already holds
// bytes of `digest`; undefined past the artifacts folder.
const underFreeName = async (workspaceRoot: string, path: string, digest: string, put: (target: string) => Promise<void>): Promise<string | undefined> => {
    for (const name of namesFor(path)) {
        const target = await artifactAt(workspaceRoot, name, true);
        if (target === undefined) {
            return undefined;
        }
        try {
            await put(target);
            return name;
        } catch (error) {
            if (errnoCode(error) !== "EEXIST") {
                throw error;
            }
        }
        if ((await artifactDigest(workspaceRoot, name)) === digest) {
            return name;
        }
    }
    return undefined;
};

// Files here an artifact another machine wrote (a runner's turn), and answers the workspace path it is filed at: the one
// its transcript names, unless this workspace already holds different bytes there (both machines numbered their shots
// on their own, so `after.png` can be two pictures), in which case the first numbered name that is free or already
// holds these very bytes. Undefined for a path outside the artifacts folder. A file already here is never rewritten.
export const keepArtifactCopy = async (workspaceRoot: string, path: string, bytes: Uint8Array): Promise<string | undefined> => {
    if (!path.startsWith(ARTIFACTS_DIR)) {
        return undefined;
    }
    if (!(await artifactDirMade(workspaceRoot, path))) {
        return undefined;
    }
    return underFreeName(workspaceRoot, path, sha256Of(bytes), (target) => writeFile(target, bytes, { flag: "wx" }));
};
