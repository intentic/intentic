import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { errorMessage, isMissing, undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { STATE_DIR } from "@intentic/constants";
import { diffPowers, type ExtensionManifest, extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionDev } from "@intentic/sandbox-contract";
import { isPublicPath, isReferencePath } from "@intentic/workspace-ignore";
import { z } from "zod";
import { extensionRootOf, parseExtensionManifest } from "../capabilities/extension-dirs.js";
import { opt } from "../opt.js";
import { stateRelPath } from "../state-paths.js";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { powersDigest } from "./extension-approvals.js";

/* Dev mode: an extension installed from a repository, served from a source checkout instead of its pinned clone under
 * .intentic/local/extensions/<id>. The clone is shared live by every conversation, never reviewed and replaced by the
 * next update, yet it was the only copy whose edits the owner saw on reload, so agents edited it. A pointer here makes
 * the checkout the fast path instead: the inventory (installed-extensions.ts) serves `dir` from it, and everything that
 * reads `dir` (bundle, backend, processes, skills, contributions) follows.
 *
 * Same extension, same powers, or the pinned copy keeps running: the checkout is agent-writable, and the owner approved
 * the powers of the pinned version only. What it may differ in is code, which is the point. */

const PointerSchema = z.object({
    // Absolute, as the daemon sees it: the workspace's own checkout, or a conversation's copy under the worktrees root.
    path: z.string(),
    // The conversation whose copy it is, when the pointer was set from an isolated turn.
    conversation: z.string().optional(),
    // The conversation whose shell pointed the install here, which only it (or the owner, from the Extensions tab) may then
    // reload, clear or replace; absent when the owner set it, or the caller named no conversation.
    setBy: z.string().optional(),
    setAt: z.string(),
    // Bumped by a reload, which is what tells an open app the list changed.
    reloadedAt: z.string().optional(),
});
export type ExtensionDevPointer = z.infer<typeof PointerSchema>;

// Keyed by capability id: dev mode is about one install, not the identity a remove/re-add carries over.
const FileSchema = z.record(z.string(), PointerSchema);
type DevFile = z.infer<typeof FileSchema>;

export const extensionDevDocument = defineDocument({ path: stateRelPath(".intentic/local/extension-dev.json"), schema: FileSchema });

const devFile = (root: string): JsonFile<DevFile> =>
    openDocument(extensionDevDocument, join(root, extensionDevDocument.path), { fallback: () => ({}) });

export const readExtensionDev = async (root: string): Promise<DevFile> => devFile(root).read();

export const writeExtensionDev = async (root: string, id: string, pointer: ExtensionDevPointer): Promise<void> => {
    await devFile(root).update((all) => ({ ...all, [id]: pointer }));
};

// Whether there was a pointer to drop.
export const forgetExtensionDev = async (root: string, id: string): Promise<boolean> => {
    let had = false;
    await devFile(root).update((all) => {
        if (!(id in all)) {
            // By reference, so the write is skipped when there is nothing to drop.
            return all;
        }
        had = true;
        const { [id]: _dropped, ...rest } = all;
        return rest;
    });
    return had;
};

export const touchExtensionDev = async (root: string, id: string, at: string): Promise<void> => {
    await devFile(root).update((all) => {
        const pointer = all[id];
        return pointer === undefined ? all : { ...all, [id]: { ...pointer, reloadedAt: at } };
    });
};

// Where every conversation's isolated copy of the workspace lives: <historyRoot>/worktrees/<conversation>/, laid out
// like the workspace (conversations-slice.ts builds the worktrees module on the same join).
export const worktreesRootOf = (historyRoot: string): string => join(historyRoot, "worktrees");

// Where a checkout sits, told the way a person names it: relative to the workspace, or to one conversation's copy.
export interface DevPlace {
    readonly path: string;
    readonly conversation?: string;
}

// Inside a tree root and not one of the places that hold no source: the sandbox's own state (the pinned clone itself
// among it), the read-only reference shelf, the outbox.
const placeIn = (base: string, real: string): string | undefined => {
    const rel = relative(base, real);
    if (rel.startsWith("..") || rel.startsWith(sep)) {
        return undefined;
    }
    return rel.split(sep).join("/");
};

// A root not there yet (no conversation has had a worktree) holds no place.
const resolvedRoot = (path: string): Promise<string | undefined> => realpath(path).catch(undefinedIfMissing);

// Where a real path sits, or why it is no place to run an extension from.
const placeOf = async (roots: DevRoots, real: string): Promise<DevPlace | { readonly refused: string }> => {
    const workspace = await resolvedRoot(roots.root);
    const inWorkspace = workspace === undefined ? undefined : placeIn(workspace, real);
    let place: DevPlace | undefined;
    if (inWorkspace !== undefined) {
        place = { path: inWorkspace };
    } else {
        const worktrees = await resolvedRoot(worktreesRootOf(roots.historyRoot));
        const inWorktrees = worktrees === undefined ? undefined : placeIn(worktrees, real);
        const [conversation, ...rest] = (inWorktrees ?? "").split("/");
        if (inWorktrees !== undefined && conversation !== undefined && conversation !== "") {
            place = { path: rest.join("/"), conversation };
        }
    }
    if (place === undefined) {
        return { refused: `${real} is outside the workspace` };
    }
    const where = displayOf(place);
    if (place.path === STATE_DIR || place.path.startsWith(`${STATE_DIR}/`)) {
        return { refused: `${where} is inside ${STATE_DIR}/, which holds the sandbox's own state (the pinned copy among it), not source` };
    }
    if (isReferencePath(place.path)) {
        return { refused: `${where} is on the read-only reference shelf` };
    }
    if (isPublicPath(place.path)) {
        return { refused: `${where} is in the outbox, not a source checkout` };
    }
    return place;
};

// The place in words, for a sentence: "extensions/maintenance", or "extensions/maintenance in conversation <id>".
export const displayOf = (place: DevPlace): string => {
    const path = place.path === "" ? "the workspace root" : place.path;
    return place.conversation === undefined ? path : `${path} in conversation ${place.conversation}`;
};

// What a check needs to know about the sandbox: the workspace, and the history root the worktrees live under.
export interface DevRoots {
    readonly root: string;
    readonly historyRoot: string;
}

// Whether a path, once every link on it is followed, is still inside `base` (itself already resolved).
const staysWithin = async (base: string, path: string): Promise<boolean> => {
    const resolved = await realpath(path).catch(() => undefined);
    return resolved !== undefined && placeIn(base, resolved) !== undefined;
};

const listed = (items: readonly string[]): string => items.join("; ");

// Whether a checkout can stand in for an install, and the manifest it runs with if so. `fatal` marks a pointer that
// names nothing usable at all (gone, elsewhere, another extension), which the route refuses to write; the rest (not built
// yet, different powers) are states the work in the checkout gets out of, so they are written and held.
export type DevCheck =
    | { readonly dir: string; readonly manifest: ExtensionManifest; readonly place: DevPlace; readonly checkout: string }
    | { readonly held: string; readonly fatal: boolean; readonly place?: DevPlace; readonly checkout?: string };

export const checkDevCheckout = async (
    roots: DevRoots,
    path: string,
    pinned: ExtensionManifest,
    configPath: string | undefined,
): Promise<DevCheck> => {
    let real: string;
    try {
        real = await realpath(path);
    } catch (error) {
        // Gone is what this is for; a checkout that cannot be read holds the pinned copy just the same, saying why.
        return { held: isMissing(error) ? `the checkout at ${path} is gone` : `the checkout at ${path} cannot be read: ${errorMessage(error)}`, fatal: true };
    }
    const place = await placeOf(roots, real);
    if ("refused" in place) {
        return { held: place.refused, fatal: true };
    }
    const where = displayOf(place);
    const dir = extensionRootOf(real, configPath);
    const parsed = await parseExtensionManifest(dir);
    if ("error" in parsed) {
        return { held: `${where} is not a checkout of this extension: ${parsed.error}`, fatal: true, place, checkout: real };
    }
    const id = extensionIdOf(pinned);
    const found = extensionIdOf(parsed.manifest);
    if (found !== id) {
        return { held: `${where} holds ${found}, not ${id}`, fatal: true, place, checkout: real };
    }
    if (powersDigest(parsed.manifest) !== powersDigest(pinned)) {
        const diff = diffPowers(pinned, parsed.manifest);
        const asks =
            diff.added.length > 0 ? `asks for more than the pinned version: ${listed(diff.added)}` : `no longer declares: ${listed(diff.removed)}`;
        return {
            held: `${where} ${asks}. Its powers must match the installed version's; new ones are approved by updating the installed extension`,
            fatal: false,
            place,
            checkout: real,
        };
    }
    for (const bundle of [parsed.manifest.entry, parsed.manifest.server]) {
        if (bundle !== undefined && !(await pathExists(join(dir, bundle)))) {
            return { held: `${where} is not built yet (${bundle} is missing): run its build there`, fatal: false, place, checkout: real };
        }
        // The checkout is agent-writable, and the daemon reads (and serves) the bundle through any link: one that leaves
        // the checkout would hand out whatever the daemon can read.
        if (bundle !== undefined && !(await staysWithin(real, join(dir, bundle)))) {
            return {
                held: `${where} has a bundle (${bundle}) that leaves the checkout: a bundle must be a file inside it`,
                fatal: false,
                place,
                checkout: real,
            };
        }
    }
    return { dir, manifest: parsed.manifest, place, checkout: real };
};

// What the inventory attaches to an install with a pointer: where it points, and why the pinned copy still runs if it
// does.
export interface InstalledDev {
    // The checkout root, resolved (the pointer's own path when it no longer resolves).
    readonly checkout: string;
    readonly place?: DevPlace;
    readonly held?: string;
}

// The browser bundle's fingerprint, short: what a screen compares to tell the copy it loaded is behind a rebuild.
export const bundleRevisionOf = async (dir: string, entry: string | undefined): Promise<string | undefined> => {
    if (entry === undefined) {
        return undefined;
    }
    // A bundle not built yet has no revision; any other refusal reaches the caller.
    const bytes = await readFile(join(dir, entry)).catch(undefinedIfMissing);
    return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex").slice(0, 12);
};

// A runner of its own so the count is never a cached reading: a rebuilt dist/ is under an ignored directory name, so
// no watcher tells a cache it moved.
const uncachedGit: GitRunner = (dir, args, env) => defaultGit(dir, args, env);

const uncommittedIn = async (checkout: string, git: GitRunner): Promise<number | undefined> => {
    try {
        const { stdout } = await git(checkout, ["--no-optional-locks", "status", "--porcelain", "-uall"]);
        return stdout.split("\n").filter((line) => line.trim() !== "").length;
    } catch {
        // allow(silent-catch): not a repository, or git could not read it; the row simply carries no count
        return undefined;
    }
};

// The row's `dev` field: where, how far from its last commit, which build is served, or why none is.
export const devSummaryOf = async (
    extension: { readonly dir: string; readonly manifest: ExtensionManifest; readonly dev?: InstalledDev },
    git: GitRunner = uncachedGit,
): Promise<ExtensionDev | undefined> => {
    const dev = extension.dev;
    if (dev === undefined) {
        return undefined;
    }
    const uncommitted = dev.place === undefined ? undefined : await uncommittedIn(dev.checkout, git);
    const revision = dev.held === undefined ? await bundleRevisionOf(extension.dir, extension.manifest.entry) : undefined;
    return {
        path: dev.place?.path ?? dev.checkout,
        ...opt("conversation", dev.place?.conversation),
        ...opt("uncommitted", uncommitted),
        ...opt("revision", revision),
        ...opt("held", dev.held),
    };
};
