import { computed } from "vue";
import { registry } from "../fleet/useAgents-registry";

// Conversations carrying their work into this tree right now, read straight off the roster: the daemon raises `landing`
// when it takes the land lease and drops it once the patch is in the tree, so nothing here polls or infers.
// Only a land BETWEEN turns reads as `landing` (agents-registry.ts statusOf) — a turn's own end-of-turn land keeps the
// card `running`, and the rescan skip for that case is the streaming guard the review already has.

// A conversation with no title of its own; the review still has to name what it is waiting for.
const UNTITLED = `a conversation`;

/** A session carrying its work into this tree, and what to call it. */
export interface LandingAgent {
    readonly id: string;
    readonly title: string;
}

/** What is mid-land, roster order. Empty means nothing is being carried into this tree. */
export const landingAgents = computed<readonly LandingAgent[]>(() =>
    registry.value.filter((agent) => agent.status === `landing`).map((agent) => ({ id: agent.id, title: agent.title ?? UNTITLED })),
);

/** Titles of what is mid-land, roster order. */
export const landingNames = computed<readonly string[]>(() => landingAgents.value.map((agent) => agent.title));

/** A land is writing this tree: what parks the rescan, and what the review says instead of a claim about the tree. */
export const landingNow = computed<boolean>(() => landingNames.value.length > 0);

/** The line a strip or a tile shows for these titles, already phrased; undefined for none. */
export const landingLineOf = (names: readonly string[]): string | undefined => {
    const [first, ...rest] = names;
    if (first === undefined) {
        return undefined;
    }
    return rest.length === 0 ? `Landing ${first}` : `Landing ${first} and ${rest.length} more`;
};

/** The line for what is mid-land right now; undefined when nothing is landing. */
export const landingLine = computed<string | undefined>(() => landingLineOf(landingNames.value));
