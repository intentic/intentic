/* HOW A MODEL CATALOG IS ORDERED — one rule for every provider, because only one provider publishes an order
 * worth keeping.
 *
 * Anthropic's REST /v1/models answers newest-first: that IS a provider opinion, and Claude's catalog rides it
 * (claude-models.ts). Every other provider here is read through an OpenAI-compatible /v1/models — Codex and
 * Gemini via the bundled translator, Kimi via Moonshot — or out of xAI's "Did you mean" rejection, and those
 * endpoints publish a SET, not a ranking: they hand the ids back in whatever order their registry iterates,
 * which in practice is alphabetical. Reading that as a preference is what put "GPT 5.4 Mini" at the head of the
 * Codex group with GPT 5.6 below it, and what made a fresh Codex conversation start on whichever id happened to
 * sort first — models[0] is the provider default.
 *
 * So for those providers the order is DERIVED from the id, out of the only two facts an id reliably carries:
 * which TIER the model is (the adjective) and which RELEASE it is (the numbers). Both are provider-agnostic —
 * every vendor names its models the same way — which is what lets the daemon's four catalog services and the
 * web's picker share one rule instead of each inventing a local one. */

// A version-ish segment: digits and dots, optionally v-prefixed (`4`, `5.1`, `v2`, `20251001`). Everything else
// is a NAME segment and belongs to the family — which is what makes the split below exhaustive.
const VERSION_SEGMENT = /^v?[\d.]+$/;

// A date stamp rather than a version component: six digits or more (20251001, 250514). The distinction is not
// cosmetic — claude-opus-4-1-20250805 (Opus 4.1) and claude-opus-4-20250514 (Opus 4.0) compare as (4,1) vs (4)
// with the stamps held apart, and as (4,1,20250805) vs (4,20250514) — the OLDER model winning — without.
const DATE_SEGMENT = /^\d{6,}$/;

const segmentsOf = (id: string): string[] => id.split(/[-_]/);

// A model's FAMILY — its id with every version-ish segment dropped, so claude-opus-5 and claude-opus-4-8 land
// together (as do gpt-5.1/gpt-5, and claude-haiku-4-5-20251001 with its date suffix). Derived, never listed: a
// family that ships tomorrow groups itself. The id is the stable key here — labels get renamed, ids don't.
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
    // The id's date stamp, 0 for none — the tiebreak between two builds of the SAME version.
    readonly date: number;
}

export const releaseOf = (id: string): ModelRelease => {
    const numeric = segmentsOf(id)
        .filter((segment) => VERSION_SEGMENT.test(segment))
        .map((segment) => segment.replace(/^v/, ""));
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
 * ADJECTIVES rather than a table of ids — that scoping is the whole point, because a per-model ranking table
 * failed here once already. The words are the ones every vendor reaches for, so a release that ships tomorrow
 * ranks itself as long as it is named like its predecessors, and a release named some other way ranks as unknown.
 *
 * An UNKNOWN family LEADS rather than sinks, and that direction is the point: the ranking this replaced sank
 * unrecognized ids to a floor below the everyday tier, so a brand-new flagship sorted beneath the model it
 * replaced. An id carrying no tier word at all is the provider's BASE line (gpt-5.6, grok-4, kimi-k2) — which is
 * exactly the line a user reaches for — and a family nobody here has heard of is far likelier to be the next
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
    lite: 2,
    nano: 2,
    fast: 2,
    small: 2,
};

const UNRANKED = -1;

// The LAST recognized word wins, because tier words compose and the rightmost is the most specific one:
// gemini-flash-lite is the cheap end of Flash, gpt-codex-max the frontier end of Codex.
export const tierRankOf = (family: string): number => {
    let rank = UNRANKED;
    for (const segment of family.split("-")) {
        const found = TIER_RANK[segment];
        if (found !== undefined) {
            rank = found;
        }
    }
    return rank;
};

// The canonical order of two model ids: tier first, then release. Hand it straight to Array#toSorted — that sort
// is stable, so two ids this rule cannot separate keep the order they arrived in (for Claude, the provider's own).
export const compareModelIds = (left: string, right: string): number =>
    tierRankOf(familyOf(left)) - tierRankOf(familyOf(right)) || compareRelease(releaseOf(left), releaseOf(right));
