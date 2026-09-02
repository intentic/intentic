import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { type ArrivalItem, type ArrivalReport, BundleManifestSchema, type BundleManifest, type NeedsAction } from "@intentic/sandbox-contract";
import { extract, type Headers } from "tar-stream";
import { repoGitDir } from "../history/history.js";
import { resolveWithin, setWorkspaceMtime, writeStreamCounted } from "../workspace/workspace-files.js";
import { ArrivalFormatError } from "../arrival-error.js";
import { BUNDLE_MANIFEST_ENTRY } from "./bundle.js";
import { carries, historyMayContain, historyPortability, workspaceMayContain, workspacePortability } from "./classify.js";

/* A BUNDLE ARRIVING: this sandbox's own export format, taken in as a plan the owner ticks rather than as a
 * write that happens on file pick.
 *
 * THE CHANGE THIS FILE IS. Restoring used to be the one inbound door with no preview: pick a file and the
 * bytes went down, then a report explained what had already happened. It was also the most destructive of the
 * doors — a definition and a foreign setup land BESIDE what a sandbox has, a bundle lands OVER it — so the
 * arrival that most needed a checklist was the only one without one. It has one now, and the cost is a spool.
 *
 * WHY A SPOOL AND NOT MEMORY. The other sources are small: a definition is a document, a foreign home
 * directory is bounded and held in RAM precisely because it is a credential store. A bundle is a whole
 * workspace and can be tens of gigabytes, so the only way to read it twice — once to say what is in it, once
 * to write what was ticked — is to put it down. It lands on /history (never /work: see the `arrivals/` entry
 * in history-state.ts), mode 0600, and is deleted on apply, on abandon, and by the boot sweep for whatever a
 * crash left behind.
 *
 * ONE PASS PRODUCES BOTH. The upload is piped to the spool file and, simultaneously, through gunzip into a tar
 * walk that decides every entry and counts it. So the plan costs one download, one decompression and one
 * write, and by the time the owner sees the checklist the file is already on disk in full.
 *
 * EVERY DECISION IS RE-DERIVED, TWICE. The bundle is a file the owner can hand around, so what it says about
 * itself is never trusted: an entry is written because THIS daemon's manifests class its path as carryable,
 * not because some exporter packed it. The index pass and the write pass ask `classify.ts` the same questions
 * in the same order, which is what makes the counts the owner ticked describe the bytes that land.
 */

export class BundleFormatError extends ArrivalFormatError {}

// Where a bundle waits while its owner reads the plan. Beside `exports/`, which is the same volume for the
// same reasons, and never under /work.
export const arrivalsDir = (historyRoot: string): string => join(historyRoot, "arrivals");

/* WHAT THE OWNER TICKS. Three kinds of row, and the middle one is the whole reason a bundle plan is worth
 * having: a repository is a unit somebody actually wants to decline ("bring the sandbox, leave the six-gigabyte
 * monorepo"), and it is only nameable because a v3 manifest lists what it carries.
 *
 * `bundle:files`   /work, minus the repositories, plus the workspace repo's own git dir
 * `repo:<id>`      one repository: its working tree AND its real git dir, which have to move together
 * `bundle:history` transcripts, checkpoint timelines, ledgers — what no definition can ever reference
 */
const FILES_ITEM = "bundle:files";
const HISTORY_ITEM = "bundle:history";
const repoItem = (id: string): string => `repo:${id}`;

interface Placed {
    readonly item: string;
    readonly root: "workspace" | "history";
    readonly relPath: string;
}

/* Which row an entry belongs to, and where it would land. Returns undefined for an entry that is not part of
 * this format at all — a foreign tar, or a bundle whose layout moved — which the caller refuses by name.
 *
 * "root" is deliberately NOT a repository row. `/work` is a git repo of its own (the daemon's root scope) and
 * its git dir on `history/gits/root` is as much a part of the workspace as the files it tracks; offering it as
 * a separate tick would let an owner take the tree without the history that makes it a repo. */
