import { MODEL_ROLE_IDS, type ModelPin, type ModelRole, modelPinKey, rolePins, type RolePinSettings } from "@intentic/sandbox-contract";
import { honoredPinKnobs } from "../../../chat/models/run-settings/pickerRunSettings";

// The Models page draws one block per LIST, not one per job or per category: the jobs that run on the same models in the
// same order are one block, edited once. The default list is the first block, and every job without a list of its own
// is in it (contract `rolePins`). Nothing here is stored: the blocks are read off the per-job settings, so two jobs given
// the same list by hand meet in one block on the next visit, and a block that is edited writes every job in it.
//
// What IS held, for the length of a visit, is which block a job was put in (`Layout`). Without it a job given "its own
// models" starts as a copy of the list it had, reads as identical, and folds straight back into the block it just left.

export const DEFAULT_PATH = `default`;

export interface ModelPath {
    readonly id: string;
    readonly isDefault: boolean;
    /** In the catalog's order; may be empty only for the default block. */
    readonly roles: readonly ModelRole[];
    readonly pins: readonly ModelPin[];
}

/** Which block a job with a list of its own was put in during this visit, by block id. */
export type Layout = ReadonlyMap<ModelRole, string>;

type RoleLists = Partial<Record<ModelRole, ModelPin[]>>;

/** A settings write, and the layout to hold once it lands. */
export interface PathWrite {
    readonly fields: { readonly modelDefault?: ModelPin[]; readonly modelRoles?: RoleLists };
    readonly layout: Layout;
}

const ORDER = new Map(MODEL_ROLE_IDS.map((role, index) => [role, index]));
const byCatalog = (left: ModelRole, right: ModelRole): number => (ORDER.get(left) ?? 0) - (ORDER.get(right) ?? 0);

// Compared as the run reads it (honoredPinKnobs), never as stored: a knob this provider has no control for changes
// nothing about the turn, so it may not be the reason two jobs land in different blocks.
const pinIdentity = (pin: ModelPin): string => {
    const honored = honoredPinKnobs(pin);
    return [modelPinKey(honored), honored.effort ?? ``, honored.thinking ?? ``, honored.fast ?? ``, honored.harness ?? ``].join(`|`);
};

export const listKey = (pins: readonly ModelPin[]): string => pins.map(pinIdentity).join(`\n`);

// Jobs in insertion order, filed under whatever `by` names them.
const groupBy = <K>(roles: readonly ModelRole[], by: (role: ModelRole) => K): Map<K, ModelRole[]> => {
    const groups = new Map<K, ModelRole[]>();
    for (const role of roles) {
        groups.set(by(role), [...(groups.get(by(role)) ?? []), role]);
    }
    return groups;
};

interface Bucket {
    readonly key: string;
    readonly roles: ModelRole[];
}

// Held blocks first. A block whose jobs no longer share one list (another tab wrote one of them, or a write was refused
// and rolled back) keeps its largest part; the rest come back loose and are placed as if never held, which puts a job
// whose move was refused straight back beside the jobs it never left.
const heldBuckets = (held: Map<string, ModelRole[]>, keyOf: (role: ModelRole) => string) => {
    const buckets = new Map<string, Bucket>();
    const loose: ModelRole[] = [];
    for (const [id, roles] of held) {
        // Largest part keeps the block; a tie goes to the part holding the earliest job, since the map keeps that order.
        const [keep] = [...groupBy(roles, keyOf)].toSorted(([, a], [, b]) => b.length - a.length);
        if (keep !== undefined) {
            buckets.set(id, { key: keep[0], roles: keep[1] });
            loose.push(...roles.filter((role) => !keep[1].includes(role)));
        }
    }
    return { buckets, loose };
};

// Everything not held joins the block already holding its list, or opens one named after it.
const placeLoose = (buckets: Map<string, Bucket>, loose: readonly ModelRole[], keyOf: (role: ModelRole) => string): void => {
    for (const role of loose.toSorted(byCatalog)) {
        const key = keyOf(role);
        const same = [...buckets.values()].find((bucket) => bucket.key === key);
        if (same !== undefined) {
            same.roles.push(role);
            continue;
        }
        // A held block may still carry the name of a list it has since changed from.
        let id = `k:${key}`;
        while (buckets.has(id)) {
            id = `${id}~`;
        }
        buckets.set(id, { key, roles: [role] });
    }
};

// Blocks read off the settings in the catalog's order; ones made during this visit after them, in the order made, so a
// job given its own models lands at the foot of the page rather than wherever its name sorts.
const madeAt = (id: string): number => (id.startsWith(`n:`) ? Number(id.slice(2)) : -1);

