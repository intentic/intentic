import { computed } from "vue";
import { registry } from "../../agents/fleet/useAgents-registry";

// Conversations carrying their work into this tree right now, read straight off the roster: the daemon raises `landing`
// when it takes the land lease and drops it once the patch is in the tree, so nothing here polls or infers.
// Only a land BETWEEN turns reads as `landing` (agents-registry.ts statusOf) — a turn's own end-of-turn land keeps the
// card `running`, and the rescan skip for that case is the streaming guard the review already has.

// A conversation with no title of its own; the review still has to name what it is waiting for.
const UNTITLED = `a conversation`;

/** Titles of what is mid-land, roster order. Empty means nothing is being carried into this tree. */
export const landingNames = computed<readonly string[]>(() =>
    registry.value.filter((agent) => agent.status === `landing`).map((agent) => agent.title ?? UNTITLED),
);

/** A land is writing this tree: what parks the rescan, and what the review says instead of a claim about the tree. */
export const landingNow = computed<boolean>(() => landingNames.value.length > 0);

/** The line a strip or a tile shows, already phrased; undefined when nothing is landing. */
export const landingLine = computed<string | undefined>(() => {
    const [first, ...rest] = landingNames.value;
    if (first === undefined) {
        return undefined;
    }
    return rest.length === 0 ? `Landing ${first}` : `Landing ${first} and ${rest.length} more`;
});
