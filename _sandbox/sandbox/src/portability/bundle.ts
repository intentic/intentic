import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { type BundleManifest, HISTORY_STATE_FILES, WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import { pack, type Pack } from "tar-stream";
import type { Services } from "../composition.js";
import { baseImageOf, customPath } from "../environment/environment.js";
import { carries, historyMayContain, historyPortability, workspaceMayContain, workspacePortability } from "./classify.js";

/* PACKING A SANDBOX'S ENVIRONMENT — a gzipped tar of the two volumes that hold it, driven entirely by the
 * state manifests so that adding a store is what adds it to the bundle.
 *
 * Layout, and why it is three prefixes rather than a mirror of the filesystem:
 *
 *   intentic-bundle.json   the manifest, written FIRST so a reader knows the shape before the bytes
 *   workspace/…           `/work`, minus junk (the tree view's own ignore scope) and minus what the
 *                         manifests class as identity/derived/secret-the-owner-withheld
 *   history/…             the portable slice of `/history` — critically `history/gits/…`, every repo's REAL
 *                         git dir, without which the restored tree is a pile of files whose `.git` pointers
 *                         name a path that does not exist on the target
 *
 * Nothing is buffered. Entries stream file-by-file through the packer into gzip, so a workspace of any size
 * costs the daemon one file handle at a time — the same discipline the upload route holds on the way in.
 *
 * MODES AND SYMLINKS ARE PRESERVED, which the existing /workspace/upload-archive path does not do (it writes
 * every entry with the default mode and drops symlinks entirely). For a folder drop that is survivable; for a
 * bundle whose whole promise is "the same environment" it is not — a restored tree whose scripts lost +x is a
 * different environment, and silently so.
 */

export const BUNDLE_MANIFEST_ENTRY = "intentic-bundle.json";

// Pack one regular file, streaming its bytes. `size` must be exact or tar-stream throws, so it comes from the
// same lstat that decided this was a file — a file the agent rewrites mid-walk is the one race here, and it
// fails the export loudly rather than producing a corrupt member.
const packFile = (packer: Pack, name: string, absPath: string, size: number, mode: number, mtime: Date): Promise<void> =>
    new Promise((resolve, reject) => {
        const entry = packer.entry({ name, size, mode, mtime, type: "file" }, (error) => (error === null ? resolve() : reject(error)));
        createReadStream(absPath).on("error", reject).pipe(entry);
    });

const packSymlink = (packer: Pack, name: string, linkname: string): Promise<void> =>
    new Promise((resolve, reject) => {
        packer.entry({ name, linkname, type: "symlink" }, (error) => (error === null ? resolve() : reject(error)));
    });

// One tree, walked depth-first, every entry asked of `decide` before it is packed. Returns what it wrote so the
// report can state a size rather than a shrug. Directories are packed only when EMPTY: a directory with files
// under it is implied by their paths, and the restorer creates parents anyway, so emitting every one of them
// would double the entry count of a deep tree for nothing.
const packTree = async (
    packer: Pack,
    root: string,
    prefix: string,
    // Two questions, not one: `carry` decides a FILE, `enter` decides whether to look inside a directory. See
    // mayContainCarried — a directory that does not itself travel can hold one that does.
    decide: { readonly carry: (relPath: string) => boolean; readonly enter: (relPath: string) => boolean },
    scope?: IgnoreScope,
): Promise<{ files: number; bytes: number }> => {
    let files = 0;
    let bytes = 0;

    const walk = async (absDir: string, relDir: string, ignore: IgnoreScope | undefined): Promise<boolean> => {
        const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
        let wrote = false;
        for (const entry of entries) {
            const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
            const absPath = join(absDir, entry.name);
            const isDir = entry.isDirectory();
            if (ignore?.isIgnored(entry.name, relPath, isDir) === true) {
                continue;
            }
            if (!(isDir ? decide.enter(relPath) : decide.carry(relPath))) {
                continue;
            }
            if (entry.isSymbolicLink()) {
                await packSymlink(packer, `${prefix}${relPath}`, await readlink(absPath));
                files += 1;
                wrote = true;
                continue;
            }
            if (isDir) {
                const child = ignore === undefined ? undefined : await ignore.descend(absPath, relPath);
                wrote = (await walk(absPath, relPath, child)) || wrote;
                continue;
            }
            if (!entry.isFile()) {
                // Sockets, fifos and device nodes have no meaning on the other side of a restore.
                continue;
            }
            const stats = await lstat(absPath).catch(() => undefined);
            if (stats === undefined) {
                continue;
            }
            await packFile(packer, `${prefix}${relPath}`, absPath, stats.size, stats.mode & 0o7777, stats.mtime);
            files += 1;
            bytes += stats.size;
            wrote = true;
        }
        // An empty directory that survived every filter is content in its own right (a scaffold's placeholder,
        // the reference shelf), and only an explicit entry can carry it.
        if (!wrote && relDir !== "") {
            packer.entry({ name: `${prefix}${relDir}/`, type: "directory" }).end();
        }
        return wrote;
    };

    await walk(root, "", scope);
    return { files, bytes };
};

// The manifest's `excluded` list: every declared entry this export is leaving behind, with the manifest's own
// note. Derived from the same tables the walk consults, so it can never describe a different bundle than the
// one being written.
const excludedEntries = (secrets: boolean): BundleManifest["excluded"] =>
    [
        ...WORKSPACE_STATE_FILES.filter((file) => !carries(file.portability, secrets)),
        ...HISTORY_STATE_FILES.filter((file) => !carries(file.portability, secrets)),
    ]
        .map((file) =>
            file.note === undefined
                ? { path: file.path, portability: file.portability }
                : { path: file.path, portability: file.portability, note: file.note },
        )
        .toSorted((left, right) => left.path.localeCompare(right.path));

// The facts the target needs to reproduce this environment, as opposed to the composed file it must not reuse.
const environmentFacts = async (services: Services): Promise<BundleManifest["environment"]> => {
    const custom = await services.files.read(customPath(services));
    const capabilities = await services.capabilities.list();
    return {
        ...(custom === undefined ? {} : { customDockerfile: custom }),
        baseImage: baseImageOf(services.config.sandbox.baseImage, services.config.sandbox.image),
        ...(services.config.sandbox.environmentHash === "" ? {} : { approvedHash: services.config.sandbox.environmentHash }),
        capabilities: capabilities.map((capability) => ({ id: capability.id, kind: capability.kind })),
    };
};

/* Stream a bundle of this sandbox's environment. `secrets` is the owner's choice at the export dialog and the
 * ONLY thing that varies what is packed — everything else is the manifests.
 *
 * `now` is injected rather than read here so the manifest is deterministic under test; production passes
 * Date.now() at the route.
 */
export const packBundle = (services: Services, options: { readonly secrets: boolean; readonly now: number }): ReadableStream<Uint8Array> => {
    const packer = pack();
    const gzip = createGzip();
    packer.pipe(gzip);

    void (async () => {
        try {
            const manifest: BundleManifest = {
                version: 1,
                ...(services.config.sandbox.name === "" ? {} : { sandbox: { name: services.config.sandbox.name } }),
                createdAt: options.now,
                secrets: options.secrets,
                environment: await environmentFacts(services),
                excluded: excludedEntries(options.secrets),
            };
            const body = Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`);
            packer.entry({ name: BUNDLE_MANIFEST_ENTRY, size: body.byteLength, type: "file" }).end(body);

            // The workspace, filtered by the tree view's own ignore rules (node_modules, build output, browser
            // profiles, agent worktrees, the reference shelf) and then by the state manifests.
            await packTree(
                packer,
                services.workspace.root,
                "workspace/",
                {
                    carry: (relPath) => carries(workspacePortability(relPath), options.secrets),
                    enter: (relPath) => workspaceMayContain(relPath, options.secrets),
                },
                createIgnoreScope(),
            );
            // The daemon volume, filtered by its manifest alone — nothing here is .gitignore'd or junk-named,
            // and `gits/` deliberately contains the very `.git` dirs the workspace scope would have skipped.
            await packTree(packer, services.config.historyRoot, "history/", {
                carry: (relPath) => carries(historyPortability(relPath), options.secrets),
                enter: (relPath) => historyMayContain(relPath, options.secrets),
            });
            packer.finalize();
        } catch (error) {
            packer.destroy(error instanceof Error ? error : new Error(String(error)));
        }
    })();

    return Readable.toWeb(gzip) as ReadableStream<Uint8Array>;
};

// Which repos a bundle will carry git dirs for — the report's "repos" line, and the check that answers the one
// question a restored workspace lives or dies by. Read from `history/gits/` rather than from the workspace,
// because a repo whose git dir never made it is a repo the restore cannot heal.
export const bundledRepos = async (historyRoot: string): Promise<string[]> => {
    const entries = await readdir(join(historyRoot, "gits"), { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => decodeURIComponent(entry.name))
        .toSorted();
};

// The workspace-relative path of a repo's git dir inside the bundle, and its counterpart on disk. One
// derivation, used by the restorer to rewrite pointers — `relative` keeps it honest if either root moves.
export const gitDirEntryName = (historyRoot: string, absGitDir: string): string =>
    `history/${relative(historyRoot, absGitDir).replaceAll("\\", "/")}`;
