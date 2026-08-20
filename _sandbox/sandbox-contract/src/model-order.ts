/* HOW A MODEL CATALOG IS ORDERED, one rule for every provider, because only one provider publishes an order
 * worth keeping.
 *
 * Anthropic's REST /v1/models answers newest-first: that IS a provider opinion, and Claude's catalog rides it
 * (claude-models.ts). Every other provider here is read through an OpenAI-compatible /v1/models. Codex and
 * Gemini and Kimi via the bundled translator, or out of xAI's "Did you mean" rejection, and those
 * endpoints publish a SET, not a ranking: they hand the ids back in whatever order their registry iterates,
 * which in practice is alphabetical. Reading that as a preference is what put "GPT 5.4 Mini" at the head of the
 * Codex group with GPT 5.6 below it, and what made a fresh Codex conversation start on whichever id happened to
 * sort first, models[0] is the provider default.
 *
 * So for those providers the order is DERIVED from the id, out of the only two facts an id reliably carries:
 * which TIER the model is (the adjective) and which RELEASE it is (the numbers). Both are provider-agnostic,
 * every vendor names its models the same way, which is what lets the daemon's four catalog services and the
 * web's picker share one rule instead of each inventing a local one. */

// A version-ish segment: digits and dots, optionally prefixed by the vendor's version marker (`4`, `5.1`, `v2`,
// `k3`, `k2.7`, `20251001`). Kimi is the one provider that fuses the marker with the generation; treating `k3`
// as a name made the current flagship look unversioned, so K2.x sorted above it. Everything else is a NAME
// segment and belongs to the family, which is what makes the split below exhaustive.
const VERSION_SEGMENT = /^(?:v|k)?[\d.]+$/i;

// A date stamp rather than a version component: six digits or more (20251001, 250514). The distinction is not
// cosmetic, claude-opus-4-1-20250805 (Opus 4.1) and claude-opus-4-20250514 (Opus 4.0) compare as (4,1) vs (4)
// with the stamps held apart, and as (4,1,20250805) vs (4,20250514), the OLDER model winning, without.
const DATE_SEGMENT = /^\d{6,}$/;

const segmentsOf = (id: string): string[] => id.split(/[-_]/);

// A model's FAMILY, its id with every version-ish segment dropped, so claude-opus-5 and claude-opus-4-8 land
// together (as do gpt-5.1/gpt-5, and claude-haiku-4-5-20251001 with its date suffix). Derived, never listed: a
// family that ships tomorrow groups itself. The id is the stable key here, labels get renamed, ids don't.
export const familyOf = (id: string): string => {
    const stem = segmentsOf(id)
        .filter((segment) => !VERSION_SEGMENT.test(segment))
        .join("-");
    // An all-numeric id (and an ACP row's empty one) has no stem to speak of; it stands as its own family.
    return stem === "" ? id : stem;
};

export interface ModelRelease {
    // The version components in id order: gpt-5.1 → [5, 1], claude-opus-4-8 → [4, 8]. EMPTY for an unversioned
    // id (kimi-latest, gemini-pro-agent), which therefore reads as the oldest of its tier: a rolling alias names
    // no release, and inventing one for it would outrank the models that do name theirs.
    readonly version: readonly number[];
    // The id's date stamp, 0 for none, the tiebreak between two builds of the SAME version.
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

// Newest first. A missing component reads as -1, so gpt-5 sorts under gpt-5.1 and an unversioned id sorts under
// every versioned one; the date stamp breaks what is left.
const compareRelease = (left: ModelRelease, right: ModelRelease): number => {
    for (let index = 0; index < Math.max(left.version.length, right.version.length); index += 1) {
        const diff = (right.version[index] ?? -1) - (left.version[index] ?? -1);
        if (diff !== 0) {
            return diff;
        }
    }
    return right.date - left.date;
};

/* THE ONE CURATED FACT in this file, and the only one the providers publish nowhere the app can read: which tier
 * is the frontier and which is the cheap one. It ranks FAMILIES, never models, and it is a vocabulary of tier
 * ADJECTIVES rather than a table of ids, that scoping is the whole point, because a per-model ranking table
 * failed here once already. The words are the ones every vendor reaches for, so a release that ships tomorrow
 * ranks itself as long as it is named like its predecessors, and a release named some other way ranks as unknown.
 *
 * An UNKNOWN family LEADS rather than sinks, and that direction is the point: the ranking this replaced sank
 * unrecognized ids to a floor below the everyday tier, so a brand-new flagship sorted beneath the model it
 * replaced. An id carrying no tier word at all is the provider's BASE line (gpt-5.6, grok-4, kimi-k2), which is
 * exactly the line a user reaches for, and a family nobody here has heard of is far likelier to be the next
 * flagship than the next budget tier. Being wrong costs one row's position; being wrong the other way hides a
 * launch. */
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
    // Efficient: the cheap/fast end, the rung whose whole purpose is to cost less than the one above it.
    haiku: 2,
    // An open-weights model a vendor re-serves beside its own (gpt-oss-120b on Google's channel) is that rung by
    // construction: it is there to be the free/cheap option next to the frontier line, never the flagship. Without
    // it the id carries no tier word at all and would LEAD the section it sits in.
    oss: 2,
    lite: 2,
    nano: 2,
    fast: 2,
    small: 2,
};