const place = (name: string, repos: ReadonlySet<string>): Placed | undefined => {
    if (name.startsWith("workspace/")) {
        const relPath = name.slice("workspace/".length);
        // Longest match wins, so a nested id ("clients/foo") claims its own files rather than losing them to
        // a shorter id that happens to be its prefix.
        const owner = [...repos]
            .filter((id) => relPath === id || relPath.startsWith(`${id}/`))
            .toSorted((left, right) => right.length - left.length)[0];
        return { item: owner === undefined ? FILES_ITEM : repoItem(owner), root: "workspace", relPath };
    }
    if (!name.startsWith("history/")) {
        return undefined;
    }
    const relPath = name.slice("history/".length);
    if (!relPath.startsWith("gits/")) {
        return { item: HISTORY_ITEM, root: "history", relPath };
    }
    const encoded = relPath.slice("gits/".length).split("/")[0] ?? "";
    let id: string;
    try {
        id = decodeURIComponent(encoded);
    } catch {
        return undefined;
    }
    if (id === "root") {
        return { item: FILES_ITEM, root: "history", relPath };
    }
    // A git dir for a repository the manifest does not declare is exactly the tamper case this format's
    // re-derivation exists to catch: it would land a repo the plan never offered.
    return repos.has(id) ? { item: repoItem(id), root: "history", relPath } : undefined;
};

// Whether this daemon would write the entry at all, at its most permissive: the index describes what the
// bundle OFFERS, and the owner's credential choice narrows it at apply. Directory entries are judged by the
// descent rule, an empty `.intentic/records/sessions/…` is a legitimate carried directory under a credential root.
const allowed = (placed: Placed, isDirectory: boolean, secrets: boolean): boolean => {
    const relPath = isDirectory ? placed.relPath.replace(/\/$/, "") : placed.relPath;
    if (isDirectory) {
        return placed.root === "workspace" ? workspaceMayContain(relPath, secrets) : historyMayContain(relPath, secrets);
    }
    return carries(placed.root === "workspace" ? workspacePortability(relPath) : historyPortability(relPath), secrets);
};

// What one row would land, counted rather than estimated: the checklist says "4,213 files, 812 MB" because the
// index pass already walked every entry.
interface Tally {
    files: number;
    bytes: number;
}

export interface BundleIndex {
    readonly manifest: BundleManifest;
    readonly tallies: ReadonlyMap<string, Tally>;
    readonly refused: readonly string[];
}

export interface HeldBundle {
    readonly spool: string;
    readonly index: BundleIndex;
}

const sizeLabel = (bytes: number): string => {
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const countLabel = (tally: Tally | undefined): string =>
    tally === undefined ? "nothing" : `${tally.files.toLocaleString()} file${tally.files === 1 ? "" : "s"}, ${sizeLabel(tally.bytes)}`;

/* Walk a bundle's entries, handing each one to `visit`. The shape both passes share, so the plan cannot
 * describe a different bundle than the one the apply writes: the manifest is read here, the placement and the
 * allow check happen here, and the caller only decides what to DO with an entry it is given. */
const walkBundle = async (
    source: Readable,
    onManifest: (manifest: BundleManifest) => void,
    visit: (placed: Placed, header: Headers, stream: Readable, refuse: (name: string) => void) => Promise<void>,
): Promise<void> => {
    const ex = extract();
    let manifest: BundleManifest | undefined;
    let repos: ReadonlySet<string> = new Set();

    const drain = (stream: Readable): Promise<void> =>
        new Promise((resolve, reject) => {
            stream.on("end", resolve);
            stream.on("error", reject);
            stream.resume();
        });

    const readEntry = (stream: Readable): Promise<Buffer> =>
        new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", reject);
        });

    const refused: string[] = [];
    const refuse = (name: string): void => void refused.push(name);

    const handleEntry = async (header: Headers, stream: Readable): Promise<void> => {
        if (header.name === BUNDLE_MANIFEST_ENTRY) {
            const parsed = BundleManifestSchema.safeParse(JSON.parse((await readEntry(stream)).toString("utf8")));
            if (!parsed.success) {
                throw new BundleFormatError("the bundle manifest is not readable by this daemon");
            }
            manifest = parsed.data;
            repos = new Set(parsed.data.repos);
            onManifest(parsed.data);
            return;
        }
        // The manifest is the first entry a packer writes; anything before it means this is not our format (or
        // it was repacked), and deciding entries without it would mean deciding them blind.
        if (manifest === undefined) {
            throw new BundleFormatError(`expected ${BUNDLE_MANIFEST_ENTRY} first: this does not look like an intentic environment bundle`);
        }
        const placed = place(header.name, repos);
        if (placed === undefined || !allowed(placed, header.type === "directory", true)) {
            refuse(header.name);
            await drain(stream);
            return;
        }
        await visit(placed, header, stream, refuse);
    };

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
         * upload is not a bundle", which is a 400, reported as one rather than escaping as an unhandled throw
         * the route turns into a 500 and the owner reads as "the sandbox broke".
         *
         * Failures of `handleEntry` propagate UNCHANGED, because they are a different class entirely: a full
         * disk, a permission error, or the size cap (UploadTooLargeError → 413). Converting those to a format
         * error would blame the bundle for the sandbox's own problem. */
        const failDecode = (error: unknown): void =>
            fail(new BundleFormatError(`the archive could not be read: it is not a gzipped intentic environment bundle (${String(error)})`));
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
    refusedOut.set(source, refused);
};

