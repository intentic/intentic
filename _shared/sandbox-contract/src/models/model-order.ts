// Orders a model catalog the same way for every provider, since only Anthropic's /v1/models returns one worth keeping.
// Every other provider hands back a set in registry order, so this file derives an order instead, from the two facts an
// id reliably carries: tier (the adjective) and release (the numbers).

// A version-ish segment: digits/dots, optionally prefixed by v or k (`5.1`, `k3`); anything else is a name.
const VERSION_SEGMENT = /^(?:v|k)?[\d.]+$/i;

// A date stamp, not a version component: 6+ digits; conflating the two misorders a dated build's compare.
const DATE_SEGMENT = /^\d{6,}$/;

const segmentsOf = (id: string): string[] => id.split(/[-_]/);

// A model's family: its id with every version-ish segment dropped, so claude-opus-5 and claude-opus-4-8 land together.
// Derived, never listed.
export const familyOf = (id: string): string => {
    const stem = segmentsOf(id)
        .filter((segment) => !VERSION_SEGMENT.test(segment))
        .join("-");
    // An all-numeric id, or an ACP row's empty one, has no stem: it stands as its own family.
    return stem === "" ? id : stem;
};

export interface ModelRelease {
    // Version components in id order; empty for an unversioned id, which then reads as the oldest of its tier.
    readonly version: readonly number[];
    // The id's date stamp, 0 for none: the tiebreak between two builds of the same version.
    readonly date: number;
}

export const releaseOf = (id: string): ModelRelease => {
    const numeric = segmentsOf(id)
        .filter((segment) => VERSION_SEGMENT.test(segment))
        .map((segment) => segment.replace(/^[vk]/i, ""));
    const stamps = numeric.filter((segment) => DATE_SEGMENT.test(segment)).map(Number);
    return {
        version: numeric
            .filter((segment) => !DATE_SEGMENT.test(segment))
            .flatMap((segment) => segment.split(".").map(Number))
            .filter((component) => Number.isFinite(component)),
        date: Math.max(0, ...stamps),
    };
};

// Newest first. A missing component reads as -1, so gpt-5 sorts under gpt-5.1; the date stamp breaks the rest.
const compareRelease = (left: ModelRelease, right: ModelRelease): number => {
    for (let index = 0; index < Math.max(left.version.length, right.version.length); index += 1) {
        const diff = (right.version[index] ?? -1) - (left.version[index] ?? -1);
        if (diff !== 0) {
            return diff;
        }
    }
    return right.date - left.date;
};

// Unranked families lead, not sink: an id with no tier word is likelier a new flagship than a budget model.
const TIER_RANK: Readonly<Record<string, number>> = {
    // Frontier: the tier a vendor ships last and charges most for.
    opus: 0,
    fable: 0,
    pro: 0,
    max: 0,
    ultra: 0,
    heavy: 0,
    // Everyday: the workhorse a step below the frontier.
    sonnet: 1,
    flash: 1,
    mini: 1,
    // Efficient: the cheap/fast end, the rung that costs less than the one above it.
    haiku: 2,
    // An open-weights model re-served beside a vendor's line (gpt-oss on Google's) is this rung by construction.
    oss: 2,
    lite: 2,
    nano: 2,
    fast: 2,
    small: 2,
};

const UNRANKED = -1;

// A release-local ladder (Codex 5.6 sol>terra>luna), kept separate so cross-release recency still outranks it.
const RELEASE_TIER_RANK: Readonly<Record<string, number>> = {
    sol: 0,
    terra: 1,
    luna: 2,
};

const lastRankOf = (family: string, ranks: Readonly<Record<string, number>>): number => {
    let rank = UNRANKED;
    for (const segment of family.split("-")) {
        const found = ranks[segment];
        if (found !== undefined) {
            rank = found;
        }
    }
    return rank;
};

const releaseTierRankOf = (family: string): number => lastRankOf(family, RELEASE_TIER_RANK);

// How hard an id says it will think; ties on tier, so only compareCheapestFirst's tiebreak may read it.
const THINKING_RANK: Readonly<Record<string, number>> = {
    minimal: 0,
    none: 0,
    low: 1,
    medium: 3,
    high: 4,
    max: 4,
    // A switch, not a level: vending `kimi-k2` beside `kimi-k2-thinking` names the same model, reasoning turned on.
    thinking: 4,
};

// An id naming no level sits between both ends, the provider's default, not the cheapest or dearest reading.
const UNSTATED_THINKING = 2;

const thinkingRankOf = (family: string): number => {
    const rank = lastRankOf(family, THINKING_RANK);
    return rank === UNRANKED ? UNSTATED_THINKING : rank;
};

// The last recognized word wins: gemini-flash-lite is Flash's cheap end, gpt-codex-max is Codex's frontier end.
export const tierRankOf = (family: string): number => lastRankOf(family, TIER_RANK);

// The canonical order of two ids: tier first, then release, then a release-local tier. Stable under Array#toSorted, so
// ids this rule cannot separate keep their arrival order.
export const compareModelIds = (left: string, right: string): number => {
    const leftFamily = familyOf(left);
    const rightFamily = familyOf(right);
    return (
        tierRankOf(leftFamily) - tierRankOf(rightFamily) ||
        compareRelease(releaseOf(left), releaseOf(right)) ||
        releaseTierRankOf(leftFamily) - releaseTierRankOf(rightFamily)
    );
};

// The order for a catalog its endpoint published as an unordered set (everything but Anthropic). Ties break on id, not
// arrival order, since a registry can reorder a tied set between refreshes.
export const compareUnrankedModelIds = (left: string, right: string): number => compareModelIds(left, right) || left.localeCompare(right);

// The same tier scale read from the weakest end, for the caller that wants the cheapest model, not the strongest. An
// unranked family still sinks last on both orders; a tier-less catalog (Kimi) falls back to its newest release.
export const compareCheapestFirst = (left: string, right: string): number => {
    const leftFamily = familyOf(left);
    const rightFamily = familyOf(right);
    return (
        tierRankOf(rightFamily) - tierRankOf(leftFamily) ||
        // Before release: two rows differing only by thinking are the same model; recency must not pick between them.
        thinkingRankOf(leftFamily) - thinkingRankOf(rightFamily) ||
        compareRelease(releaseOf(left), releaseOf(right)) ||
        releaseTierRankOf(rightFamily) - releaseTierRankOf(leftFamily)
    );
};

// Tier only, not release or thinking level, so a downgrade stays legible as one. An unranked family is false on either
// side: an unranked candidate might be the next flagship, and an unranked pick's tier is unknown to have been beaten.
export const isCheaperRung = (candidate: string, pick: string): boolean => {
    const candidateRank = tierRankOf(familyOf(candidate));
    const pickRank = tierRankOf(familyOf(pick));
    return candidateRank !== UNRANKED && pickRank !== UNRANKED && candidateRank > pickRank;
};

// True only for an id that spells out a level above the quiet end, so an unannotated id is never accused of it.
// Exported so a settings row can label a pinned thinking variant.
export const namesThinking = (id: string): boolean => thinkingRankOf(familyOf(id)) > UNSTATED_THINKING;