const UNRANKED = -1;

/* Some providers name a capability ladder INSIDE one release instead of using the cross-release adjectives
 * above. Codex 5.6's Sol/Terra/Luna rows are that shape: they must remain together ahead of the older 5.5 line,
 * but their order is not an arbitrary id tiebreak. Sol is the strongest, followed by Terra, then Luna. Keeping
 * this as a separate rank lets release recency still win across generations (a future GPT 5.7 base model must
 * not be buried under a recognized 5.6 suffix), while the three siblings sort by their real tier. */
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

/* HOW HARD AN ID SAYS IT WILL THINK. A routed catalog does not publish one row per model, it publishes one row
 * per model PER THINKING LEVEL, spelling the level into the id: `gemini-3.6-flash-high` and
 * `gemini-3.5-flash-extra-low` are the same Flash at opposite ends of its reasoning budget.
 *
 * Which the ranking above cannot see at all, and that blind spot has a direction: `high` and `low` are both
 * unrecognized words, so two variants of one model tie on tier and the RELEASE tiebreak settles them, and the
 * newest variant a channel publishes is routinely the high one. The quick model, whose entire job is to be the
 * cheap rung, would therefore reach for the most expensive reading of the cheapest model it can find.
 *
 * That is not a small mis-sort. Thinking is the difference between a commit message that is in the box before
 * the user has finished reading the file list and one that arrives half a minute later, measured at ~2s versus
 * ~27s on the same model and the same diff (agent/one-shot.ts, which disables thinking for the rungs where a
 * request parameter can). For a routed rung there is no such parameter: the id IS the setting, so this ranking
 * is the only place the choice can be made.
 *
 * Read ONLY by the cheap-end order. A picker orders a catalog by what a person reaches for, and a person
 * pinning `-high` on purpose means it, see compareCheapestFirst for the seam this belongs to. */
const THINKING_RANK: Readonly<Record<string, number>> = {
    minimal: 0,
    none: 0,
    low: 1,
    medium: 3,
    high: 4,
    max: 4,
    // Not a level but a switch, and the loudest statement an id can make about this: a channel that vends
    // `kimi-k2` beside `kimi-k2-thinking` is naming the same model with its reasoning turned on.
    thinking: 4,
};

/* An id naming NO level sits between the two ends rather than at either, the provider's own default, which for
 * a model that can think is usually some thinking. Ranking it cheapest would seat a silent default ahead of an
 * id that explicitly says `minimal`, and ranking it dearest would bury every model whose channel publishes no
 * variants at all (Anthropic's, Kimi's) beneath one that does. Neither is what the id claims. */
const UNSTATED_THINKING = 2;

const thinkingRankOf = (family: string): number => {
    const rank = lastRankOf(family, THINKING_RANK);
    return rank === UNRANKED ? UNSTATED_THINKING : rank;
};

// The LAST recognized word wins, because tier words compose and the rightmost is the most specific one:
// gemini-flash-lite is the cheap end of Flash, gpt-codex-max the frontier end of Codex.
export const tierRankOf = (family: string): number => lastRankOf(family, TIER_RANK);

