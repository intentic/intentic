import type {
    BrowsingEntry,
    BrowsingForgetInput,
    BrowsingForgetResult,
    BrowsingHistory,
    BrowsingHistoryQuery,
    BrowsingTerm,
    SearchSuggestQuery,
    SearchSuggestions,
} from "@intentic/sandbox-contract/schemas/browsing";

// Where the demo's browsers have been: the visitor's own window (`_own`, with the home router the address bar completes
// "192" to) and the agents' browser (`web`), kept apart as the daemon keeps them. Answered whole every time, with a
// forget that takes pages out for the rest of the visit; the search engine's suggestions are a few canned completions.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Seed {
    readonly url: string;
    readonly title?: string;
    readonly visits: number;
    readonly typed: number;
    // How long ago it was last visited.
    readonly ago: number;
}

const OWN: readonly Seed[] = [
    { url: `http://192.168.0.168/`, title: `FRITZ!Box`, visits: 14, typed: 9, ago: 12 * MINUTE },
    { url: `http://192.168.0.168/net/home.lua`, title: `FRITZ!Box · Home Network`, visits: 3, typed: 0, ago: 11 * MINUTE },
    { url: `https://github.com/intentic/intentic/pulls`, title: `Pull requests · intentic/intentic`, visits: 22, typed: 2, ago: 40 * MINUTE },
    { url: `https://github.com/`, title: `GitHub`, visits: 31, typed: 12, ago: 2 * HOUR },
    { url: `https://vuejs.org/guide/introduction.html`, title: `Introduction | Vue.js`, visits: 6, typed: 0, ago: 3 * HOUR },
    { url: `https://router.vuejs.org/guide/advanced/navigation-guards`, title: `Navigation Guards | Vue Router`, visits: 2, typed: 0, ago: 3 * HOUR + 5 * MINUTE },
    { url: `https://docs.stripe.com/api/checkout/sessions`, title: `Checkout Sessions | Stripe API`, visits: 4, typed: 0, ago: 5 * HOUR },
    { url: `https://news.ycombinator.com/`, title: `Hacker News`, visits: 18, typed: 7, ago: DAY + 2 * HOUR },
    {
        url: `https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout`,
        title: `CSS flexible box layout - CSS | MDN`,
        visits: 3,
        typed: 0,
        ago: DAY + 4 * HOUR,
    },
    { url: `https://www.youtube.com/watch?v=jfKfPfyJRdk`, title: `lofi hip hop radio 📚 beats to relax/study to`, visits: 5, typed: 0, ago: DAY + 6 * HOUR },
    { url: `https://search.brave.com/search?q=fritzbox+port+forwarding`, title: `fritzbox port forwarding - Brave Search`, visits: 1, typed: 1, ago: 2 * DAY },
    { url: `https://en.wikipedia.org/wiki/Gda%C5%84sk`, title: `Gdańsk - Wikipedia`, visits: 2, typed: 0, ago: 3 * DAY },
    { url: `https://acme-shop.test/pricing`, title: `Pricing · acme`, visits: 7, typed: 1, ago: 6 * DAY },
];

const AGENTS: readonly Seed[] = [
    { url: `https://acme-shop.test/pricing`, title: `Pricing · acme`, visits: 3, typed: 3, ago: 4 * MINUTE },
    { url: `https://checkout.stripe.com/c/pay/cs_test_a1F9k2`, title: `Checkout · acme`, visits: 2, typed: 0, ago: 3 * MINUTE },
    { url: `https://docs.stripe.com/api/checkout/sessions`, title: `Checkout Sessions | Stripe API`, visits: 1, typed: 1, ago: 6 * MINUTE },
    { url: `https://acme-shop.test/signup`, title: `Sign up · acme`, visits: 4, typed: 1, ago: 22 * MINUTE },
];

const TERMS: readonly (Omit<BrowsingTerm, `last`> & { readonly ago: number })[] = [
    { term: `fritzbox port forwarding`, count: 1, ago: 2 * DAY },
    { term: `vue router navigation guards`, count: 2, ago: 3 * HOUR },
];

const SEEDS = new Map<string, readonly Seed[]>([
    [`_own`, OWN],
    [`web`, AGENTS],
]);

// Pages forgotten during this visit, by profile; a forget of everything forgets the profile's seeds whole.
const forgotten = new Map<string, Set<string>>();
let cleared = new Set<string>();
let revision = 0;

const entryOf = (seed: Seed, now: number): BrowsingEntry => {
    const entry: BrowsingEntry = {
        url: seed.url,
        visits: seed.visits,
        typed: seed.typed,
        last: now - seed.ago,
        // Roughly the daemon's: the count times a recent visit's worth, typed visits counting double.
        frecency: (seed.visits + seed.typed) * (seed.ago < 4 * DAY ? 100 : 70),
    };
    return seed.title === undefined ? entry : { ...entry, title: seed.title };
};

export const demoBrowsingHistory = ({ profile }: BrowsingHistoryQuery): BrowsingHistory => {
    const now = Date.now();
    const gone = forgotten.get(profile) ?? new Set();
    const entries = cleared.has(profile) ? [] : (SEEDS.get(profile) ?? []).filter((seed) => !gone.has(seed.url)).map((seed) => entryOf(seed, now));
    return {
        profile,
        cursor: `demo.${revision}`,
        full: true,
        entries: entries.toSorted((left, right) => right.frecency - left.frecency),
        removed: [],
        terms: profile === `_own` && !cleared.has(profile) ? TERMS.map(({ ago, ...term }) => ({ ...term, last: now - ago })) : [],
        profiles: [...SEEDS.keys()],
    };
};

export const demoForgetBrowsing = ({ profile, forget }: BrowsingForgetInput): BrowsingForgetResult => {
    revision += 1;
    const before = demoBrowsingHistory({ profile }).entries;
    if (forget.kind === `all`) {
        cleared = new Set([...cleared, profile]);
        return { removed: before.length };
    }
    const gone = forgotten.get(profile) ?? new Set<string>();
    for (const entry of before) {
        if (forget.kind === `urls` ? forget.urls.includes(entry.url) : entry.last >= forget.from && entry.last < forget.to) {
            gone.add(entry.url);
        }
    }
    forgotten.set(profile, gone);
    return { removed: before.length - demoBrowsingHistory({ profile }).entries.length };
};

// A few completions an engine would plausibly offer, so the dropdown's last rows have something to show.
const COMPLETIONS = [`login`, `settings`, `docs`, `github`, `tutorial`];

export const demoSearchSuggestions = ({ q }: SearchSuggestQuery): SearchSuggestions => {
    const text = q.trim().toLowerCase();
    return { q, suggestions: text === `` ? [] : COMPLETIONS.map((word) => `${text} ${word}`).slice(0, 4) };
};