// The refused list is the walk's, not the caller's, and a WeakMap keyed on the source keeps it off the
// signature of a function whose two callers want it at different moments.
const refusedOut = new WeakMap<Readable, string[]>();

/* Put the upload down and learn what is in it, in one pass over the network stream.
 *
 * The tee is what makes it one pass: `source.pipe()` to two destinations feeds the spool file and the tar walk
 * from the same bytes, with backpressure the slower of the two. A first cut spooled first and indexed after,
 * which read the whole bundle off disk a second time for nothing.
 */
export const spoolBundle = async (body: ReadableStream<Uint8Array>, historyRoot: string, limit: number): Promise<HeldBundle> => {
    await mkdir(arrivalsDir(historyRoot), { recursive: true });
    const spool = join(arrivalsDir(historyRoot), `${randomUUID()}.tar.gz`);

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    const gunzip = createGunzip();
    // Mode 0600 like every other credential-bearing file the daemon writes: a bundle exported WITH secrets is
    // exactly that, and it sits here for as long as the owner takes to read a checklist.
    const toDisk = createWriteStream(spool, { mode: 0o600 });
    source.pipe(gunzip);
    const written = pipeline(source, toDisk);

    let manifest: BundleManifest | undefined;
    const tallies = new Map<string, Tally>();
    let remaining = limit;
    try {
        await walkBundle(
            gunzip,
            (parsed) => {
                manifest = parsed;
            },
            async (placed, header, stream) => {
                if (header.type === "file") {
                    const tally = tallies.get(placed.item) ?? { files: 0, bytes: 0 };
                    tally.files += 1;
                    tally.bytes += header.size ?? 0;
                    remaining -= header.size ?? 0;
                    tallies.set(placed.item, tally);
                }
                await new Promise<void>((resolve, reject) => {
                    stream.on("end", resolve);
                    stream.on("error", reject);
                    stream.resume();
                });
            },
        );
        await written;
    } catch (error) {
        await rm(spool, { force: true });
        throw error;
    }
    if (manifest === undefined || remaining < 0) {
        await rm(spool, { force: true });
        throw new BundleFormatError(
            manifest === undefined ? "the archive carried no bundle manifest" : "that bundle unpacks to more than this sandbox accepts in one upload",
        );
    }
    return { spool, index: { manifest, tallies, refused: refusedOut.get(gunzip) ?? [] } };
};

// The checklist. Rows for what the tar actually holds, in the order they land: the workspace tree first (a
// repo unpacked before it would sit under files that were not there yet), then the repositories, then history.
export const bundleItems = (index: BundleIndex): ArrivalItem[] => {
    const row = (id: string, group: ArrivalItem["group"], label: string, detail: string): ArrivalItem | undefined => {
        const tally = index.tallies.get(id);
        return tally === undefined
            ? undefined
            : { id, group, label, detail: `${detail} — ${countLabel(tally)}`, applicable: true, recommended: true, secrets: [] };
    };
    return [
        row(FILES_ITEM, "files", "Workspace files", "Everything in /work that is not one of the repositories below, and the workspace repo's own history"),
        ...index.manifest.repos.toSorted().flatMap((id) => {
            const item = row(repoItem(id), "repo", `Repository ${id}`, "Its working tree and its full git history");
            return item === undefined ? [] : [item];
        }),
        row(HISTORY_ITEM, "history", "Sandbox history", "Transcripts, checkpoint timelines and ledgers, the part nothing else can reproduce"),
    ].filter((item): item is ArrivalItem => item !== undefined);
};

/* The action list: what a bundle cannot carry, plus what the owner's export-time choice already cost. Ordered
 * by what blocks the most — the image first (until it is rebuilt the sandbox is missing every tool the overlay
 * installs), then credentials, then identity. */
