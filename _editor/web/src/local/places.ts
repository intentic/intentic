import type { LocalPlace } from "../app/environments/localHost";

// What the folder menu says about a folder or a document of this computer without drawing anything: its name, the folder
// it is in, when it was opened, and which of the recents are worth a row. Pure, so each is tested by value (places.test.ts).

// The first instant a number can be milliseconds rather than seconds: 1e11 seconds is the year 5138, while milliseconds
// passed it in 1973.
const MILLISECONDS_FROM = 1e11;
const fromEpoch = (value: number): number => (value < MILLISECONDS_FROM ? value * 1000 : value);

/** When a place was opened, in epoch ms; undefined when the app could not say (a zero, a clock before 1970). */
export const openedAtMs = (openedAt: number | string): number | undefined => {
    // A number stays itself and a numeral reads as one; an ISO instant is not a number, so it is read as a date.
    const numeric = Number(openedAt);
    const at = Number.isFinite(numeric) ? fromEpoch(numeric) : Date.parse(String(openedAt));
    return Number.isFinite(at) && at > 0 ? at : undefined;
};

const SEPARATORS = /[\\/]/;

/** The place as the reader recognises it: its own name. A drive or the root is its own name. */
export const nameOf = (path: string): string => path.split(SEPARATORS).findLast((part) => part !== ``) ?? path;

/** The folder it is in, as written: `/home/ada` for `/home/ada/Taxes`, `C:\` for `C:\notes.md`, nothing for a root. */
export const whereOf = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/, ``);
    const cut = Math.max(trimmed.lastIndexOf(`/`), trimmed.lastIndexOf(`\\`));
    if (cut < 0) {
        return ``;
    }
    // A child of the root or of a drive keeps its separator: `/`, `C:\`, never an empty string or a bare `C:`.
    const parent = trimmed.slice(0, cut);
    return parent === `` || /^[A-Za-z]:$/.test(parent) ? trimmed.slice(0, cut + 1) : parent;
};

// Two spellings of one path are one place: either separator, and a trailing one or not. Case is kept, since only some
// file systems ignore it and a folder named twice is the smaller harm than two folders drawn as one.
const samePath = (one: string, other: string): boolean => {
    const plain = (path: string): string => path.replaceAll(`\\`, `/`).replace(/\/+$/, ``);
    return plain(one) === plain(other);
};

/** How many recents the folder menu lists: as many as the app keeps (state.rs `RECENTS`). */
export const PLACES_SHOWN = 12;

/**
 * The recents worth a row beside the folder this window shows: every other FOLDER, newest first, as many as are kept. A
 * document the app opened on its own is in its recents too, and left out here: the folder menu offers places, never a
 * file apart from its folder (LocalFolderMenu.vue).
 */
export const otherPlaces = (places: readonly LocalPlace[], here: string | undefined): LocalPlace[] =>
    places.filter((place) => place.folder && (here === undefined || !samePath(place.path, here))).slice(0, PLACES_SHOWN);
