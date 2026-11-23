import { CAPABILITY_CATEGORIES, type CapabilityCategory } from "@intentic/capability-catalog";
import type { SkillOrigin, SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { t } from "@intentic/ui/i18n";
import { categoryLabel } from "../../../../models/capabilities/catalogCopy";
import { capabilityCategory } from "../../../../models/capabilities/tiles";
import type { SkillSources } from "./skillVisual";
import { provenanceOf } from "./skillWords";

// Orders, splits and filters the skills list. The reader's own words (written here, a role's kit, a file dropped into
// the workspace) are cards, each with room for its whole trigger line; everything that arrived with something else is
// a name on a shelf, grouped the way the Connections catalog groups the things that brought them, since that half grows
// with every account connected (four Product Hunt logins are four skills) and is read for what is there, not for its text.

/** The reader's own: written here, a role card's kit, or a file dropped into the workspace. Drawn as cards. */
export const isWorkspaceSkill = (skill: SkillSummary): boolean => skill.origin === `own` || skill.origin === `role` || skill.origin === `dropped`;

// Editorial, not alphabetical: own skills first, then unclaimed files and built-ins; installed before connected.
const ORIGIN_ORDER = {
    own: 0,
    // Directly under the reader's own: also their words, just scoped to one role's turns.
    role: 1,
    dropped: 2,
    builtin: 3,
    extension: 4,
    plugin: 5,
    capability: 6,
    // `satisfies` so a new origin in the daemon's enum is a build error here, not a silent default sort position.
} satisfies Record<SkillOrigin, number>;

export const bySection = (left: SkillSummary, right: SkillSummary): number =>
    ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin] || left.name.localeCompare(right.name);

// Matches name, trigger line and provenance word, so a shelved skill is still findable by what it came with.
const skillHaystack = (skill: SkillSummary): string => `${skill.name} ${skill.description} ${provenanceOf(skill)}`.toLowerCase();

export const matchesSkill = (skill: SkillSummary, needle: string): boolean => needle === `` || skillHaystack(skill).includes(needle);

/** One labelled line of names under the cards. */
export interface SkillShelf {
    readonly key: string;
    readonly label: string;
    readonly skills: readonly SkillSummary[];
}

// A connection's skill sits under its tile's catalog section; one whose connection is gone or unknown to the catalog,
// under a plain "Connections" after the sections.
type ShelfKey = CapabilityCategory | `connections` | `extensions` | `builtin`;
const SHELF_ORDER: readonly ShelfKey[] = [...CAPABILITY_CATEGORIES.map((category) => category.id), `connections`, `extensions`, `builtin`];

const shelfKeyOf = (skill: SkillSummary, sources: SkillSources): ShelfKey => {
    if (skill.origin === `builtin`) {
        return `builtin`;
    }
    if (skill.origin === `extension` || skill.origin === `plugin`) {
        return `extensions`;
    }
    const capability = sources.capabilities.find((entry) => entry.id === skill.owner);
    return (capability === undefined ? undefined : capabilityCategory(capability, sources.extensions)) ?? `connections`;
};

const shelfLabel = (key: ShelfKey): string => {
    if (key === `connections`) {
        return t(`sandbox.agentSkills.connections`);
    }
    if (key === `extensions`) {
        return t(`sandbox.agentSkills.extensionsPlugins`);
    }
    if (key === `builtin`) {
        return t(`sandbox.skillWords.builtin`);
    }
    const category = CAPABILITY_CATEGORIES.find((entry) => entry.id === key);
    return category === undefined ? key : categoryLabel(category);
};

/** Everything that is not the reader's own, grouped and ordered; empty shelves are left out. Names sort inside a shelf. */
export const shelvesOf = (skills: readonly SkillSummary[], sources: SkillSources): SkillShelf[] => {
    const held = new Map<ShelfKey, SkillSummary[]>();
    for (const skill of skills.filter((entry) => !isWorkspaceSkill(entry))) {
        const key = shelfKeyOf(skill, sources);
        held.set(key, [...(held.get(key) ?? []), skill]);
    }
    return SHELF_ORDER.flatMap((key) => {
        const shelved = held.get(key);
        return shelved === undefined ? [] : [{ key, label: shelfLabel(key), skills: shelved.toSorted((left, right) => left.name.localeCompare(right.name)) }];
    });
};

// The trigger line is the one sentence the agent reads every turn to decide whether to open a skill, so a doubt about it
// is worth a line under it. `empty`: nothing to match on. `vague`: short and naming no occasion, a label ("The summary
// scanner brief for Replay vision") rather than a "use when". English words only, so a trigger written in another
// language is never flagged by it: a missed doubt costs nothing, a wrong one teaches the reader to ignore the line.
const OCCASION = /\b(use|used|using|when|whenever|if|before|after|while|asks?|asked)\b/iu;
const VAGUE_UNDER = 90;

export type TriggerDoubt = `empty` | `vague`;

export const triggerDoubt = (description: string): TriggerDoubt | undefined => {
    const text = description.trim();
    if (text === ``) {
        return `empty`;
    }
    return text.length < VAGUE_UNDER && !OCCASION.test(text) ? `vague` : undefined;
};

export const triggerDoubtWords = (doubt: TriggerDoubt | undefined): string | undefined =>
    doubt === `empty` ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : doubt === `vague` ? t(`sandbox.agentSkills.saysWhatNotWhen`) : undefined;
