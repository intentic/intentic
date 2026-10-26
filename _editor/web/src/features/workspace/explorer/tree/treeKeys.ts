import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { letterOfCode, primaryHeld } from "@intentic/ui/keys";
import { stepLead } from "../treeSelect";
import type { MoreRow, Row } from "./treeRows";

// What a key does in the tree, decided rather than done: the lead row is the target and visible order the axis. A key
// the tree does not own answers undefined and is left to the page; Ctrl/Cmd+X/C/V are absent, since they arrive as
// clipboard events instead.
//
// A Mac's tree answers as Finder does, since a MacBook has no Delete key and its F2 is behind fn: Return renames,
// ⌘↓ opens, Space previews, ⌘↑ goes up to the folder, ⌥↑/⌥↓ jump to the ends, ⌘⌫ deletes, ⌘D duplicates and ⌥⌘V moves
// what was copied. Elsewhere it is Windows Explorer and VS Code's: Enter opens, F2 renames, Delete deletes, Space toggles.

export type KeyPress = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"> & Partial<Pick<KeyboardEvent, "code">>;

export interface KeyView {
    readonly rows: readonly (Row | MoreRow)[];
    // The rows' paths in order, markers excluded: the axis the arrows, Home and End move along.
    readonly order: readonly string[];
    readonly lead: string | null;
    // How many rows are selected; F2 renames only a lone one.
    readonly selected: number;
    readonly entryAt: (path: string) => WorkspaceTreeEntry | undefined;
    // Which platform's keys the tree answers (the header above).
    readonly isMac: boolean;
}

export type KeyIntent =
    // Selects one row, widens the selection from the anchor, or moves the cursor alone; each then focuses the lead.
    | { readonly kind: `select`; readonly path: string }
    | { readonly kind: `extend`; readonly path: string }
    | { readonly kind: `lead`; readonly path: string }
    // Opens or closes a folder or a nest.
    | { readonly kind: `toggleExpand`; readonly path: string }
    // Adds the row to the selection, or takes it out.
    | { readonly kind: `toggleSelected`; readonly path: string }
    // What a single click does: the entry is picked, then opened, expanded or explained.
    | { readonly kind: `activate`; readonly entry: WorkspaceTreeEntry }
    | { readonly kind: `rename`; readonly path: string }
    | { readonly kind: `deselect` }
    | { readonly kind: `delete` }
    | { readonly kind: `selectAll` }
    // A copy of the selection beside itself (Finder's ⌘D).
    | { readonly kind: `duplicate` }
    // What was copied, moved here instead (Finder's ⌥⌘V).
    | { readonly kind: `moveHere` }
    // A key the tree owns with nothing to act on here, still kept from the page.
    | { readonly kind: `none` };

const NONE: KeyIntent = { kind: `none` };

// The lead's visible row and its index; expanding and the jump to a parent act on rows, so a nest behaves like a dir.
const leadRowAt = ({ rows, lead }: KeyView): { readonly row: Row; readonly index: number } | undefined => {
    const index = rows.findIndex((row) => !(`more` in row) && row.entry.path === lead);
    const row = rows[index];
    return row === undefined || `more` in row ? undefined : { row, index };
};

const opens = (row: Row): boolean => row.entry.type === `dir` || row.nest === true;

// Up and Down: Shift widens the selection, Ctrl moves the cursor alone, and a bare arrow selects. A Mac spends ⌘ and ⌥ on
// the arrows differently (vertical, below).
const step = (press: KeyPress, view: KeyView, delta: number): KeyIntent => {
    const next = stepLead(view.order, view.lead, delta);
    if (next === null) {
        return NONE;
    }
    if (press.shiftKey) {
        return { kind: `extend`, path: next };
    }
    return press.ctrlKey ? { kind: `lead`, path: next } : { kind: `select`, path: next };
};

// Home and End: Shift widens the selection to the end, anything else selects it.
const jump = (press: KeyPress, next: string | undefined): KeyIntent => {
    if (next === undefined) {
        return NONE;
    }
    return press.shiftKey ? { kind: `extend`, path: next } : { kind: `select`, path: next };
};

// Right: a closed folder or nest opens, and an open one hands the lead to its first child.
const inward = (view: KeyView): KeyIntent => {
    const at = leadRowAt(view);
    if (at === undefined || !opens(at.row)) {
        return NONE;
    }
    if (!at.row.isExpanded) {
        return { kind: `toggleExpand`, path: at.row.entry.path };
    }
    const child = view.rows[at.index + 1];
    return child !== undefined && !(`more` in child) && child.depth > at.row.depth ? { kind: `select`, path: child.entry.path } : NONE;
};

// Left: an open folder or nest closes; any other row hands the lead to the nearest shallower row above, which is the
// containing dir, or a nest parent for a folded file.
const outward = (view: KeyView): KeyIntent => {
    const at = leadRowAt(view);
    if (at === undefined) {
        return NONE;
    }
    if (opens(at.row) && at.row.isExpanded) {
        return { kind: `toggleExpand`, path: at.row.entry.path };
    }
    const above = view.rows.slice(0, at.index).findLast((row): row is Row => !(`more` in row) && row.depth < at.row.depth);
    return above === undefined ? NONE : { kind: `select`, path: above.entry.path };
};

