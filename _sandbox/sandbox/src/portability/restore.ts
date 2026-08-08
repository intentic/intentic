import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { BundleManifestSchema, type BundleManifest, type ImportReport } from "@intentic/sandbox-contract";
import { extract, type Headers } from "tar-stream";
import { repoGitDir } from "../history/history.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { resolveWithin, setWorkspaceMtime, writeStreamCounted } from "../workspace/workspace-files.js";
import { BUNDLE_MANIFEST_ENTRY } from "./bundle.js";
import { carries, historyMayContain, historyPortability, workspaceMayContain, workspacePortability } from "./classify.js";

/* UNPACKING A BUNDLE INTO A FRESH SANDBOX — and then telling the owner, honestly, what is still missing.
 *
 * The restore writes two trees and heals one thing. It does NOT try to make the target identical by itself,
 * because it cannot: the image the overlay describes is built by the host (the container holds no docker
 * socket), the provider logins are OAuth this daemon cannot mint, and identity is the target's own. Those
 * become `needsAction` entries rather than silent gaps — the report IS the deliverable, and a restore that
 * claimed success while leaving a stock image would be the failure this whole feature exists to prevent.
 *
 * EVERY DECISION IS RE-DERIVED HERE. The bundle is a file the owner can hand around, so what it says about
 * itself is never load-bearing: an entry is written because THIS daemon's manifests class its path as
 * carryable, not because some exporter packed it. A tar carrying `history/session-secret` is refused and
 * reported, which is the same posture the generic upload route takes with isControlPlanePath.
 */

export class BundleFormatError extends Error {}

const drain = (source: Readable): Promise<void> =>
    new Promise((resolve, reject) => {
        source.on("end", resolve);
        source.on("error", reject);
        source.resume();
    });

const readEntry = (source: Readable): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        source.on("data", (chunk: Buffer) => chunks.push(chunk));
        source.on("end", () => resolve(Buffer.concat(chunks)));
        source.on("error", reject);
    });

// Which root an entry belongs to, and its path within it. An entry naming neither prefix is not part of this
// format — a foreign tar, or a bundle from a version whose layout moved.
const placeEntry = (name: string): { root: "workspace" | "history"; relPath: string } | undefined => {
    for (const root of ["workspace", "history"] as const) {
        if (name.startsWith(`${root}/`)) {
            return { root, relPath: name.slice(root.length + 1) };
        }
    }
    return undefined;
};

/* THE HEAL. A repo's in-tree `.git` is a POINTER FILE naming its real git dir on /history (see
 * git/repo-git-dirs.ts for the invariant that forces it), and that path is ABSOLUTE. The bundle carries both
 * halves, but the pointer it carries was written for the SOURCE sandbox's historyRoot — so on a target whose
 * HISTORY_ROOT differs, every pointer names a directory that does not exist and every git command in the
 * restored workspace answers `fatal: not a git repository`.
 *
 * Rewriting them is the whole difference between a restored workspace and a pile of files. It is cheap and it
 * is idempotent: the pointer is one line, and re-running on an already-correct tree writes the same line.
 *
 * The root repo is included deliberately — `/work/.git` is a pointer too, and `ensureRootRepo` heals only a
 * MISSING one. Over a dangling pointer, `git init --separate-git-dir` refuses outright (verified: exit 128,
 * "not a git repository"), so boot convergence cannot rescue this and the restore has to.
 */