export const bundleActions = (manifest: BundleManifest, includeSecrets: boolean): NeedsAction[] => {
    const actions: NeedsAction[] = [];
    if (manifest.definition.environment.dockerfile !== undefined) {
        actions.push({
            subject: "Rebuild the environment image",
            detail: "The overlay Dockerfile travels, but the IMAGE it describes is built outside the container. Open the Environment card and run the rebuild command it shows; until then this sandbox is on the stock image and none of the tools the overlay installs are present.",
        });
    }
    // Two ways to arrive without credentials, and they are different facts: the bundle never held them, or it
    // held them and the owner declined to take them. Both leave the same connections keyless, so both are said.
    const withoutSecrets = !manifest.secrets || !includeSecrets;
    if (withoutSecrets && manifest.definition.capabilities.length > 0) {
        actions.push({
            subject: "Reconnect capabilities",
            detail: `${manifest.secrets ? "Taken in without credentials" : "Exported without secrets"}, so each connection arrived listed but unauthenticated. Open these on the Capabilities view and re-enter the credential each one asks for: ${manifest.definition.capabilities.map((capability) => `${capability.id} (${capability.kind})`).join(", ")}.`,
        });
    }
    if (withoutSecrets && manifest.definition.secrets.length > 0) {
        actions.push({
            subject: "Enter secret values",
            detail: `Secret names travel, values did not. Store values for: ${manifest.definition.secrets.join(", ")}.`,
        });
    }
    for (const entry of manifest.excluded) {
        if (entry.note !== undefined) {
            actions.push({ subject: entry.path, detail: entry.note });
        }
    }
    return actions;
};

/* THE HEAL. A repo's in-tree `.git` is a POINTER FILE naming its real git dir on /history (see
 * git/repo-git-dirs.ts for the invariant that forces it), and that path is ABSOLUTE. The bundle carries both
 * halves, but the pointer it carries was written for the SOURCE sandbox's historyRoot, so on a target whose
 * HISTORY_ROOT differs, every pointer names a directory that does not exist and every git command in the
 * arrived workspace answers `fatal: not a git repository`.
 *
 * Rewriting them is the whole difference between an arrived workspace and a pile of files. It is cheap and it
 * is idempotent: the pointer is one line, and re-running on an already-correct tree writes the same line.
 *
 * The root repo is included deliberately, `/work/.git` is a pointer too, and `ensureRootRepo` heals only a
 * MISSING one. Over a dangling pointer, `git init --separate-git-dir` refuses outright (verified: exit 128,
 * "not a git repository"), so boot convergence cannot rescue this and the arrival has to.
 */