// The canonical order of two model ids: broad tier first, then release, then a tier declared within that release.
// Hand it straight to Array#toSorted, that sort is stable, so two ids this rule cannot separate keep the order
// they arrived in (for Claude, the provider's own).
export const compareModelIds = (left: string, right: string): number => {
    const leftFamily = familyOf(left);
    const rightFamily = familyOf(right);
    return (
        tierRankOf(leftFamily) - tierRankOf(rightFamily) ||
        compareRelease(releaseOf(left), releaseOf(right)) ||
        releaseTierRankOf(leftFamily) - releaseTierRankOf(rightFamily)
    );
};

/* The order for a catalog its endpoint published as a SET. Codex, Gemini, Kimi and Grok, i.e. everything but
 * Anthropic's ranked list. Falling back on arrival order is what the rule above does with a tie, and for a RANKED
 * catalog that is exactly right: the tie is the provider's own opinion, so claude-opus-5 stays ahead of
 * claude-fable-5. For a set there is no opinion to keep, and the header of this file assumed the leftover order
 * was at least alphabetical, it is not. A subscription can hand tied rows back in whatever order its registry
 * iterated THIS request, so the tie decides which model a fresh conversation opens on and can flip between
 * catalog refreshes.
 *
 * So a set breaks its own ties on the id. Which sibling that seats first is arbitrary, but it is the same
 * arbitrary answer every refresh, which is the property `default` actually needs. */
export const compareUnrankedModelIds = (left: string, right: string): number => compareModelIds(left, right) || left.localeCompare(right);

/* THE SAME TIER SCALE READ FROM THE OTHER END, for the one caller that wants the WEAKEST model rather than the
 * strongest: the quick model behind an automatic helper (the commit message written at land time). A picker
 * orders a catalog by what a user reaches for; this orders it by what a helper should spend, and the two are
 * exact opposites, so they share TIER_RANK rather than each naming its own list of cheap ids.
 *
 * The direction of UNRANKED is the reason this can't just be compareModelIds reversed. There, an unrecognized
 * family LEADS, because an id carrying no tier word is the provider's base line and a family nobody here has
 * heard of is likelier the next flagship than the next budget tier. Reversing would therefore seat exactly that
 * unknown-probably-flagship id as the cheap pick. So unknown sinks to LAST here too, both orders agree it is
 * not the efficient rung, and the cheap end is only ever a family whose tier word is actually recognized.
 * Falling off the end of a catalog with no efficient tier at all (Kimi publishes none) is then honest: the
 * newest of what it does publish, chosen by the release tiebreak below. */
export const compareCheapestFirst = (left: string, right: string): number => {
    const leftFamily = familyOf(left);
    const rightFamily = familyOf(right);
    return (
        tierRankOf(rightFamily) - tierRankOf(leftFamily) ||
        // BEFORE release, and that placement is the point: two rows of one model differing only in thinking
        // level are the same model, so recency has nothing to say between them, and letting it speak is what
        // seated the high variant. Tier still wins over both, a thinking Haiku is cheaper than a silent Opus.
        thinkingRankOf(leftFamily) - thinkingRankOf(rightFamily) ||
        compareRelease(releaseOf(left), releaseOf(right)) ||
        releaseTierRankOf(rightFamily) - releaseTierRankOf(leftFamily)
    );
};

/* WOULD RUNNING THIS ID MAKE THE MODEL THINK, as far as its name admits, which for a routed catalog is as far
 * as anyone can tell without running it. True only for an id that spells out a level ABOVE the quiet end, so an
 * ordinary id nobody has annotated (claude-haiku-4-5, kimi-k2) is never accused of it.
 *
 * Exported for one job: a settings row that lets someone pin the quick model has to be able to say that the row
 * they picked is the thinking one. The ordering above keeps Auto off these by construction; a PIN is a
 * deliberate choice and is honoured as written, which only works if the choice is legible when it is made. */
export const namesThinking = (id: string): boolean => thinkingRankOf(familyOf(id)) > UNSTATED_THINKING;
