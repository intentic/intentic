/* WHAT THE APP WOULD LIKE TO HAVE IN HAND ALREADY, declared by the surfaces that know, collected here.
 *
 * The loader next door does not know what an agent is, what a diff is, or which tiles are on the rail, and it
 * must not: a background reader that carries a list of the app's screens inside it is a list somebody has to
 * remember to extend, and the screen added without a line here is exactly the one that stays slow. So the
 * knowledge stays where it already lives, the board knows which cards are on it, the review knows which rows
 * it drew, and each of them contributes a WISH LIST that this file sorts into one plan.
 *
 * A wish is not a request. Every task carries `have`, which answers "is this already in hand?" without touching
 * the network, and the loader skips a satisfied one without spending a beat on it. That is what lets a source
 * declare its whole list once and leave it declared: a fully warm plan costs a few map lookups per beat, not a
 * round trip per entry.
 *
 * BANDS ARE THE ONLY PRIORITY MECHANISM. Not a number a source picks, because a number invites every source to
 * believe its own work is a 9, four named positions, each with a rule about WHERE THE USER IS, so a source
 * arguing for a higher band has to argue that the user is closer to it than it looks. */

// Where a wish sits relative to the screen the user is on. Ordered: `now` is drained before `near`, and so on
// down. Within a band the order is the order the sources were registered in, then the order each returned,
// which is the render order of the surface that owns it, so a list is warmed the way it is drawn.
export type WarmBand = "now" | "near" | "work" | "rail";

const BAND_ORDER: readonly WarmBand[] = [`now`, `near`, `work`, `rail`];

export interface WarmTask {
    /* Identity, for dedupe across sources. Two surfaces routinely want the same thing, the board wants an
     * agent's changes so its card can open instantly, the review panel wants them because it is showing them,
     * and warming it twice would be one wasted round trip per beat, forever. Stringified query keys are the
     * natural value here: they are already the app's identity for a cached read. */
    readonly key: string;
    readonly band: WarmBand;
    // True when this is already in hand, answered from the cache alone. See the header: this is what makes a
    // standing wish list cheap.
    readonly have: () => boolean;
    // Read it. Resolves when it is in hand; rejects if it could not be. Nothing here retries, see the loader.
    readonly read: () => Promise<unknown>;
}

export type WarmSource = () => readonly WarmTask[];

/* A CEILING ON THE WHOLE PLAN, not per source. A thousand-file review and a fifty-agent board are both real,
 * and a plan that grows with them turns every beat's scan into a walk over the whole workspace. Sources bound
 * their own lists too (a review reads the first rows, not every row), but that is a bound on what is WORTH
 * warming; this one is the bound on what the loader can be made to hold, and it is here so no source can lift
 * it by accident. Past it the tail is simply cold, which costs exactly what it cost before any of this
 * existed. */
export const PLAN_LIMIT = 400;

const sources = new Set<WarmSource>();

/** Contribute a wish list. Returns the disposer; a surface that unmounts must call it, or its list stays in
 *  the plan and the loader keeps warming a screen nobody can reach. */
export const registerWarmSource = (source: WarmSource): (() => void) => {
    sources.add(source);
    return () => void sources.delete(source);
};

// Tests and the sandbox switch: forget every contributor. A source outliving the workspace it describes is a
// plan for a sandbox the user has left.
export const clearWarmSources = (): void => sources.clear();

/* The plan, assembled fresh on demand, every source asked, results deduped by key and ordered by band.
 *
 * Asked EVERY BEAT rather than cached behind a reactive dependency graph, because the question it answers
 * ("what is worth having next?") depends on things no dependency graph covers: which queries hold data right
 * now, which of them were just invalidated, what the user did half a second ago. Sources are computed-backed,
 * so asking them again is a memo read; the assembly below is a sort of a few hundred entries. Both are far
 * cheaper than the alternative, warming something the user no longer needs because the plan was stale. */
export const warmPlan = (): readonly WarmTask[] => {
    const byKey = new Map<string, WarmTask>();
    for (const source of sources) {
        // A source that throws is a bug in that surface, not a reason for the loader to stop reading for every
        // other one. It contributes nothing this beat and is asked again on the next.
        let wishes: readonly WarmTask[] = [];
        try {
            wishes = source();
        } catch {
            continue;
        }
        for (const wish of wishes) {
            // FIRST DECLARATION WINS, and because sources are walked in registration order that is a stable
            // rule rather than a race. It is also the right one: a task's band is a claim about how close the
            // user is to it, and the surface that spoke first is the one closer to them.
            if (!byKey.has(wish.key)) {
                byKey.set(wish.key, wish);
            }
        }
    }
    const plan = [...byKey.values()].sort((left, right) => BAND_ORDER.indexOf(left.band) - BAND_ORDER.indexOf(right.band));
    return plan.length > PLAN_LIMIT ? plan.slice(0, PLAN_LIMIT) : plan;
};
