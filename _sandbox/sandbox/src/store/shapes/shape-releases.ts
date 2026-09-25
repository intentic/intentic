import { isNewer } from "@intentic/sandbox-contract";

// Frozen by release: the shape generator records a document's new shape `unreleased`, and a later one before the next
// release replaces it (no release ever wrote a file in the intermediate shape). Once a release tag holds it, as the
// last shape the tag's record has for that document, it is stamped with that tag; a shape a tag holds only as an
// intermediate never shipped, and goes. A shape frozen before stamping by release is dated by UTC day and resolved the
// same way, except that a release cut that day or later, from before the record existed, may have shipped it: kept,
// stamped with that release. Pure, so the generator hands in what git knows.

export interface FrozenShape {
    readonly type: string;
    // The release that first wrote files of this shape ("v1.312.0"); `unreleased` for one no release has shipped yet;
    // a UTC day ("2026-09-24") for one frozen before stamping by release, until it resolves.
    readonly since: string;
}

export type Shapes = Record<string, FrozenShape[]>;

// A release tag and the UTC day it was cut.
export interface Release {
    readonly tag: string;
    readonly day: string;
}

export const UNRELEASED = "unreleased";

export const isRelease = (since: string): boolean => /^v\d+\.\d+\.\d+$/.test(since);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The release that first shipped a shape not yet stamped by one, `unreleased`, or undefined for an intermediate no
// release ever wrote. `releases` oldest first; `recordAt` answers undefined for a release from before the record.
const resolveSince = (key: string, shape: FrozenShape, releases: readonly Release[], recordAt: (tag: string) => Shapes | undefined): string | undefined => {
    const dated = DAY.test(shape.since) ? shape.since : undefined;
    let unrecorded: string | undefined;
    for (const { tag, day } of releases) {
        if (dated !== undefined && day < dated) {
            continue;
        }
        const record = recordAt(tag);
        if (record === undefined) {
            unrecorded ??= dated === undefined ? undefined : tag;
            continue;
        }
        const held = record[key] ?? [];
        const at = held.findIndex((frozen) => frozen.type === shape.type);
        if (at === -1) {
            continue;
        }
        // The last shape a release holds is the one it wrote. The stamp is the later of the candidates, so a horizon
        // can only ever check a shape it might have retired, never retire one it should check.
        return at === held.length - 1 ? tag : unrecorded;
    }
    return unrecorded ?? UNRELEASED;
};

// Stamps what releases have shipped since the last freeze, drops intermediates none ever wrote, and records each
// document's current shape: a new one replaces any other still unreleased. A shape already on record stays as it is.
export const freeze = (
    shapes: Shapes,
    current: ReadonlyMap<string, string>,
    releases: readonly Release[],
    recordAt: (tag: string) => Shapes | undefined,
): Shapes => {
    const frozen: Shapes = {};
    for (const [key, list] of Object.entries(shapes)) {
        frozen[key] = list.flatMap((shape) => {
            if (isRelease(shape.since)) {
                return [shape];
            }
            const since = resolveSince(key, shape, releases, recordAt);
            return since === undefined ? [] : [{ type: shape.type, since }];
        });
    }
    for (const [key, type] of current) {
        const known = frozen[key] ?? [];
        if (!known.some((shape) => shape.type === type)) {
            frozen[key] = [...known.filter((shape) => shape.since !== UNRELEASED), { type, since: UNRELEASED }];
        }
    }
    return frozen;
};

// A shape no release at or after the document's horizon writes is past what this build converts on purpose: the shape
// after it had shipped by the horizon. Not the shape's own first release: one first written before the horizon and
// still current at it is exactly what a file from the horizon holds.
export const beforeHorizon = (next: FrozenShape | undefined, horizon: string | undefined): boolean =>
    horizon !== undefined && next !== undefined && isRelease(next.since) && !isNewer(next.since.slice(1), horizon.replace(/^v/, ""));
