import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";

// Which shelf an automation is filed on, so a page of fifty reads as a handful of named groups rather than two buckets.
// In order: the group it names itself, then the code chores, then the persona it runs as (a set of jobs one role runs is
// one shelf without anybody naming it), then everything else. Shelves are keyed by their label, folded, so a group
// somebody named "Marketing" and the jobs the Marketing persona runs land on the one shelf rather than two of one name.

export type ShelfKind = `group` | `chores` | `persona` | `other`;

export interface ShelfOf {
    readonly key: string;
    readonly label: string;
    readonly kind: ShelfKind;
}

export interface Shelf extends ShelfOf {
    readonly automations: readonly AutomationSummary[];
    readonly on: number;
    readonly failing: number;
}

// The shelf no automation names: the remainder.
const OTHER_KEY = `other`;

export interface ShelfWords {
    readonly chores: string;
    readonly other: string;
    // A persona's display name by id; undefined for one this sandbox does not hold (gone, or not read yet).
    readonly personaLabel: (id: string) => string | undefined;
}

const keyOf = (label: string): string => label.trim().toLocaleLowerCase();

export const shelfOf = (automation: Pick<AutomationSummary, `group` | `chore` | `actsAs`>, words: ShelfWords): ShelfOf => {
    const named = automation.group?.trim();
    if (named !== undefined && named !== ``) {
        return { key: keyOf(named), label: named, kind: `group` };
    }
    if (automation.chore === true) {
        return { key: keyOf(words.chores), label: words.chores, kind: `chores` };
    }
    // A persona that is gone still names the shelf, by its id: the row already says the persona is missing, and filing it
    // under "Other" would hide which jobs went with it.
    if (automation.actsAs !== undefined) {
        const label = words.personaLabel(automation.actsAs) ?? automation.actsAs;
        return { key: keyOf(label), label, kind: `persona` };
    }
    return { key: OTHER_KEY, label: words.other, kind: `other` };
};

// A last run that failed, on an automation still switched on: the one state on this page that wants somebody.
export const isFailing = (automation: Pick<AutomationSummary, `enabled` | `runs`>): boolean =>
    automation.enabled && automation.runs[0]?.outcome === `error`;

// The order shelves are read in: alphabetical, so a shelf never moves when a run lands, with the remainder last. A shelf
// named by a group outranks a persona's label for how it is spelled, since somebody typed it.
export const shelvesOf = (automations: readonly AutomationSummary[], words: ShelfWords): Shelf[] => {
    const byKey = new Map<string, { of: ShelfOf; automations: AutomationSummary[] }>();
    for (const automation of automations) {
        const of = shelfOf(automation, words);
        const held = byKey.get(of.key);
        if (held === undefined) {
            byKey.set(of.key, { of, automations: [automation] });
        } else {
            held.automations.push(automation);
            if (of.kind === `group` && held.of.kind !== `group`) {
                held.of = of;
            }
        }
    }
    return [...byKey.values()]
        .map(({ of, automations: filed }) => ({
            ...of,
            automations: filed,
            on: filed.filter((automation) => automation.enabled).length,
            failing: filed.filter(isFailing).length,
        }))
        .toSorted((left, right) => Number(left.kind === `other`) - Number(right.kind === `other`) || left.label.localeCompare(right.label));
};

// What a row says under its name: its own one-line note, else the prompt's first line. A note that opens by naming the
// shelf it already sits on ("Marketing: replies on X" under Marketing, "Growth: …" under "Owen · Growth") drops that,
// since the heading above it just said so.
const LEAD = /^([^:\u2013\u2014\n]{1,40}?)\s*[:\u2013\u2014]\s+(.+)$/su;
export const gistOf = (automation: Pick<AutomationSummary, `note` | `prompt`>, shelfLabel: string | undefined): string => {
    const note = automation.note?.trim();
    if (note !== undefined && note !== ``) {
        const lead = LEAD.exec(note);
        const named = lead?.[1]?.trim().toLocaleLowerCase();
        const sitsOn = named !== undefined && named !== `` && shelfLabel?.toLocaleLowerCase().includes(named) === true;
        return sitsOn ? (lead?.[2] ?? note) : note;
    }
    return automation.prompt.split(`\n`).find((line) => line.trim() !== ``)?.trim() ?? ``;
};
