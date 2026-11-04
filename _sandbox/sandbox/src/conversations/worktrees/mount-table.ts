import { join } from "node:path";
import { MAIN_MOUNT, PACKAGE_STORE, SHARED_STATE } from "../../workload/worktree-paths.js";
import type { WarmMount } from "./cargo-warm.js";
import type { IsolationPlan } from "./isolation.js";
import { OVERLAY_FS_NAME, overlayOptions } from "./overlay-layers.js";

// An isolated turn's mount table: what the namespace mounts, in order, spelled as fstab(5) reads it, and the mount
// points it needs on disk first. Pure: isolation.ts prepares the disk and starts the holder that mounts it.
// Reference repos cloned only to be read against; workspace content, not repo content, so a worktree needs it mounted
// back in or hits ENOENT. Read-only by contract: a bind ignores `ro`, so the table's `bind,ro` is libmount's bind and then
// its read-only remount (mountTable).
export const SHELF = "refs";

// One line of the namespace's mount table, as fstab(5) spells it.
export interface MountEntry {
    readonly source: string;
    readonly target: string;
    readonly type: "none" | "overlay";
    readonly options: string;
}

// What the plan alone does not say: whether the main checkout has a reference shelf and a package store to bring back,
// and whether this kernel takes volatile overlays (overlayVolatileAvailable).
export interface MountFacts {
    readonly shelf: boolean;
    readonly store: boolean;
    readonly volatile: boolean;
    // The warm Cargo layers this view mounts, each pinned to its snapshot (warmMountsOf).
    readonly warm?: readonly WarmMount[];
}

// Where one mirror's overlay layer lives, outside the worktree; the fenced sandbox shares the convention (layerOf).
export const layerDirOf = (plan: Pick<IsolationPlan, "overlays">, rel: string): string => join(plan.overlays, encodeURIComponent(rel));

// The namespace's mounts, in the order they are made. Ordering is the whole argument: the root bound aside before the
// worktree shadows it, then shared state, the shelf and the package store from MAIN_MOUNT, then the mirrors over the
// main checkout's copies. Mounted by one `mount -a` (isolationScript); an entry it cannot mount fails the whole setup.
export const mountTable = (plan: IsolationPlan, facts: MountFacts): MountEntry[] => {
    const bind = (source: string, target: string, options = "bind"): MountEntry => ({ source, target, type: "none", options });
    const entries = [bind(plan.root, MAIN_MOUNT), bind(plan.worktree, plan.root)];
    for (const rel of SHARED_STATE) {
        entries.push(bind(join(MAIN_MOUNT, rel), join(plan.root, rel)));
    }
    // Most workspaces have neither; the table carries them only where the main checkout has them (MountFacts).
    if (facts.shelf) {
        // Read-only by contract: libmount makes `bind,ro` the bind and then the read-only remount a bind alone ignores.
        entries.push(bind(join(MAIN_MOUNT, SHELF), join(plan.root, SHELF), "bind,ro"));
    }
    if (facts.store) {
        entries.push(bind(join(MAIN_MOUNT, PACKAGE_STORE), join(plan.root, PACKAGE_STORE)));
    }
    for (const rel of plan.mirrors) {
        const layer = layerDirOf(plan, rel);
        const options = overlayOptions(join(MAIN_MOUNT, rel), join(layer, "upper"), join(layer, "work"));
        entries.push({ source: OVERLAY_FS_NAME, target: join(plan.root, rel), type: "overlay", options: facts.volatile ? `${options},volatile` : options });
    }
    // Last, over the checkout's own folders: a target's lower is a snapshot on the history volume, not the main checkout.
    for (const warm of facts.warm ?? []) {
        const layer = layerDirOf(plan, warm.rel);
        const options = overlayOptions(warm.lower, join(layer, "upper"), join(layer, "work"));
        entries.push({ source: OVERLAY_FS_NAME, target: join(plan.root, warm.rel), type: "overlay", options: facts.volatile ? `${options},volatile` : options });
    }
    return entries;
};

// fstab(5) separates fields by whitespace and reads octal escapes in each, so a path holding a space, tab, newline or
// backslash is spelled with them.
const fstabField = (value: string): string => value.replace(/[\\ \t\n]/gu, (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`);

export const fstabOf = (entries: readonly MountEntry[]): string =>
    `${entries.map((entry) => [fstabField(entry.source), fstabField(entry.target), entry.type, fstabField(entry.options), "0", "0"].join(" ")).join("\n")}\n`;

// The directories every mount in the table needs, named where the daemon sees them, so they exist before the holder
// starts and the holder spends its time mounting rather than spawning a mkdir per mount (the 157 mirrors of 2026-10-13
// were 314 spawns, each a fork and exec on a box already paging). Inside the namespace, `/work/<rel>` is the worktree's
// `<rel>` unless a bind from the main checkout lies over it: there the main checkout's copy is the mount point, and it
// already exists, since the walk found the mirror there.
export const mountPointsOf = (plan: IsolationPlan, facts: Pick<MountFacts, "shelf" | "store" | "warm">): string[] => {
    const fromMain = [...SHARED_STATE, ...(facts.shelf ? [SHELF] : []), ...(facts.store ? [PACKAGE_STORE] : [])];
    const underMain = (rel: string): boolean => fromMain.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
    return [
        MAIN_MOUNT,
        ...SHARED_STATE.flatMap((rel) => [join(plan.root, rel), join(plan.worktree, rel)]),
        ...(facts.shelf ? [join(plan.worktree, SHELF)] : []),
        ...(facts.store ? [join(plan.worktree, PACKAGE_STORE)] : []),
        ...plan.mirrors.filter((rel) => !underMain(rel)).map((rel) => join(plan.worktree, rel)),
        ...(facts.warm ?? []).map((warm) => join(plan.worktree, warm.rel)),
    ];
};
