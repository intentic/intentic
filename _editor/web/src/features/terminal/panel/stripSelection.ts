import { type ClickIntent, rangeSelect } from "../../../lib/multiSelect";

// The strip's multi-selection, VSCode-style, as one value only `stepSelection` moves, per group and keyed by the group's
// first session; it feeds only the context menu's mass actions.

type Groups = readonly (readonly string[])[];

export interface StripSelection {
    readonly keys: readonly string[];
    // The group a Shift range pivots on.
    readonly anchor: number | undefined;
}

type Click = { readonly kind: ClickIntent; readonly groups: Groups; readonly at: number; readonly active: number };

export type SelectionEvent =
    // A click on group `at`; a range pivots on the anchor, else the active group (-1 for none), else `at`.
    | Click
    // A right-click: inside the selection it acts on all of it, outside it retargets it (VSCode's list behaviour).
    | { readonly kind: `retarget`; readonly groups: Groups; readonly at: number }
    // A mass action ran: nothing stays selected, and the anchor stays where it was.
    | { readonly kind: `clear` };

export const NO_SELECTION: StripSelection = { keys: [], anchor: undefined };

export const groupKey = (group: readonly string[]): string => group[0] ?? ``;

export const selects = (selection: StripSelection, group: readonly string[]): boolean => selection.keys.includes(groupKey(group));

const CLICKS: { readonly [K in ClickIntent]: (selection: StripSelection, click: Click, group: readonly string[]) => StripSelection } = {
    range: (selection, { groups, at, active }, group) => {
        const from = selection.anchor ?? (active === -1 ? at : active);
        return { ...selection, keys: (rangeSelect(groups, groups[from], group) ?? []).map(groupKey) };
    },
    toggle: (selection, { at }, group) => ({
        keys: selects(selection, group) ? selection.keys.filter((kept) => kept !== groupKey(group)) : [...selection.keys, groupKey(group)],
        anchor: at,
    }),
    single: (_, { at }) => ({ keys: [], anchor: at }),
};

export const stepSelection = (selection: StripSelection, event: SelectionEvent): StripSelection => {
    if (event.kind === `clear`) {
        return { ...selection, keys: [] };
    }
    const group = event.groups[event.at] ?? [];
    if (event.kind === `retarget`) {
        return selects(selection, group) ? selection : { keys: [groupKey(group)], anchor: event.at };
    }
    return CLICKS[event.kind](selection, event, group);
};
