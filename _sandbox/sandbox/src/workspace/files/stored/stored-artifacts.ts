import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { stateRelPath } from "../../../state-paths.js";
import { resolveRealWithin } from "../workspace-files-paths.js";

// The files agents leave in the artifacts folder (a screenshot, a generated picture), as a runner's relay brings one a
// turn there showed (runners/held-turns/runner-pictures.ts) and a runner serves one: kept here, below the runners, as
// stored-pages.ts keeps pages.

// The artifacts folder, workspace-relative with its trailing slash: what a picture's path must start with to travel.
export const ARTIFACTS_DIR = `${stateRelPath(".intentic/records/artifacts/")}/`;

// Past this a picture stays where it was taken: it travels inside one socket frame, as base64.
export const ARTIFACT_MAX_BYTES = 24 * 1024 * 1024;

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// Where `path` (workspace-relative) lands inside the artifacts folder, links resolved; undefined for a path outside it.
// `entry` resolves only the folders above, for a file about to be written.
const artifactAt = async (workspaceRoot: string, path: string, entry = false): Promise<string | undefined> =>
    path.startsWith(ARTIFACTS_DIR)
        ? (await resolveRealWithin(join(workspaceRoot, ARTIFACTS_DIR), path.slice(ARTIFACTS_DIR.length), { entry }))?.real
        : undefined;

export type ArtifactRead = { readonly kind: "file"; readonly bytes: Buffer } | { readonly kind: "none" } | { readonly kind: "too-large" };

// An artifact's bytes by the workspace path a transcript names it with. Resolved inside the artifacts folder itself,
// never the workspace: a path that climbs out of it (`../`) or through a link names a file no tool showed.
export const readArtifact = async (workspaceRoot: string, path: string): Promise<ArtifactRead> => {
    const file = await artifactAt(workspaceRoot, path);
    const info = file === undefined ? undefined : await stat(file).catch(undefinedIfMissing);
    if (file === undefined || info === undefined || !info.isFile()) {
        return { kind: "none" };
    }
    if (info.size > ARTIFACT_MAX_BYTES) {
        return { kind: "too-large" };
    }
    const bytes = await readFile(file).catch(undefinedIfMissing);
    return bytes === undefined ? { kind: "none" } : { kind: "file", bytes };
};

// The sha256 of the artifact this workspace holds at `path`, undefined when it holds none (or one past the cap, which no
// travelling copy can equal).
export const artifactDigest = async (workspaceRoot: string, path: string): Promise<string | undefined> => {
    const held = await readArtifact(workspaceRoot, path);
    return held.kind === "file" ? sha256Of(held.bytes) : undefined;
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

// Files here an artifact another machine wrote (a runner's turn), and answers the workspace path it is filed at: the one
// its transcript names, unless this workspace already holds different bytes there (both machines numbered their shots
// on their own, so `after.png` can be two pictures), in which case the first numbered name that is free or already
// holds these very bytes. Undefined for a path outside the artifacts folder. A file already here is never rewritten.
export const keepArtifactCopy = async (workspaceRoot: string, path: string, bytes: Uint8Array): Promise<string | undefined> => {
    if (!path.startsWith(ARTIFACTS_DIR)) {
        return undefined;
    }
    await mkdir(dirname(join(workspaceRoot, path)), { recursive: true });
    const digest = sha256Of(bytes);
    for (const name of namesFor(path)) {
        const target = await artifactAt(workspaceRoot, name, true);
        if (target === undefined) {
            return undefined;
        }
        try {
            await writeFile(target, bytes, { flag: "wx" });
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
