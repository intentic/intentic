import { dirname, relative, sep } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import {
    ATTACHMENTS_DIR,
    HISTORY_STATE_FILES,
    LOOP_DIR,
    STORAGE_CLEANABILITY,
    stateFileFor,
    type StorageCategoryId,
} from "@intentic/sandbox-contract";
import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH } from "@intentic/sandbox-run/fly";
import { stateRelPath } from "../../../state-paths.js";

// Which category every byte on the sandbox's volumes belongs to, and how a clean removes one the contract's
// STORAGE_CLEANABILITY lets go. Pure: the scan sizes by it, the planner decides by it, and the cleaner asks it again
// right before each removal, so the three cannot disagree about what a path is.

// The volumes a scan walks, as real paths; `volume` is the hosted machine's one volume, holding the other two.
export interface StorageRoots {
    readonly workspace: string;
    readonly history: string;
    readonly volume?: string;
}
export type StorageRootKind = keyof StorageRoots;

// How a clean removes what a cleanable category holds. `unit` is an entry directly below one of its folders, a single
// file, or a whole store handed to the tool that owns it.
export interface StorageRemoval {
    readonly unit: "entry" | "file" | "prune";
    // Anything changed more recently than this stays: today's logs, a turn's scratch, a capture it may still read back.
    readonly keepRecentMs?: number;
    // Only folders are units: the files beside them are account state their owner keeps (a connection's passkeys).
    readonly foldersOnly?: true;
}

// Every category the contract lets a clean take; a `none` one has no removal to look up, by type.
type CleanableCategory = { [K in StorageCategoryId]: (typeof STORAGE_CLEANABILITY)[K] extends "none" ? never : K }[StorageCategoryId];

const DAY_MS = 24 * 60 * 60 * 1000;

const REMOVALS: Readonly<Record<CleanableCategory, StorageRemoval>> = {
    // Nothing reads the trash again, so nothing in it is too recent; the confirm names what it costs.
    trash: { unit: "entry" },
    backups: { unit: "entry" },
    exports: { unit: "entry" },
    artifacts: { unit: "entry", keepRecentMs: DAY_MS },
    browserCaptures: { unit: "entry", keepRecentMs: DAY_MS },
    browserProfiles: { unit: "entry", keepRecentMs: DAY_MS, foldersOnly: true },
    modelWeights: { unit: "entry", keepRecentMs: DAY_MS },
    logs: { unit: "file", keepRecentMs: DAY_MS },
    scratch: { unit: "entry", keepRecentMs: DAY_MS },
    // pnpm's own `store prune` decides, by its definition of what no project references.
    packageStores: { unit: "prune" },
    buildCaches: { unit: "file", keepRecentMs: DAY_MS },
};

const cleanable = (category: StorageCategoryId): category is CleanableCategory => STORAGE_CLEANABILITY[category] !== "none";

// How a clean removes the category's contents, or undefined for one no clean may touch.
export const removalOf = (category: StorageCategoryId): StorageRemoval | undefined => (cleanable(category) ? REMOVALS[category] : undefined);

export interface StoragePathRule {
    readonly root: StorageRootKind;
    // Root-relative with forward slashes; a folder keeps its trailing slash so it cannot prefix-match a sibling file.
    readonly prefix: string;
    readonly category: StorageCategoryId;
    // Segments below the prefix that name one item: what sizes are listed by, and what an entry clean removes whole.
    readonly depth: number;
    // Nothing at or below the prefix is ever removed, whichever rule classifies it: credentials, conversation records, live checkouts.
    readonly protected?: true;
}

// A folder as a rule spells one: root-relative, with the trailing slash that keeps it off a sibling file's name.
const folder = (path: string): string => `${path}/`;

// The nested Docker's data root on the hosted volume, as the entrypoint lays it out.
const VOLUME_DOCKER = folder(relative(FLY_VOLUME_PATH, FLY_VOLUME_LAYOUT.docker));

// Every runtime's session store, the transcripts a conversation resumes from.
const SESSIONS = folder(dirname(stateRelPath(".intentic/records/sessions/claude/")));

