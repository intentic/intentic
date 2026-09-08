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
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { writeStreamCounted } from "../workspace/files/workspace-files-upload.js";
import { setWorkspaceMtime } from "../workspace/files/workspace-files.js";
import { ArrivalFormatError } from "../arrival-error.js";
import { drain, extractAll } from "../tar-extract.js";
import { BUNDLE_MANIFEST_ENTRY } from "./bundle.js";
import { carries, historyMayContain, historyPortability, workspaceMayContain, workspacePortability } from "./classify.js";
import { sizeLabel } from "@intentic/base/format";

// Bundle arrival: this sandbox's own export format, taken in as a preview-first plan instead of the old write-on-pick
// restore. Spooled to /history, never memory, since a bundle can be tens of gigabytes; one pass writes the spool and
// indexes it together. Every entry is re-derived from classify.ts, never trusted from what the bundle claims.

export class BundleFormatError extends ArrivalFormatError {}

// Beside `exports/`, same volume for the same reasons; never under /work.
export const arrivalsDir = (historyRoot: string): string => join(historyRoot, "arrivals");

// Three rows the owner ticks; the repo row is why a bundle plan is worth having, since a repository is a unit somebody
// may decline.
// - bundle:files: /work minus its repositories, plus the workspace repo's own git dir
// - repo:<id>: one repository's working tree and its real git dir, which move together
// - bundle:history: transcripts, checkpoints, ledgers — nothing a definition can reference
const FILES_ITEM = "bundle:files";
const HISTORY_ITEM = "bundle:history";
const repoItem = (id: string): string => `repo:${id}`;

interface Placed {
    readonly item: string;
    readonly root: "workspace" | "history";
    readonly relPath: string;
}

