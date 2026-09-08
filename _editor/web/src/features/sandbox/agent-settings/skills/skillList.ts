import type { SkillOrigin, SkillSummary } from "@intentic/api-contract";
import { provenanceOf } from "./skillWords";

// Orders, splits and filters the skills list. Only switchable or removable rows are tunable; everything else
// (installed via an extension, plugin or connection) is folded, since that half grows without limit. Folded is
// not hidden: the fold states its count and opens on any search.

/** Whether this surface can act on a skill; the line the fold is drawn on. */
export const isTunable = (skill: SkillSummary): boolean => skill.switchable || skill.removable;

// Editorial, not alphabetical: own skills first, then unclaimed files and built-ins; installed before connected.
const ORIGIN_ORDER = {
    own: 0,
    // Directly under the reader's own: also their words, just scoped to one persona's turns.
    persona: 1,
    dropped: 2,
    builtin: 3,
    extension: 4,
    plugin: 5,
    capability: 6,
    // `satisfies` so a new origin in the daemon's enum is a build error here, not a silent default sort position.
} satisfies Record<SkillOrigin, number>;

export const bySection = (left: SkillSummary, right: SkillSummary): number =>
    ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin] || left.name.localeCompare(right.name);

// Matches name, trigger line and provenance chip, so folded rows are still findable by what they came with.
const skillHaystack = (skill: SkillSummary): string => `${skill.name} ${skill.description} ${provenanceOf(skill)}`.toLowerCase();

export const matchesSkill = (skill: SkillSummary, needle: string): boolean => needle === `` || skillHaystack(skill).includes(needle);