// The longest matching prefix wins, so a nested rule carves its folder out of the one around it.
const PATH_RULES: readonly StoragePathRule[] = [
    { root: "history", prefix: "trash/", category: "trash", depth: 1 },
    { root: "history", prefix: "exports/", category: "exports", depth: 1 },
    { root: "history", prefix: "logs/", category: "logs", depth: 1 },
    { root: "history", prefix: "gits/", category: "repositories", depth: 1 },
    // Turborepo drops its cache beside the git dirs it resolves a worktree's root through.
    { root: "history", prefix: "gits/.turbo/", category: "buildCaches", depth: 0 },
    { root: "history", prefix: "scopes/", category: "restorePoints", depth: 1, protected: true },
    { root: "history", prefix: "worktrees/", category: "checkouts", depth: 1, protected: true },
    { root: "history", prefix: "overlays/", category: "checkouts", depth: 1, protected: true },
    { root: "history", prefix: "conversations.db", category: "conversations", depth: 0, protected: true },
    { root: "history", prefix: "conversations/", category: "conversations", depth: 0, protected: true },
    { root: "history", prefix: "blobs/", category: "conversations", depth: 0, protected: true },
    { root: "history", prefix: "backups/", category: "backups", depth: 1 },
    { root: "history", prefix: "said-index/", category: "indexes", depth: 0 },
    { root: "history", prefix: "engines/", category: "engines", depth: 1 },
    // pnpm keeps a store at the top of whichever mount an install runs on; worktree installs land here.
    { root: "history", prefix: ".pnpm-store/", category: "packageStores", depth: 0 },
    // Written by the image rather than the daemon, so the history table does not declare them.
    { root: "history", prefix: "ssh-host-keys/", category: "state", depth: 0, protected: true },
    { root: "history", prefix: "shell/", category: "state", depth: 0 },
    // Declared state the fallback already names; a rule of their own only to fence them.
    { root: "history", prefix: "session-secret", category: "state", depth: 0, protected: true },
    { root: "history", prefix: "ssh-hosts/", category: "state", depth: 0, protected: true },
    { root: "history", prefix: "local-cert/", category: "state", depth: 0, protected: true },
    { root: "history", prefix: "translator/", category: "state", depth: 0, protected: true },
    { root: "workspace", prefix: ".pnpm-store/", category: "packageStores", depth: 0 },
    { root: "workspace", prefix: folder(STATE_DIR), category: "state", depth: 1 },
    // Named by what the state table declares inside them, so a renamed folder is a type error here rather than a silent miss.
    { root: "workspace", prefix: folder(dirname(stateRelPath(".intentic/secrets/auth/"))), category: "state", depth: 0, protected: true },
    { root: "workspace", prefix: folder(dirname(stateRelPath(".intentic/identity/members.json"))), category: "state", depth: 0, protected: true },
    { root: "workspace", prefix: folder(dirname(stateRelPath(".intentic/config/settings.json"))), category: "state", depth: 0, protected: true },
    { root: "workspace", prefix: SESSIONS, category: "conversations", depth: 1, protected: true },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/records/artifacts/")), category: "artifacts", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/records/artifacts/", "imagegen")), category: "artifacts", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/records/artifacts/", "workflow-runs")), category: "artifacts", depth: 1 },
    { root: "workspace", prefix: folder(ATTACHMENTS_DIR), category: "conversations", depth: 0, protected: true },
    // A loop's memory between rounds, which a running loop reads back.
    { root: "workspace", prefix: folder(LOOP_DIR), category: "conversations", depth: 0, protected: true },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/records/artifacts/browser/")), category: "browserCaptures", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/browser/")), category: "browserProfiles", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/cache/")), category: "indexes", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/cache/", "models")), category: "modelWeights", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/.pnpm-store/")), category: "packageStores", depth: 0 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/tmp/")), category: "scratch", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/verify/")), category: "scratch", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/extensions/")), category: "extensions", depth: 1 },
    { root: "workspace", prefix: folder(stateRelPath(".intentic/local/runtime/")), category: "extensions", depth: 1 },
    { root: "volume", prefix: ".pnpm-store/", category: "packageStores", depth: 0 },
    { root: "volume", prefix: VOLUME_DOCKER, category: "docker", depth: 0 },
];

