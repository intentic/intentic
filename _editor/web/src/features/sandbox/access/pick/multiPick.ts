import type { IconName } from "@intentic/ui";

// THE SHAPE OF A LONG PICK: sections (connections, stored secrets), and inside a section either plain options or a
// family of options that belong together (every Reddit account, every identity). Pure, so the picker's rules (what a
// search keeps, when a whole family counts as picked, which picks collapse into one chip) are read and tested here
// rather than in the template.

/** One thing that can be picked. */
export interface PickOption {
    readonly value: string;
    readonly label: string;
    /** Quiet words after the label on the same line: an area's folders. */
    readonly detail?: string | undefined;
    /** A right-aligned annotation: the service a connection is, who works in an area. */
    readonly note?: string | undefined;
    readonly noteIcon?: IconName | undefined;
    /** A name read as code: a secret's key, a path. */
    readonly mono?: boolean | undefined;
}

/** Options that belong together and can be picked as one: the accounts of one service. */
export interface PickFamily {
    readonly family: string;
    readonly label: string;
    /** The option whose mark stands for the whole family, on its header and its chip. */
    readonly lead: string;
    readonly options: readonly PickOption[];
}

export type PickEntry = PickOption | PickFamily;

export interface PickSection {
    readonly key: string;
    /** Omitted for the one unlabelled list a picker of a single kind draws. */
    readonly label?: string;
    /** The glyph a whole section's chip wears. */
    readonly icon?: IconName | undefined;
    readonly entries: readonly PickEntry[];
}

/** Up to this many options, every one is drawn as its own row; past it the picks show as chips and the rest is searched. */
export const INLINE_LIMIT = 8;
/** Chips drawn before the rest fold behind "+N more". */
export const CHIP_LIMIT = 12;

export const isFamily = (entry: PickEntry): entry is PickFamily => `family` in entry;

const optionsOf = (entries: readonly PickEntry[]): readonly PickOption[] =>
    entries.flatMap((entry) => (isFamily(entry) ? entry.options : [entry]));

export const valuesOf = (entries: readonly PickEntry[]): readonly string[] => optionsOf(entries).map((option) => option.value);

export const allOptions = (sections: readonly PickSection[]): readonly PickOption[] => sections.flatMap((section) => optionsOf(section.entries));

/** How much of a set is picked, which is what its header's box draws. */
export type PickState = `none` | `some` | `all`;

export const stateOf = (values: readonly string[], picked: ReadonlySet<string>): PickState => {
    const held = values.filter((value) => picked.has(value)).length;
    return held === 0 ? `none` : held === values.length ? `all` : `some`;
};

/** The picks with a set switched on or off as a whole, keeping the order the rest were picked in. */
export const withValues = (picked: readonly string[], values: readonly string[], on: boolean): string[] => {
    const without = picked.filter((value) => !values.includes(value));
    return on ? [...without, ...values] : without;
};

const words = (...parts: readonly (string | undefined)[]): string => parts.filter((part) => part !== undefined).join(` `).toLowerCase();

// A search keeps an option whose own words match, and a family whose name matches keeps all it holds, so "reddit" finds
// every Reddit account even when their names do not say so. A section's name keeps nothing by itself: it is a word too
// broad to search by ("s" is in "Stored secrets" and "Connections"), and its header already picks it whole.
export const filterSections = (sections: readonly PickSection[], query: string): readonly PickSection[] => {
    const needle = query.trim().toLowerCase();
    if (needle === ``) {
        return sections;
    }
    const hit = (option: PickOption): boolean => words(option.label, option.detail, option.note).includes(needle);
    return sections
        .map((section) => {
            const entries = section.entries.flatMap((entry): PickEntry[] => {
                if (!isFamily(entry)) {
                    return hit(entry) ? [entry] : [];
                }
                if (words(entry.label).includes(needle)) {
                    return [entry];
                }
                const options = entry.options.filter(hit);
                return options.length === 0 ? [] : [{ ...entry, options }];
            });
            return { ...section, entries };
        })
        .filter((section) => section.entries.length > 0);
};

/** One line of the open list. Headers that pick their whole set are lines the keyboard walks; a bare `label` is not. */
export type PickRow =
    | { readonly kind: `label`; readonly key: string; readonly text: string }
    | { readonly kind: `section`; readonly key: string; readonly section: PickSection; readonly values: readonly string[] }
    | { readonly kind: `family`; readonly key: string; readonly family: PickFamily; readonly values: readonly string[] }
    | { readonly kind: `option`; readonly key: string; readonly option: PickOption; readonly inFamily: boolean; readonly values: readonly string[] };

export type PickableRow = Exclude<PickRow, { kind: `label` }>;

export const pickable = (row: PickRow): row is PickableRow => row.kind !== `label`;

// A section's header picks the section only when it holds more than one: "all of one" is that one, so its name is
// drawn as a plain label instead.
export const rowsOf = (sections: readonly PickSection[]): readonly PickRow[] =>
    sections.flatMap((section): PickRow[] => {
        const values = valuesOf(section.entries);
        const head: PickRow[] =
            section.label === undefined
                ? []
                : values.length > 1
                  ? [{ kind: `section`, key: `s:${section.key}`, section, values }]
                  : [{ kind: `label`, key: `l:${section.key}`, text: section.label }];
        return [
            ...head,
            ...section.entries.flatMap((entry): PickRow[] =>
                isFamily(entry)
                    ? [
                          { kind: `family`, key: `f:${section.key}:${entry.family}`, family: entry, values: entry.options.map((option) => option.value) },
                          ...entry.options.map((option): PickRow => ({ kind: `option`, key: `o:${option.value}`, option, inFamily: true, values: [option.value] })),
                      ]
                    : [{ kind: `option`, key: `o:${entry.value}`, option: entry, inFamily: false, values: [entry.value] }],
            ),
        ];
    });

/** One chip under the picker: a single pick, or a whole family or section picked, said once with how many it holds. */
export interface PickChip {
    readonly key: string;
    readonly label: string;
    readonly values: readonly string[];
    /** Set when the chip stands for a whole set. */
    readonly count?: number;
    /** The option whose mark the chip wears. */
    readonly lead?: string | undefined;
    readonly icon?: IconName | undefined;
    readonly mono?: boolean | undefined;
}

// What the picks read as at a glance: a section picked whole is one chip, else a family picked whole is one chip, else
// each pick is its own. In the order the list draws them, not the order they were picked, so a chip is found where its
// row would be.
export const chipsOf = (sections: readonly PickSection[], picked: ReadonlySet<string>): readonly PickChip[] =>
    sections.flatMap((section): PickChip[] => {
        const values = valuesOf(section.entries);
        if (section.label !== undefined && values.length > 1 && stateOf(values, picked) === `all`) {
            return [{ key: `s:${section.key}`, label: section.label, values, count: values.length, icon: section.icon }];
        }
        return section.entries.flatMap((entry): PickChip[] => {
            if (isFamily(entry)) {
                const members = entry.options.map((option) => option.value);
                if (stateOf(members, picked) === `all`) {
                    return [{ key: `f:${section.key}:${entry.family}`, label: entry.label, values: members, count: members.length, lead: entry.lead }];
                }
            }
            return optionsOf([entry])
                .filter((option) => picked.has(option.value))
                .map((option) => ({ key: `o:${option.value}`, label: option.label, values: [option.value], lead: option.value, mono: option.mono }));
        });
    });
