import type { SkillOrigin, SkillSummary } from "@intentic-app/api-contract";
import { provenanceOf } from "./skillWords";

/* HOW THE SKILLS LIST IS ORDERED AND SPLIT, and what its filter matches. What each origin is CALLED is
 * skillWords.ts and what it looks like is skillVisual.ts; this is the third question the same enum answers,
 * where a row goes.
 *
 * THE LIST HOLDS TWO KINDS OF ROW AND ONLY ONE OF THEM IS TUNING. The group exists for an act: read down it, see
 * what you don't recognise, switch it off. That act is possible on exactly the rows the daemon marked
 * `switchable` or `removable`, the reader's own skills, the baked tools, and the loose files nobody claims.
 * Everything else is on because an extension, a plugin or a connection is on; its row names that owner and
 * offers no control, because a switch that could not honour a click is worse than no switch.
 *
 * AND THE SECOND KIND IS THE ONE THAT GROWS WITHOUT LIMIT. Every account somebody connects ships its cheatsheet,
 * so a sandbox with twenty connections has a list where the twelve rows that can be tuned are somewhere inside
 * forty. Splitting on "can I act on this here" is what lets the surface fold the half that is an inventory and
 * keep the half that is work, the same line the Secrets tab draws between the owner's values and the
 * credentials its connections hold.
 *
 * FOLDED IS NOT GONE, and that matters more here than there: a borrowed skill still spends the agent's attention
 * on every turn. The fold states its count and opens on any search, so "what is my agent carrying" is still
 * answered in full, it just stops being answered at the length of the connection list. */

/** Whether this surface can do anything about a skill, the line the fold is drawn on. */
export const isTunable = (skill: SkillSummary): boolean => skill.switchable || skill.removable;

/* Order inside each half. Editorial, not alphabetical: above the fold it is what the reader wrote, then what
 * nobody claims (the row most worth noticing and the least likely to exist), then what the image bakes in.
 * Below it, the things they installed before the things they connected, connections are the numerous half, and
 * a list that opens on twenty of them buries the two extensions among them. */
const ORIGIN_ORDER = {
    own: 0,
    // A persona's own, directly under the reader's: it is text they wrote, and the only difference is that it
    // applies to one card's turns rather than to every chat, which the chip says.
    persona: 1,
    dropped: 2,
    builtin: 3,
    extension: 4,
    plugin: 5,
    capability: 6,
    // `satisfies`, so an origin added to the daemon's enum is a build error here rather than a row that sorts
    // to the front of the list by accident.
} satisfies Record<SkillOrigin, number>;

export const bySection = (left: SkillSummary, right: SkillSummary): number =>
    ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin] || left.name.localeCompare(right.name);

/* WHAT THE FILTER MATCHES: everything the row shows. The name and the trigger line are the obvious half; the
 * provenance chip is the other one, and it is what a reader actually types, "connection", "producthunt", the
 * extension they are trying to account for. Searching only the name would make this list findable exactly to the
 * extent it is already scannable, which is backwards for the rows that are folded away. */
const skillHaystack = (skill: SkillSummary): string => `${skill.name} ${skill.description} ${provenanceOf(skill)}`.toLowerCase();

export const matchesSkill = (skill: SkillSummary, needle: string): boolean => needle === `` || skillHaystack(skill).includes(needle);
