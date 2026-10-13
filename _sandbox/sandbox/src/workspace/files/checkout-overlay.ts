import { existsSync } from "node:fs";
import type { GitChange } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { IsolatedAgent, RepoRecord } from "../../conversations/registry/agents-store.js";
import type { ReferenceView } from "./resolve-reference.js";
import { isControlPlanePath, resolveWithin } from "./workspace-files-paths.js";

// What a conversation's checkout holds that the shared tree's search index cannot say. The index covers /work alone, so
// a file the conversation created exists nowhere it can see, and a file it renamed still answers under its old name.
// Read from the conversation's own change list (the one its review shows, renames included), workspace-relative like
// every path a reference resolves to.

export interface CheckoutOverlay {
    // Files this copy has that it did not branch with: created, or renamed in.
    readonly added: readonly string[];
    // Files it branched with and no longer has: deleted, or renamed away.
    readonly gone: ReadonlySet<string>;
    // Where each renamed file went, old path to new.
    readonly renamed: ReadonlyMap<string, string>;
}

export const NO_OVERLAY: CheckoutOverlay = { added: [], gone: new Set(), renamed: new Map() };

// A repo's rows, joined onto its directory: git answers per repo, the workspace names files from its root.
const inWorkspace = (repo: string, path: string): string => (repo === "root" ? path : `${repo}/${path}`);

export const overlayOf = (rows: readonly { readonly repo: string; readonly changes: readonly GitChange[] }[]): CheckoutOverlay => {
    const added: string[] = [];
    const gone = new Set<string>();
    const renamed = new Map<string, string>();
    for (const { repo, changes } of rows) {
        for (const change of changes) {
            const path = inWorkspace(repo, change.path);
            if (change.status === "added") {
                added.push(path);
            } else if (change.status === "deleted") {
                gone.add(path);
            } else if (change.status === "renamed" && change.from !== undefined) {
                const from = inWorkspace(repo, change.from);
                added.push(path);
                gone.add(from);
                renamed.set(from, path);
            }
        }
    }
    return { added, gone, renamed };
};

// A burst of reads asks once: a hover peeks the reference and the click that follows resolves it again, and each read
// spends a few git calls per repo. Short, so a file written a moment ago is soon seen.
const FRESH_MS = 3_000;

export interface CheckoutOverlays {
    readonly of: (entry: IsolatedAgent) => Promise<CheckoutOverlay>;
}

export interface CheckoutOverlayDeps {
    // One repo's changes since the conversation branched, uncommitted ones included: its review's own reading. A port the
    // conversations layer fills, since the change list is theirs to read.
    readonly changesOf: (entry: IsolatedAgent, composed: RepoRecord) => Promise<readonly GitChange[]>;
    readonly logger: Logger;
}

export const createCheckoutOverlays = (deps: CheckoutOverlayDeps): CheckoutOverlays => {
    const held = new Map<string, { readonly at: number; readonly overlay: Promise<CheckoutOverlay> }>();
    const read = async (entry: IsolatedAgent): Promise<CheckoutOverlay> => {
        const rows = await Promise.all(
            entry.placement.repos.map(async (composed) => {
                try {
                    return { repo: composed.repo, changes: await deps.changesOf(entry, composed) };
                } catch (error) {
                    // An unreadable repo adds nothing: its references resolve against the shared tree, as before.
                    deps.logger.debug({ err: error, repo: composed.repo, agent: entry.id }, "checkout overlay: repo unreadable");
                    return { repo: composed.repo, changes: [] };
                }
            }),
        );
        return overlayOf(rows);
    };
    return {
        of: (entry) => {
            const now = Date.now();
            for (const [id, hold] of held) {
                if (now - hold.at >= FRESH_MS) {
                    held.delete(id);
                }
            }
            const hold = held.get(entry.id);
            if (hold !== undefined) {
                return hold.overlay;
            }
            const overlay = read(entry);
            held.set(entry.id, { at: now, overlay });
            return overlay;
        },
    };
};

// A file reference is a literal name, never a pattern: `pages/[id].vue` names one file, which the glob it is searched
// with would otherwise read as a character class and never find.
const literalGlob = (path: string): string => path.replaceAll(/[\\*?[\]{}()!]/g, (char) => `\\${char}`);

const endsWithPath = (path: string, tail: string): boolean => path === tail || path.endsWith(`/${tail}`);
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf(`/`)));

// Whether a workspace-relative path is a real file under `dir`, never its control plane nor a `../` way out of it.
const presentIn = (dir: string, relPath: string): boolean => {
    const abs = resolveWithin(dir, relPath);
    return abs !== undefined && !isControlPlanePath(dir, abs) && existsSync(abs);
};

/**
 * One copy of the workspace for the reference resolver: the conversation's checkout laid over the shared tree, the
 * shared tree's index answering for every file the conversation did not touch, and its own change list for the ones it
 * did. With `checkout` equal to `shared` and no overlay, it is the shared tree alone.
 */
export const overlaidView = (deps: {
    readonly checkout: string;
    readonly shared: string;
    readonly overlay: CheckoutOverlay;
    // Every shared-tree file a glob matches, from the resident index's sweep.
    readonly matching: (glob: string) => Promise<readonly string[]>;
}): ReferenceView => {
    const { checkout, shared, overlay, matching } = deps;
    const own = (keep: (path: string) => boolean): string[] => overlay.added.filter(keep);
    const fromShared = async (glob: string): Promise<string[]> => (await matching(glob)).filter((path) => !overlay.gone.has(path));
    const merged = (first: readonly string[], second: readonly string[], limit: number): string[] => [...new Set([...first, ...second])].slice(0, limit);
    return {
        // The checkout first: a file just written there exists nowhere else. The shared tree after, as reads fall back.
        exists: (relPath) => presentIn(checkout, relPath) || (checkout !== shared && presentIn(shared, relPath)),
        endingWith: async (tail, limit) => merged(own((path) => endsWithPath(path, tail)), await fromShared(`**/${literalGlob(tail)}`), limit),
        inFolder: async (folder, limit) =>
            merged(own((path) => endsWithPath(folderOf(path), folder)), await fromShared(`**/${literalGlob(folder)}/*`), limit),
        // A name the checkout holds again is that file, not a pointer to where the old one went.
        renamed: new Map([...overlay.renamed].filter(([from]) => !presentIn(checkout, from))),
    };
};