// A browser connection's marker, passkeys, fingerprint seed and stealth script, kept beside the profile folders.
const PROTECTED_NAMES: readonly RegExp[] = [/\.connected$/, /\.passkeys\.json$/, /\.stealth\.js$/, /^\.fingerprint-seed$/];

const under = (rel: string, prefix: string): boolean => rel === prefix || rel.startsWith(prefix) || `${rel}/` === prefix;

const segments = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

// What no rule names: the workspace's own files, and on the history volume its declared state or else nobody's.
const fallback = (root: StorageRootKind, rel: string): StoragePathRule => {
    if (root === "workspace") {
        return { root, prefix: "", category: "workspace", depth: 1 };
    }
    if (root === "history" && stateFileFor(rel, HISTORY_STATE_FILES) !== undefined) {
        return { root, prefix: "", category: "state", depth: 1 };
    }
    return { root, prefix: "", category: "other", depth: 1 };
};

const ruleFor = (root: StorageRootKind, rel: string): StoragePathRule =>
    PATH_RULES.filter((rule) => rule.root === root && under(rel, rule.prefix)).reduce<StoragePathRule | undefined>(
        (best, rule) => (best === undefined || rule.prefix.length > best.prefix.length ? rule : best),
        undefined,
    ) ?? fallback(root, rel);

export interface StorageClassification {
    readonly category: StorageCategoryId;
    // Root-relative path of the item this counts toward: the rule's prefix plus `depth` more segments.
    readonly item: string;
    // Whether the path IS one item, the unit an entry clean removes, rather than a folder that holds several.
    readonly unit: boolean;
    // Whether every path below classifies the same, category and item both, so a walk can stop asking.
    readonly settled: boolean;
}

// One path's category, keyed by the root it sits in; `rel` is root-relative with forward slashes.
export const classifyStoragePath = (root: StorageRootKind, rel: string): StorageClassification => {
    const rule = ruleFor(root, rel);
    const depth = segments(rule.prefix).length + rule.depth;
    const path = segments(rel);
    const item = path.slice(0, Math.max(depth, segments(rule.prefix).length)).join("/");
    const nested = PATH_RULES.some((other) => other.root === root && other.prefix.startsWith(`${rel}/`));
    return { category: rule.category, item, unit: path.length === depth, settled: path.length >= depth && !nested };
};

export const isProtectedStoragePath = (root: StorageRootKind, rel: string): boolean =>
    rel === "" ||
    PATH_RULES.some((rule) => rule.protected === true && rule.root === root && under(rel, rule.prefix)) ||
    PROTECTED_NAMES.some((pattern) => pattern.test(segments(rel).at(-1) ?? ""));

// Every folder a category's rules name, root-relative: where a clean looks for what to remove.
export const categoryFolders = (category: StorageCategoryId): readonly StoragePathRule[] =>
    PATH_RULES.filter((rule) => rule.category === category && rule.prefix.endsWith("/"));

// The root a path lies in and its path relative to it; the innermost root wins, and undefined is outside every root.
export const locateStoragePath = (roots: StorageRoots, path: string): { readonly root: StorageRootKind; readonly rel: string } | undefined => {
    const candidates = (Object.entries(roots) as [StorageRootKind, string | undefined][]).flatMap(([root, base]) => {
        if (base === undefined) {
            return [];
        }
        const rel = relative(base, path);
        return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep) ? [] : [{ root, rel: rel.split(sep).join("/"), base }];
    });
    const innermost = candidates.reduce<(typeof candidates)[number] | undefined>(
        (best, candidate) => (best === undefined || candidate.base.length > best.base.length ? candidate : best),
        undefined,
    );
    return innermost === undefined ? undefined : { root: innermost.root, rel: innermost.rel };
};