const healGitPointers = async (workspaceRoot: string, historyRoot: string): Promise<string[]> => {
    const healed: string[] = [];
    const gitsDir = join(historyRoot, "gits");
    const restored = new Set((await readdir(gitsDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name));
    // "root" is the /work repo itself; the rest are ids relative to the workspace root.
    for (const repo of ["root", ...(await discoverRepos(workspaceRoot))]) {
        if (!restored.has(encodeURIComponent(repo))) {
            continue;
        }
        const pointer = repo === "root" ? join(workspaceRoot, ".git") : join(workspaceRoot, repo, ".git");
        await writeFile(pointer, `gitdir: ${repoGitDir(historyRoot, repo)}\n`);
        healed.push(repo);
    }
    return healed;
};

/* The report's action list, assembled from what the bundle said it left out plus the two things no bundle can
 * ever carry. Ordered by what blocks the most: the image first (until it is rebuilt the sandbox is missing
 * every tool the overlay installs), then credentials, then identity.
 */
const actionsFor = (manifest: BundleManifest): ImportReport["needsAction"] => {
    const actions: ImportReport["needsAction"] = [];
    if (manifest.environment.customDockerfile !== undefined) {
        actions.push({
            subject: "Rebuild the environment image",
            detail: "The overlay Dockerfile was restored, but the IMAGE it describes is built outside the container. Open the Environment card and run the rebuild command it shows — until then this sandbox is on the stock image and none of the tools the overlay installs are present.",
        });
    }
    if (!manifest.secrets && manifest.environment.capabilities.length > 0) {
        actions.push({
            subject: "Re-add capabilities",
            detail: `Exported without secrets, so the capability manifest did not travel. Re-add these on the Capabilities view — the environment overlay recomposes its fragments once they are back: ${manifest.environment.capabilities.map((capability) => `${capability.id} (${capability.kind})`).join(", ")}.`,
        });
    }
    for (const entry of manifest.excluded) {
        if (entry.note !== undefined) {
            actions.push({ subject: entry.path, detail: entry.note });
        }
    }
    return actions;
};

/* Extract a bundle. Streamed entry by entry — nothing is buffered but the manifest, which is small and has to
 * be read before anything can be decided.
 *
 * `limit` bounds the whole archive the way the upload route bounds a drop; past it the restore aborts with
 * whatever it had already written, which is why a restore is documented as something to do on a FRESH sandbox
 * rather than over a workspace someone is using.
 */
export const restoreBundle = async (
    body: ReadableStream<Uint8Array>,
    roots: { readonly workspaceRoot: string; readonly historyRoot: string },
    limit: number,
): Promise<ImportReport> => {
    const ex = extract();
    let remaining = limit;
    let manifest: BundleManifest | undefined;
    const refused: string[] = [];
    let workspaceFiles = 0;
    let historyFiles = 0;
    let bytes = 0;

    const handleEntry = async (header: Headers, stream: Readable): Promise<void> => {
        if (header.name === BUNDLE_MANIFEST_ENTRY) {
            const parsed = BundleManifestSchema.safeParse(JSON.parse((await readEntry(stream)).toString("utf8")));
            if (!parsed.success) {
                throw new BundleFormatError("the bundle manifest is not readable by this daemon");
            }
            manifest = parsed.data;
            return;
        }
        // The manifest is the first entry a packer writes; anything before it means this is not our format (or
        // it was repacked), and deciding entries without it would mean deciding them blind.
        if (manifest === undefined) {
            throw new BundleFormatError(`expected ${BUNDLE_MANIFEST_ENTRY} first — this does not look like an intentic environment bundle`);
        }
        const placed = placeEntry(header.name);
        if (placed === undefined) {
            refused.push(header.name);
            await drain(stream);
            return;
        }
        const root = placed.root === "workspace" ? roots.workspaceRoot : roots.historyRoot;
        /* Re-derived, never trusted: `secrets: true` here means "this daemon would carry it under SOME export
         * choice", so a hand-added identity file is refused whatever the bundle claims about itself.
         *
         * A directory entry is judged by the descent rule instead — an empty `.intentic/sessions/claude/projects/` is a
         * legitimate carried directory even though the store above it is a credential root. */
        const allowed =
            header.type === "directory"
                ? placed.root === "workspace"
                    ? workspaceMayContain(placed.relPath.replace(/\/$/, ""), true)
                    : historyMayContain(placed.relPath.replace(/\/$/, ""), true)
                : carries(placed.root === "workspace" ? workspacePortability(placed.relPath) : historyPortability(placed.relPath), true);
        if (!allowed) {
            refused.push(header.name);
            await drain(stream);
            return;
        }
        const target = resolveWithin(root, placed.relPath);
        if (target === undefined) {
            refused.push(header.name);
            await drain(stream);
            return;
        }
        if (header.type === "directory") {
            await mkdir(target, { recursive: true });
            await drain(stream);
            return;
        }
        if (header.type === "symlink") {
            await mkdir(dirname(target), { recursive: true });
            // A restore runs onto a fresh sandbox, but the daemon's own boot has already converged some of
            // these paths — replacing rather than failing keeps the restore idempotent.
            await rm(target, { force: true });
            await symlink(header.linkname ?? "", target);
            await drain(stream);
            return;
        }
        if (header.type !== "file") {
            await drain(stream);
            return;
        }
        await mkdir(dirname(target), { recursive: true });
        const written = await writeStreamCounted(stream, target, () => remaining);
        remaining -= written;
        bytes += written;
        if (placed.root === "workspace") {
            workspaceFiles += 1;
        } else {
            historyFiles += 1;
        }
        if (header.mtime !== undefined) {
            await setWorkspaceMtime(target, header.mtime.getTime());
        }
        // The mode is what the existing folder-drop path loses: every entry it writes gets the default, so a
        // restored `+x` script is no longer executable. Best-effort — a chmod failure must not fail a restore.
        if (header.mode !== undefined) {
            await chmod(target, header.mode & 0o7777).catch(() => {});
        }
    };

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>).pipe(createGunzip());
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            source.destroy();
            ex.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        /* A failure of the DECODERS is the caller's fault, not the daemon's: gunzip answers Z_DATA_ERROR for
         * anything that is not gzip, and tar-stream throws on a truncated or malformed member. Both mean "that
         * upload is not a bundle", which is a 400 — reported as one rather than escaping as an unhandled throw
         * the route turns into a 500 and the owner reads as "the sandbox broke".
         *
         * Failures of `handleEntry` propagate UNCHANGED, because they are a different class entirely: a full
         * disk, a permission error, or the size cap (UploadTooLargeError → 413). Converting those to a format
         * error would blame the bundle for the sandbox's own problem. */
        const failDecode = (error: unknown): void =>
            fail(new BundleFormatError(`the archive could not be read — it is not a gzipped intentic environment bundle (${String(error)})`));
        ex.on("entry", (header, stream, next) => {
            handleEntry(header, stream).then(() => next(), fail);
        });
        ex.on("finish", () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        });
        ex.on("error", failDecode);
        source.on("error", failDecode);
        source.pipe(ex);
    });

    if (manifest === undefined) {
        throw new BundleFormatError("the archive carried no bundle manifest");
    }
    const repos = await healGitPointers(roots.workspaceRoot, roots.historyRoot);
    return { restored: { workspaceFiles, historyFiles, repos, bytes }, refused, needsAction: actionsFor(manifest) };
};