const healGitPointers = async (workspaceRoot: string, historyRoot: string, landed: ReadonlySet<string>): Promise<string[]> => {
    const healed: string[] = [];
    const gitsDir = join(historyRoot, "gits");
    const present = new Set((await readdir(gitsDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name));
    for (const repo of landed) {
        if (!present.has(encodeURIComponent(repo))) {
            continue;
        }
        const pointer = repo === "root" ? join(workspaceRoot, ".git") : join(workspaceRoot, repo, ".git");
        await writeFile(pointer, `gitdir: ${repoGitDir(historyRoot, repo)}\n`);
        healed.push(repo);
    }
    return healed;
};

/* Write the ticked rows out of the spooled bundle. Every safety the index pass applied is applied again here,
 * from the same functions, plus the one decision the index could not make: whether the owner consented to the
 * credential VALUES this bundle carries.
 */
export const applyBundle = async (
    held: HeldBundle,
    roots: { readonly workspaceRoot: string; readonly historyRoot: string },
    selection: { readonly items: readonly string[]; readonly includeSecrets: boolean },
    limit: number,
): Promise<ArrivalReport> => {
    const wanted = new Set(selection.items);
    const applied: ArrivalReport["applied"] = [];
    const failed: ArrivalReport["failed"] = [];
    const refused: string[] = [...held.index.refused];
    // Which rows actually put bytes down, so the report counts rows rather than claiming every ticked one
    // landed, and so the heal runs for exactly the repositories that arrived.
    const landed = new Set<string>();
    let remaining = limit;
    let withheld = 0;

    // One entry to one path. Split out of the visitor because the visitor's own job is the three DECISIONS
    // above it (ticked? consented to? inside the root?) and putting the four write shapes in the same function
    // buried them.
    const writeEntry = async (target: string, header: Headers, stream: Readable): Promise<void> => {
        if (header.type === "directory") {
            await mkdir(target, { recursive: true });
            return;
        }
        await mkdir(dirname(target), { recursive: true });
        if (header.type === "symlink") {
            // An arrival runs onto a fresh sandbox, but the daemon's own boot has already converged some of
            // these paths; replacing rather than failing keeps it idempotent.
            await rm(target, { force: true });
            await symlink(header.linkname ?? "", target);
            return;
        }
        remaining -= await writeStreamCounted(stream, target, () => remaining);
        if (header.mtime !== undefined) {
            await setWorkspaceMtime(target, header.mtime.getTime());
        }
        // The mode is what the generic folder-drop path loses: every entry it writes gets the default, so an
        // arrived `+x` script is no longer executable. Best-effort, a chmod failure must not fail a write.
        if (header.mode !== undefined) {
            await chmod(target, header.mode & 0o7777).catch(() => {});
        }
    };

    await walkBundle(
        createReadStream(held.spool).pipe(createGunzip()),
        () => {},
        async (placed, header, stream, refuse) => {
            const skip = (): Promise<void> =>
                new Promise((resolve, reject) => {
                    stream.on("end", resolve);
                    stream.on("error", reject);
                    stream.resume();
                });
            if (!wanted.has(placed.item)) {
                return skip();
            }
            /* THE SECOND CONSENT, applied where the bytes are: a credential-classed path is written only when
             * the owner said so on the way IN. It used to be decided on the way out, at export, by whoever
             * packed the file — which is the wrong person and the wrong moment for the sandbox receiving it. */
            if (!allowed(placed, header.type === "directory", selection.includeSecrets)) {
                withheld += 1;
                return skip();
            }
            const target = resolveWithin(placed.root === "workspace" ? roots.workspaceRoot : roots.historyRoot, placed.relPath);
            if (target === undefined) {
                refuse(header.name);
                return skip();
            }
            // Sockets, fifos and device nodes have no meaning on the other side of an arrival.
            if (header.type !== "directory" && header.type !== "symlink" && header.type !== "file") {
                return skip();
            }
            await writeEntry(target, header, stream);
            landed.add(placed.item);
        },
    );

    const repos = [...landed].flatMap((item) => (item.startsWith("repo:") ? [item.slice("repo:".length)] : []));
    // The workspace repo's own pointer is healed with the workspace files, because that is the row its git dir
    // travelled under; see `place`.
    const healed = await healGitPointers(roots.workspaceRoot, roots.historyRoot, new Set(landed.has(FILES_ITEM) ? [...repos, "root"] : repos));
    for (const item of bundleItems(held.index)) {
        if (!wanted.has(item.id)) {
            continue;
        }
        if (landed.has(item.id)) {
            applied.push({ id: item.id, group: item.group, label: item.label });
        } else {
            failed.push({ id: item.id, label: item.label, error: "nothing in the bundle was writable under this heading" });
        }
    }
    const needsAction = bundleActions(held.index.manifest, selection.includeSecrets);
    if (withheld > 0) {
        needsAction.push({
            subject: "Credentials stayed in the file",
            detail: `Taken in without credentials, so ${withheld} credential-bearing entr${withheld === 1 ? "y" : "ies"} were skipped: provider logins, browser sessions and stored keys. Re-run the arrival with credentials on, or enter them by hand.`,
        });
    }
    if (healed.length > 0) {
        needsAction.push({
            subject: "Repositories re-pointed",
            detail: `Their real git directories arrived on this sandbox's own history volume and each working tree now points at it: ${healed.join(", ")}.`,
        });
    }
    return { applied, failed, refused, needsAction };
};

// Drop one spool. Called on apply, on abandon, and by the boot sweep — the same one-line operation each time,
// so a crash mid-review leaves nothing a later boot cannot clear.
export const dropSpool = (spool: string): Promise<void> => rm(spool, { force: true });

/* Whatever a crash left behind. A spool only ever outlives the daemon that wrote it, so on boot every file in
 * the directory is by definition abandoned: nothing holds a token across a restart, and the owner re-reads. */
export const sweepArrivals = async (historyRoot: string): Promise<void> => {
    await rm(arrivalsDir(historyRoot), { recursive: true, force: true });
};
