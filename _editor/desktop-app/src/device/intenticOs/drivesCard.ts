import { type IntenticOsDrive, IntenticOsImportPathSchema } from "@intentic/sandbox-contract/schemas/intentic-os";
import type { OsDriveImportEnd, OsDriveImportEvent } from "../../osSettings";

// THE DRIVES, READ (src-tauri/src/os_settings.rs watches `ic os drives`, drives.ts holds them, DrivesCard.vue draws them):
// what a person calls a drive, the sandboxes on this computer it can be copied into, a folder named for it, a copy's
// progress as every window hears it, where what it copied went, and how it ended. Pure, so each case is tested by value
// (drivesCard.test.ts).

/** What a person calls a drive: the name it was given, else what it says it is; none, and the card says what kind. */
export const driveNameOf = (drive: IntenticOsDrive): string | undefined => {
    const label = drive.label?.trim() ?? ``;
    if (label !== ``) {
        return label;
    }
    const model = drive.model?.trim() ?? ``;
    return model === `` ? undefined : model;
};

/** A sandbox a drive can be copied into: by the name the app knows it by, else its slug. */
export interface CopyTarget {
    readonly slug: string;
    readonly name: string;
}

/** The sandboxes on this computer, by name, each once. */
export const copyTargetsOf = (sandboxes: readonly { readonly slug: string; readonly name?: string | undefined }[]): readonly CopyTarget[] => {
    const seen = new Map<string, CopyTarget>();
    for (const sandbox of sandboxes) {
        if (!seen.has(sandbox.slug)) {
            seen.set(sandbox.slug, { slug: sandbox.slug, name: sandbox.name?.trim() || sandbox.slug });
        }
    }
    return [...seen.values()].sort((one, other) => one.name.localeCompare(other.name));
};

/** A folder typed for the copy, as ic takes it: none where nothing was typed, the slashes around it dropped. */
export const folderOf = (typed: string): string | undefined => {
    const folder = typed.trim().replace(/^\/+|\/+$/gu, ``);
    return folder === `` ? undefined : folder;
};

/** A folder ic would refuse: one that climbs out of the sandbox's /work, or names nothing. */
export const folderRefused = (typed: string): boolean => {
    const folder = folderOf(typed);
    return folder !== undefined && !IntenticOsImportPathSchema.safeParse(folder).success;
};

/** Where a copy went, as a person reads a place in their sandbox: `/work/Imports/KINGSTON-2026-10-16` is
 *  `Imports › KINGSTON-2026-10-16`. */
export const placeOf = (path: string): string =>
    path
        .replace(/^\/work(?:\/|$)/u, ``)
        .split(`/`)
        .filter((part) => part !== ``)
        .join(` › `);

/** A copy under way: which drive into which sandbox, and how far it has got. */
export interface Copying {
    readonly device: string;
    readonly sandbox: string;
    readonly bytes: number;
    readonly total: number;
}

/** One moment of a copy, folded into what the card draws: undefined once it has ended (`copyEndOf` reads how). Heard
 *  part way through, from a window that opened after it began, its progress is all there is to go on. */
export const foldCopy = (copying: Copying | undefined, event: OsDriveImportEvent): Copying | undefined => {
    switch (event.kind) {
        case `started`:
            return { device: event.device, sandbox: event.sandbox, bytes: 0, total: 0 };
        case `progress`:
            return { device: event.device, sandbox: event.sandbox, bytes: event.bytes, total: event.total };
        default:
            return copying === undefined || copying.device === event.device ? undefined : copying;
    }
};

export const copyEndOf = (event: OsDriveImportEvent): OsDriveImportEnd | undefined => {
    if (event.kind !== `exit`) {
        return undefined;
    }
    const { kind: _kind, ...end } = event;
    return end;
};

/** How far a copy has got, 0 to 1; none before ic has said how much there is. */
export const shareOf = (copying: Copying): number | undefined => (copying.total > 0 ? Math.min(1, copying.bytes / copying.total) : undefined);

/** What the card says of how a copy ended. A stop the reader asked for needs no words. */
export type CopySaid = `copied` | `noRoom` | `failed` | `notOs` | `busy` | undefined;

export const copySaidOf = (end: OsDriveImportEnd | undefined): CopySaid => {
    switch (end?.outcome) {
        case `done`:
            return `copied`;
        case `noRoom`:
        case `failed`:
        case `notOs`:
        case `busy`:
            return end.outcome;
        default:
            return undefined;
    }
};
