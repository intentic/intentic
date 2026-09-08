import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { type BundleManifest, HISTORY_STATE_FILES, WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import { pack, type Pack } from "tar-stream";
import type { Services } from "../composition.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { carries, historyMayContain, historyPortability, workspaceMayContain, workspacePortability } from "./classify.js";
import { deriveDefinition } from "./definition.js";

// Packs a gzipped tar of the sandbox's two volumes, driven by the state manifests so adding a store is what adds it to
// the bundle.
// - intentic-bundle.json: the manifest, written first so a reader knows the shape before the bytes
// - workspace/…: /work, minus ignored junk and minus what the manifests mark identity/derived/secret
// - history/…: the portable slice of /history, including every repo's real git dir (gits/…)
// Streamed file-by-file, one handle at a time; modes and symlinks are preserved, unlike /workspace/upload-archive.

export const BUNDLE_MANIFEST_ENTRY = "intentic-bundle.json";

// Pack one file, streaming its bytes; `size` must be exact or tar-stream throws, so it comes from the same lstat that
// decided this was a file.
const packFile = (packer: Pack, name: string, absPath: string, size: number, mode: number, mtime: Date): Promise<void> =>
    new Promise((resolve, reject) => {
        const entry = packer.entry({ name, size, mode, mtime, type: "file" }, (error) => (error === null ? resolve() : reject(error)));
        createReadStream(absPath).on("error", reject).pipe(entry);
    });

const packSymlink = (packer: Pack, name: string, linkname: string): Promise<void> =>
    new Promise((resolve, reject) => {
        packer.entry({ name, linkname, type: "symlink" }, (error) => (error === null ? resolve() : reject(error)));
    });

// Depth-first walk; `decide` gates every entry, and totals come back for the report. A directory is packed only when
// empty — one with files inside is implied by their paths, and the restorer creates parents anyway.
const packTree = async (
    packer: Pack,
    root: string,
    prefix: string,
    // Two questions, not one: `carry` decides a file, `enter` whether to look inside a directory.
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
        // An empty directory that survived every filter is content in its own right, and needs an explicit entry.
        if (!wrote && relDir !== "") {
            packer.entry({ name: `${prefix}${relDir}/`, type: "directory" }).end();
        }
        return wrote;
    };

    await walk(root, "", scope);
    return { files, bytes };
};

// The manifest's `excluded` list, derived from the same tables the walk consults, so it can never describe a different
// bundle than the one written.
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

// One credential sweep, best-effort in both directions: a seam that throws (a fake never given this member) becomes a
// caught rejection, so an export can never fail while protecting itself.
const sweptOut = async (run: () => Promise<readonly string[]>): Promise<void> => {
    try {
        await run();
    } catch {
        // Deliberately silent: classification already keeps an unswept file out of a secrets-off bundle.
    }
};

// `secrets` is the owner's export-dialog choice, the only thing that varies what's packed; everything else follows the
// manifests. `now` is injected so the manifest is deterministic under test.
export const packBundle = (services: Services, options: { readonly secrets: boolean; readonly now: number }): ReadableStream<Uint8Array> => {
    const packer = pack();
    const gzip = createGzip();
    packer.pipe(gzip);

    void (async () => {
        try {
            // Capability manifests and settings `carry` now only while nothing has rewritten a credential into them
            // since boot; an agent session can. Swept first, or "without secrets" is broken by the bytes, not the
            // classification.
            await Promise.all([sweptOut(() => services.vaultManifestSecrets()), sweptOut(() => services.vaultExtensionSettingSecrets())]);
            // Manifest embeds the same definition GET /definition emits, so a bundle is definition + state. `repos` is
            // the same list the pack below is filtered by, so the manifest and the tar can never disagree about what's
            // inside.
            const manifest: BundleManifest = {
                version: 3,
                ...(services.config.sandbox.name === "" ? {} : { sandbox: { name: services.config.sandbox.name } }),
                createdAt: options.now,
                secrets: options.secrets,
                repos: (await discoverRepos(services.workspace.root)).toSorted(),
                definition: (await deriveDefinition(services)).definition,
                excluded: excludedEntries(options.secrets),
            };
            const body = Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`);
            packer.entry({ name: BUNDLE_MANIFEST_ENTRY, size: body.byteLength, type: "file" }).end(body);

            // Workspace filtered first by the tree view's own ignore rules, then by the state manifests.
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
            // History filtered by its manifest alone; `gits/` holds the .git dirs the workspace scope would skip.
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