export function modelPaths(settings: RolePinSettings, layout: Layout): readonly ModelPath[] {
    const followers = MODEL_ROLE_IDS.filter((role) => settings.modelRoles[role] === undefined);
    const keyOf = (role: ModelRole): string => listKey(settings.modelRoles[role] ?? []);
    const own = MODEL_ROLE_IDS.filter((role) => settings.modelRoles[role] !== undefined);

    const { buckets, loose } = heldBuckets(groupBy(own.filter((role) => layout.has(role)), (role) => layout.get(role) ?? ``), keyOf);
    placeLoose(buckets, [...loose, ...own.filter((role) => !layout.has(role))], keyOf);

    const paths = [...buckets].map(([id, bucket]) => {
        const roles = bucket.roles.toSorted(byCatalog);
        return { id, isDefault: false, roles, pins: settings.modelRoles[roles[0]!] ?? [] };
    });
    return [
        { id: DEFAULT_PATH, isDefault: true, roles: followers, pins: settings.modelDefault },
        ...paths.toSorted((a, b) => madeAt(a.id) - madeAt(b.id) || byCatalog(a.roles[0]!, b.roles[0]!)),
    ];
}

const withRoles = (settings: RolePinSettings, roles: readonly ModelRole[], list: (role: ModelRole) => readonly ModelPin[] | undefined): RoleLists => {
    const next: RoleLists = Object.fromEntries(Object.entries(settings.modelRoles).map(([role, pins]) => [role, [...(pins ?? [])]]));
    for (const role of roles) {
        const pins = list(role);
        if (pins === undefined) {
            delete next[role];
        } else {
            next[role] = [...pins];
        }
    }
    return next;
};

const layoutWith = (layout: Layout, roles: readonly ModelRole[], id: string | undefined): Layout => {
    const next = new Map(layout);
    for (const role of roles) {
        if (id === undefined) {
            next.delete(role);
        } else {
            next.set(role, id);
        }
    }
    return next;
};

/** A block's list, changed: the default's is one field; any other block's is written into each of its jobs. */
export function editPath(settings: RolePinSettings, layout: Layout, path: ModelPath, pins: readonly ModelPin[]): PathWrite {
    if (path.isDefault) {
        return { fields: { modelDefault: [...pins] }, layout };
    }
    // Held under the id it was drawn with, so the block keeps its place (and whatever has focus in it) as its list changes.
    return { fields: { modelRoles: withRoles(settings, path.roles, () => pins) }, layout: layoutWith(layout, path.roles, path.id) };
}

/** Where a job can be moved to: the default, another block, a list of its own, or none at all. */
export type JobTarget =
    | { readonly kind: `default` }
    | { readonly kind: `path`; readonly id: string }
    | { readonly kind: `own` }
    | { readonly kind: `none` };

export function moveJob(settings: RolePinSettings, layout: Layout, paths: readonly ModelPath[], role: ModelRole, target: JobTarget, mint: () => string): PathWrite {
    if (target.kind === `default`) {
        return { fields: { modelRoles: withRoles(settings, [role], () => undefined) }, layout: layoutWith(layout, [role], undefined) };
    }
    if (target.kind === `path`) {
        const path = paths.find((candidate) => candidate.id === target.id);
        if (path === undefined || path.isDefault) {
            return moveJob(settings, layout, paths, role, { kind: `default` }, mint);
        }
        return { fields: { modelRoles: withRoles(settings, [role], () => path.pins) }, layout: layoutWith(layout, [role], path.id) };
    }
    if (target.kind === `own`) {
        // A copy of what it runs on now, so the move changes nothing until the new list is edited.
        return { fields: { modelRoles: withRoles(settings, [role], () => rolePins(settings, role)) }, layout: layoutWith(layout, [role], mint()) };
    }
    // Into the block that already has no models, if there is one; a second empty block would say the same thing twice.
    const empty = paths.find((path) => !path.isDefault && path.pins.length === 0 && !path.roles.includes(role));
    return { fields: { modelRoles: withRoles(settings, [role], () => []) }, layout: layoutWith(layout, [role], empty?.id ?? mint()) };
}

/**
 * A block's list becomes the default, and its jobs follow it. The jobs that followed the old default keep the models
 * they had, as a block of their own: nothing changes what any job runs on except the press that says so.
 */
export function makeDefault(settings: RolePinSettings, layout: Layout, paths: readonly ModelPath[], path: ModelPath, mint: () => string): PathWrite {
    const followers = paths.find((candidate) => candidate.isDefault)?.roles ?? [];
    const kept = followers.length === 0 ? layout : layoutWith(layout, followers, mint());
    return {
        fields: {
            modelDefault: [...path.pins],
            modelRoles: withRoles(settings, [...path.roles, ...followers], (role) => (path.roles.includes(role) ? undefined : settings.modelDefault)),
        },
        layout: layoutWith(kept, path.roles, undefined),
    };
}

/** A block's jobs give up their own list and run on the default. */
export function followDefault(settings: RolePinSettings, layout: Layout, path: ModelPath): PathWrite {
    return { fields: { modelRoles: withRoles(settings, path.roles, () => undefined) }, layout: layoutWith(layout, path.roles, undefined) };
}
