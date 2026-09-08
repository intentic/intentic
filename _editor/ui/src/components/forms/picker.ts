import type { IconName } from "../../icons/iconSets.js";
import type { PersonaLike } from "../brand/personaFace.js";

// Picker's option model: a flat list for simple choices, or labelled groups when options have families. Data, not
// markup; a custom glyph goes through the #icon slot instead.

export interface PickerOption<T extends string = string> {
    readonly value: T;
    readonly label: string;
    /** Quiet right-aligned annotation on the row (what Auto resolves to, a host's region, …). */
    readonly description?: string;
    // A wrapping sentence under the label, for options needing more than a name; `description` truncates instead.
    readonly hint?: string;
    /** Leading glyph for the row and the closed trigger. */
    readonly icon?: IconName;
    // Draws <PersonaFace> instead of a glyph, in row and trigger; wins over `icon` when both are set.
    readonly face?: PersonaLike;
    /** Monospace label, domains, repo paths, other machine names. */
    readonly mono?: boolean;
    readonly disabled?: boolean;
}

export interface PickerGroup<T extends string = string> {
    /** Omitted on an ungrouped leading block (e.g. an Auto row above the provider groups). */
    readonly label?: string;
    readonly options: readonly PickerOption<T>[];
}

export type PickerOptions<T extends string = string> = readonly PickerOption<T>[] | readonly PickerGroup<T>[];

/** Panel-instance id prefixes for aria-activedescendant wiring; a module counter keeps concurrent pickers apart. */
let uid = 0;
export const nextPickerId = (): string => `pk-${++uid}`;

/** Both accepted shapes, as the one the panel renders: a flat list becomes a single unlabelled group. */
export const normalizePickerGroups = <T extends string>(options: PickerOptions<T>): readonly PickerGroup<T>[] => {
    const first = options[0];
    if (first === undefined) {
        return [];
    }
    return `options` in first ? (options as readonly PickerGroup<T>[]) : [{ options: options as readonly PickerOption<T>[] }];
};