// Maps an entry to its row and destination; undefined means it's not part of this format (caller refuses it by name).
// `root` isn't its own repo row: /work's git dir is as much part of the workspace as its files.
const place = (name: string, repos: ReadonlySet<string>): Placed | undefined => {
    if (name.startsWith("workspace/")) {
        const relPath = name.slice("workspace/".length);
        // Longest match wins, so a nested id ("clients/foo") claims its own files over a shorter prefix id.
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
    // A git dir for an undeclared repository is exactly the tamper case re-derivation exists to catch.
    return repos.has(id) ? { item: repoItem(id), root: "history", relPath } : undefined;
};

// Whether this daemon would write the entry at all, at its most permissive: the index describes what the bundle offers,
// and the owner's credential choice narrows it later, at apply.
const allowed = (placed: Placed, isDirectory: boolean, secrets: boolean): boolean => {
    const relPath = isDirectory ? placed.relPath.replace(/\/$/, "") : placed.relPath;
    if (isDirectory) {
        return placed.root === "workspace" ? workspaceMayContain(relPath, secrets) : historyMayContain(relPath, secrets);
    }
    return carries(placed.root === "workspace" ? workspacePortability(relPath) : historyPortability(relPath), secrets);
};

// What one row would land, counted by the index pass rather than estimated.
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

const countLabel = (tally: Tally | undefined): string =>
    tally === undefined ? "nothing" : `${tally.files.toLocaleString()} file${tally.files === 1 ? "" : "s"}, ${sizeLabel(tally.bytes)}`;

// Walks a bundle's entries for `visit`; both passes share this shape, so the plan can never describe a different bundle
// than the one applied — placement and the allow check happen here, not per caller.
const walkBundle = async (
    source: Readable,
    onManifest: (manifest: BundleManifest) => void,
    visit: (placed: Placed, header: Headers, stream: Readable, refuse: (name: string) => void) => Promise<void>,
): Promise<void> => {
    const ex = extract();
    let manifest: BundleManifest | undefined;
    let repos: ReadonlySet<string> = new Set();

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
        // Manifest must be the first entry written; anything else means this isn't the format, or was repacked.
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

    // Decoder failures mean the upload isn't a bundle: a 400, not an unhandled 500. `handleEntry` failures propagate
    // unchanged, since a full disk or the size cap is this sandbox's problem, not the bundle's.
    await extractAll(
        source,
        ex,
        handleEntry,
        (error) => new BundleFormatError(`the archive could not be read: it is not a gzipped intentic environment bundle (${String(error)})`),
    );

    if (manifest === undefined) {
        throw new BundleFormatError("the archive carried no bundle manifest");
    }
    refusedOut.set(source, refused);
};

// The walk's refusals, kept off the signature via a WeakMap since callers read it at different moments.
const refusedOut = new WeakMap<Readable, string[]>();

// Spools the upload and indexes it in one pass: `pipe()` to both the spool file and the tar walk shares one read of the
// network stream, instead of indexing then re-reading the whole bundle off disk.
export const spoolBundle = async (body: ReadableStream<Uint8Array>, historyRoot: string, limit: number): Promise<HeldBundle> => {
    await mkdir(arrivalsDir(historyRoot), { recursive: true });
    const spool = join(arrivalsDir(historyRoot), `${randomUUID()}.tar.gz`);

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    const gunzip = createGunzip();
    // Mode 0600 like every credential-bearing file this daemon writes; a bundle with secrets is exactly that.
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

// Checklist rows in landing order: workspace tree first (a repo unpacked before it would land under files not there
// yet), then repositories, then history.
export const bundleItems = (index: BundleIndex): ArrivalItem[] => {
    const row = (id: string, group: ArrivalItem["group"], label: string, detail: string): ArrivalItem | undefined => {
        const tally = index.tallies.get(id);
        return tally === undefined
            ? undefined
            : { id, group, label, detail: `${detail} — ${countLabel(tally)}`, applicable: true, recommended: true, secrets: [] };
    };
    return [
        row(
            FILES_ITEM,
            "files",
            "Workspace files",
            "Everything in /work that is not one of the repositories below, and the workspace repo's own history",
        ),
        ...index.manifest.repos.toSorted().flatMap((id) => {
            const item = row(repoItem(id), "repo", `Repository ${id}`, "Its working tree and its full git history");
            return item === undefined ? [] : [item];
        }),
        row(HISTORY_ITEM, "history", "Sandbox history", "Transcripts, checkpoint timelines and ledgers, the part nothing else can reproduce"),
    ].filter((item): item is ArrivalItem => item !== undefined);
};

// What a bundle can't carry, plus what the export-time choice cost, ordered by what blocks the most: the image, then
// credentials, then identity.
export const bundleActions = (manifest: BundleManifest, includeSecrets: boolean): NeedsAction[] => {
    const actions: NeedsAction[] = [];
    if (manifest.definition.environment.dockerfile !== undefined) {
        actions.push({
            subject: "Rebuild the environment image",
            detail: "The overlay Dockerfile travels, but the IMAGE it describes is built outside the container. Open the Environment card and run the rebuild command it shows; until then this sandbox is on the stock image and none of the tools the overlay installs are present.",
        });
    }
    // Two distinct facts, same result: the bundle never held credentials, or the owner declined to take them.
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

// A repo's `.git` points at its real dir on /history by absolute path — the source sandbox's path, rewritten here for
// the target. Includes `root`: /work/.git is a pointer too, and boot convergence can't heal a dangling one.
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

// Writes the ticked rows from the spooled bundle, re-applying every safety the index pass used, plus the one thing the
// index couldn't decide: whether the owner consented to this bundle's credential values.
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
    // Rows that actually put bytes down, so the report counts landed rows, not ticked ones.
    const landed = new Set<string>();
    let remaining = limit;
    let withheld = 0;

    // One entry to one path, split out of the visitor so its three decisions (ticked? consented? inside the root?)
    // aren't buried beside the four write shapes.
    const writeEntry = async (target: string, header: Headers, stream: Readable): Promise<void> => {
        if (header.type === "directory") {
            await mkdir(target, { recursive: true });
            return;
        }
        await mkdir(dirname(target), { recursive: true });
        if (header.type === "symlink") {
            // Boot has already converged some of these paths; replacing rather than failing keeps this idempotent.
            await rm(target, { force: true });
            await symlink(header.linkname ?? "", target);
            return;
        }
        remaining -= await writeStreamCounted(stream, target, () => remaining);
        if (header.mtime !== undefined) {
            await setWorkspaceMtime(target, header.mtime.getTime());
        }
        // The mode a folder-drop would lose to its own default; best-effort, so a chmod failure can't fail the write.
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
            // Second consent: writes a credential path only if the owner allowed it coming in, not whoever packed it.
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
    // Workspace repo's pointer heals with the workspace files, the row its git dir travels under (see `place`).
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

// Called on apply, abandon and the boot sweep alike, so a crash mid-review leaves nothing boot can't clear.
export const dropSpool = (spool: string): Promise<void> => rm(spool, { force: true });

// Whatever a crash left behind: a spool never outlives its daemon, so everything in the directory on boot is abandoned
// by definition.
export const sweepArrivals = async (historyRoot: string): Promise<void> => {
    await rm(arrivalsDir(historyRoot), { recursive: true, force: true });
};
