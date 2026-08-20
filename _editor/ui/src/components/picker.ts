import type { IconName } from "../icons/iconSets.js";
import type { PersonaLike } from "./personaFace.js";

/* The Picker's option model. One shape serves every site: a flat list for simple choices (enum settings,
 * repo names) and labelled groups where the options have families (models per provider). Options are data,
 * not markup, a site needing a brand mark or other custom glyph renders it through the Picker's #icon slot. */

export interface PickerOption<T extends string = string> {
    readonly value: T;
    readonly label: string;
    /** Quiet right-aligned annotation on the row (what Auto resolves to, a host's region, …). */
    readonly description?: string;
    /* A SENTENCE under the label, for a choice whose options have to be TAUGHT rather than merely named,
     * access tiers, permission postures, anything where picking wrong is the expensive move. `description` is
     * the wrong slot for these: it is a trailing annotation that truncates, so a sentence arrived at the right
     * edge of the row with its verb cut off. A hint wraps instead, and only the row shows it, the closed
     * trigger stays one word wide. */
    readonly hint?: string;
    /** Leading glyph for the row and the closed trigger. */
    readonly icon?: IconName;
    /* THIS ROW IS A SOMEBODY, draw <PersonaFace> for it, in the row and in the closed trigger, instead of a
     * glyph. Data rather than markup like everything else here, and the reason it is a field rather than the
     * #icon slot: the two surfaces that pick a persona are extensions, so the "persona rows get a face, Nobody
     * gets a glyph" rule would have been hand-written in each of them and free to disagree, which is exactly
     * how the app came to have four different opinions about how a persona is drawn before <PersonaFace>
     * existed. A row carrying both `face` and `icon` draws the face: a name that belongs to a person outranks a
     * category glyph. */
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