// Up to the folder holding the lead (Finder's ⌘↑), whether or not the lead is an open folder itself.
const parent = (view: KeyView): KeyIntent => {
    const at = leadRowAt(view);
    const above = at === undefined ? undefined : view.rows.slice(0, at.index).findLast((row): row is Row => !(`more` in row) && row.depth < at.row.depth);
    return above === undefined ? NONE : { kind: `select`, path: above.entry.path };
};

// Enter behaves like a single click (preview), leaving the same one tab behind as clicking down the rows.
const enter = ({ lead, entryAt }: KeyView): KeyIntent => {
    const entry = lead === null ? undefined : entryAt(lead);
    return entry === undefined ? NONE : { kind: `activate`, entry };
};

// A rename names one entry, so a selection of several renames nothing.
const rename = ({ lead, selected }: KeyView): KeyIntent => (lead !== null && selected <= 1 ? { kind: `rename`, path: lead } : NONE);

// The arrows on a Mac: ⌘↑ up to the folder and ⌘↓ open, as Finder; ⌥↑ and ⌥↓ to the first and last row. Undefined for
// an arrow the Mac leaves as it is everywhere.
const vertical = (press: KeyPress, view: KeyView, delta: number): KeyIntent | undefined => {
    if (press.metaKey && !press.altKey && !press.ctrlKey && !press.shiftKey) {
        return delta < 0 ? parent(view) : enter(view);
    }
    if (press.altKey && !press.metaKey && !press.ctrlKey) {
        return jump(press, delta < 0 ? view.order[0] : view.order.at(-1));
    }
    return undefined;
};

const KEYS = new Map<string, (press: KeyPress, view: KeyView) => KeyIntent>([
    [`ArrowDown`, (press, view) => step(press, view, 1)],
    [`ArrowUp`, (press, view) => step(press, view, -1)],
    [`Home`, (press, view) => jump(press, view.order[0])],
    [`End`, (press, view) => jump(press, view.order.at(-1))],
    [`ArrowRight`, (press, view) => inward(view)],
    [`ArrowLeft`, (press, view) => outward(view)],
    [` `, (press, { lead }) => (lead === null ? NONE : { kind: `toggleSelected`, path: lead })],
    [`Enter`, (press, view) => enter(view)],
    [`Escape`, () => ({ kind: `deselect` })],
    [`Delete`, () => ({ kind: `delete` })],
    [`F2`, (press, view) => rename(view)],
]);

// The keys a Mac answers its own way, ahead of the shared table.
const MAC_KEYS = new Map<string, (press: KeyPress, view: KeyView) => KeyIntent | undefined>([
    [`Enter`, (press, view) => (press.metaKey || press.altKey || press.ctrlKey ? undefined : rename(view))],
    [` `, (press, view) => (press.metaKey || press.altKey || press.ctrlKey ? undefined : enter(view))],
    [`ArrowUp`, (press, view) => vertical(press, view, -1)],
    [`ArrowDown`, (press, view) => vertical(press, view, 1)],
    [`Backspace`, (press) => (press.metaKey && !press.altKey && !press.ctrlKey ? { kind: `delete` } : undefined)],
]);

// The letter a chord was pressed on, whatever Option typed there.
const letter = (press: KeyPress): string => letterOfCode(press.code) ?? press.key.toLowerCase();

// The primary-modifier letters: select all everywhere; a Mac's duplicate, and its move of what was copied.
const chordIntent = (press: KeyPress, view: KeyView): KeyIntent | undefined => {
    const key = letter(press);
    if (view.isMac && press.metaKey && press.altKey && !press.ctrlKey && !press.shiftKey && key === `v`) {
        return { kind: `moveHere` };
    }
    if (!primaryHeld(press, view.isMac) || press.altKey || press.shiftKey) {
        return undefined;
    }
    if (key === `a`) {
        return { kind: `selectAll` };
    }
    return view.isMac && key === `d` ? { kind: `duplicate` } : undefined;
};

export const keyIntent = (press: KeyPress, view: KeyView): KeyIntent | undefined => {
    if (view.isMac && MAC_KEYS.has(press.key)) {
        const intent = MAC_KEYS.get(press.key)?.(press, view);
        if (intent !== undefined) {
            return intent;
        }
    }
    // Alt with an arrow is the shell's (Alt+↑/↓ walks the rail), never the tree's.
    if (press.altKey && press.key.startsWith(`Arrow`)) {
        return undefined;
    }
    // A Mac's ⌘ with an arrow means something of its own (above), and a modified Space is no toggle there.
    // allow(modifier-tiers): on a Mac, ⌘ and ⌃ with an arrow are both someone else's (the tree's own above, Mission Control).
    if (view.isMac && (press.metaKey || press.ctrlKey) && (press.key.startsWith(`Arrow`) || press.key === ` `)) {
        return undefined;
    }
    return KEYS.get(press.key)?.(press, view) ?? chordIntent(press, view);
};
