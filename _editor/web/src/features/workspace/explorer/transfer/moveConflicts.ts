import { sandboxShallowRef } from "@intentic/extension-api";
import { basename, joinPath, parentDir } from "@intentic/ui/path";

// A move into a folder that already holds an entry of the same name. The daemon refuses to move over it (rename(2)
// would replace a file silently, with nothing in the trash to take back), so the surface asks first, once for the whole
// gesture, as a file manager does: Keep both lands the arrival under a free name ("notes 2.md"), Replace sends what is
// there to the trash first (so a delete's Undo brings it back), Skip moves only the entries whose names were free.
// Answering nothing (Cancel, Esc) moves nothing at all.

export type ConflictChoice = `keep` | `replace` | `skip`;

export interface MovePlan {
    // Sources whose name is free in the folder.
    readonly free: readonly string[];
    // Sources whose name an entry already in the folder holds.
    readonly clashes: readonly string[];
}

// Splits at the last dot, never a leading one, as a paste does: `.env` keeps its whole name as the stem.
const splitExtension = (name: string): readonly [string, string] => {
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ``];
};

/** The name a moved entry keeps beside one already there: Finder's Keep Both, `notes 2.md`, `notes 3.md`… */
export const keptName = (name: string, taken: ReadonlySet<string>): string => {
    if (!taken.has(name)) {
        return name;
    }
    const [stem, extension] = splitExtension(name);
    for (let copy = 2; ; copy++) {
        const candidate = `${stem} ${copy}${extension}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
};

/** Which sources would land on an entry already in `dir` (named in `taken`); one already in that folder is not moving. */
export const planMoves = (sources: readonly string[], dir: string, taken: ReadonlySet<string>): MovePlan => {
    const moving = sources.filter((source) => parentDir(source) !== dir);
    return { free: moving.filter((source) => !taken.has(basename(source))), clashes: moving.filter((source) => taken.has(basename(source))) };
};

export interface ResolvedMoves {
    // What moves, in gesture order.
    readonly sources: readonly string[];
    // A source landing under another name than its own.
    readonly names: ReadonlyMap<string, string>;
    // Entries in the folder to send to the trash before the move, the ones being replaced.
    readonly replaced: readonly string[];
}

/**
 * What the gesture moves once the reader has answered. Two sources of one name from different folders never land on
 * each other either: the second takes a kept name whatever was chosen, since neither was there to replace.
 */
export const resolveMoves = (plan: MovePlan, choice: ConflictChoice, dir: string, taken: ReadonlySet<string>): ResolvedMoves => {
    const claimed = new Set(taken);
    const names = new Map<string, string>();
    const replaced: string[] = [];
    // Lands `source` under a free name, its own where nothing of this gesture or the folder has it yet.
    const land = (source: string): void => {
        const name = basename(source);
        const kept = keptName(name, claimed);
        claimed.add(kept);
        if (kept !== name) {
            names.set(source, kept);
        }
    };
    // The free ones first, so a kept name never takes one an entry of this same gesture arrives under.
    plan.free.forEach(land);
    const landing = choice === `skip` ? [] : plan.clashes;
    for (const source of landing) {
        const there = joinPath(dir, basename(source));
        if (choice === `replace` && !replaced.includes(there)) {
            replaced.push(there);
            continue;
        }
        land(source);
    }
    return { sources: [...plan.free, ...landing], names, replaced };
};

// --- The question, asked of whichever page mounts its dialog (MoveConflictDialog.vue) ---------------------------------

export interface ConflictQuestion {
    // The folder the entries are moving into, and the names already taken there.
    readonly dir: string;
    readonly names: readonly string[];
    // Whether the gesture also moves entries whose names are free, which is when Skip differs from moving nothing.
    readonly others: boolean;
    // Undefined is no answer at all: the gesture moves nothing.
    readonly answer: (choice: ConflictChoice | undefined) => void;
}

/** The question on screen, if one is; a sandbox switch drops it with the tree it was about. */
export const conflictQuestion = sandboxShallowRef<ConflictQuestion | undefined>(() => undefined);

// How many dialogs are mounted to ask it. With none (a surface whose page has no dialog, a test), nobody could answer,
// so the gesture keeps both rather than waiting forever.
let askers = 0;

/** Counts a mounted dialog as able to ask; call the answer on unmount. */
export const holdConflictAsker = (): (() => void) => {
    askers += 1;
    return () => {
        askers -= 1;
    };
};

/** Asks how to land entries whose names are taken in `dir`; a question already showing is answered "nothing" first. */
export const askMoveConflict = (dir: string, names: readonly string[], others: boolean): Promise<ConflictChoice | undefined> => {
    if (askers === 0) {
        return Promise.resolve(`keep`);
    }
    conflictQuestion.value?.answer(undefined);
    return new Promise((resolve) => {
        const question: ConflictQuestion = {
            dir,
            names,
            others,
            answer: (choice) => {
                if (conflictQuestion.value === question) {
                    conflictQuestion.value = undefined;
                }
                resolve(choice);
            },
        };
        conflictQuestion.value = question;
    });
};
