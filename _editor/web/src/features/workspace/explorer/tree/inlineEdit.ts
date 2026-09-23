import { basename, parentDir } from "@intentic/ui/path";
import { joinPath } from "../entryNames";

// The tree's one inline name field, as one value that only `advanceEdit` moves: idle, naming a new entry inside a
// folder, or renaming a row. A step says what the field opens holding and which write, if any, a commit asks for.

export type InlineEdit =
    | { readonly kind: `idle` }
    // Inline create (VSCode-style): a phantom input row rendered inside the target dir; "" = the root.
    | { readonly kind: `creating`; readonly dir: string; readonly type: "file" | "dir" }
    | { readonly kind: `renaming`; readonly path: string };

export type InlineEditEvent =
    | { readonly kind: `create`; readonly dir: string; readonly type: "file" | "dir" }
    | { readonly kind: `rename`; readonly path: string }
    // Enter. `refused` is the live check's verdict on `draft` (a create's name already taken, or malformed).
    | { readonly kind: `commit`; readonly draft: string; readonly refused: boolean }
    // Focus leaving the field: a commit, except that a refused new name is dropped rather than left open.
    | { readonly kind: `blur`; readonly draft: string; readonly refused: boolean }
    // Escape.
    | { readonly kind: `cancel` };

// What a committed field asks the tree to write.
export type InlineWrite =
    | { readonly kind: `create`; readonly path: string; readonly type: "file" | "dir" }
    | { readonly kind: `rename`; readonly from: string; readonly to: string };

export interface EditStep {
    readonly edit: InlineEdit;
    // The text a field opens with; absent when the step opens none.
    readonly draft?: string;
    readonly write?: InlineWrite;
}

export const IDLE: InlineEdit = { kind: `idle` };

// An empty name is a silent cancel; a refused one keeps the field open with the refusal under it.
const commitCreate = (edit: Extract<InlineEdit, { kind: `creating` }>, draft: string, refused: boolean): EditStep => {
    const name = draft.trim();
    if (name === ``) {
        return { edit: IDLE };
    }
    if (refused) {
        return { edit };
    }
    return { edit: IDLE, write: { kind: `create`, path: joinPath(edit.dir, name), type: edit.type } };
};

// The field closes either way; an empty or unchanged name writes nothing.
const commitRename = (path: string, draft: string): EditStep => {
    const name = draft.trim();
    if (name === `` || name === basename(path)) {
        return { edit: IDLE };
    }
    return { edit: IDLE, write: { kind: `rename`, from: path, to: joinPath(parentDir(path), name) } };
};

// Idle commits nothing: the blur that follows Enter, or a second Enter while the first one's write is in flight.
const commit = (edit: InlineEdit, draft: string, refused: boolean): EditStep => {
    if (edit.kind === `creating`) {
        return commitCreate(edit, draft, refused);
    }
    return edit.kind === `renaming` ? commitRename(edit.path, draft) : { edit };
};

type Moves = { readonly [K in InlineEditEvent["kind"]]: (edit: InlineEdit, event: Extract<InlineEditEvent, { kind: K }>) => EditStep };

// Every move there is, one entry per event. Opening a field replaces whichever one was open.
const MOVES: Moves = {
    create: (edit, { dir, type }) => ({ edit: { kind: `creating`, dir, type }, draft: `` }),
    rename: (edit, { path }) => ({ edit: { kind: `renaming`, path }, draft: basename(path) }),
    commit: (edit, { draft, refused }) => commit(edit, draft, refused),
    blur: (edit, { draft, refused }) => (edit.kind === `creating` && refused ? { edit: IDLE } : commit(edit, draft, refused)),
    cancel: () => ({ edit: IDLE }),
};

// The table is keyed by the event's own kind, so the entry read always takes the event it is handed.
export const advanceEdit = (edit: InlineEdit, event: InlineEditEvent): EditStep =>
    (MOVES[event.kind] as (edit: InlineEdit, event: InlineEditEvent) => EditStep)(edit, event);
