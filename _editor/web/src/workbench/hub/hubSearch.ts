import type { IconName } from "@intentic/ui";
import { nameScore } from "../commands/commandSearch";

// FINDING A SETTING BY NAME, in either hub. The hubs' indexes (sandboxNav.ts, settingsNav.ts) name pages; a setting sits
// further down, on a card inside a page, sometimes behind the page's own category (`?section=`), and often in the hub
// the reader did not open: Voice is the wake word under Settings and the spoken replies under Sandbox ▸ Agent. So the
// search is one list over both hubs' pages and cards, gated as each page is, and every answer is an address that lands
// on the card itself (settingAnchor.ts). The cards are listed beside each hub's index (settingsIndex.ts,
// sandboxIndex.ts), and a test holds each entry to the `data-setting` mark on the card it names.

export type HubName = `sandbox` | `settings`;

/** What the page a card sits on knows about this reader, and draws or withholds a card by. */
export interface HubReader {
    /** Reads the app in plain words (Settings ▸ Appearance ▸ who it is for): a developer's cards are not drawn. */
    readonly maker: boolean;
    /** A phone: cards about a keyboard or a desktop-sized window are not drawn. */
    readonly phone: boolean;
    /** The desktop app rather than a browser tab: the pages that say "the app's icon" instead of "this tab". */
    readonly app: boolean;
    /** Maintainer and up on this sandbox: the cards a member is not shown. */
    readonly canShip: boolean;
}

/** One card a page draws, as the search finds it. */
export interface SettingEntry {
    /**
     * Unique across both hubs, lower-case words joined by `-`: the card's `data-setting` mark and the `#setting-<id>` an
     * address lands on. Written into the card's template as a plain attribute, never bound, so the test can read it.
     */
    readonly id: string;
    /** The hub section (`:tab`) the card is drawn on. */
    readonly slug: string;
    /** The page's own category (its `?section=` value), where the page has categories and the card sits under one. */
    readonly part?: string;
    /** The query key the page keeps its category under, where it is not `section` (Data protection's `?step=`). */
    readonly partKey?: string;
    /** That category's name, for the trail under the result. */
    readonly partLabel?: () => string;
    /** What the result is called: the card's own heading, or the row's title for a headline row. */
    readonly title: (reader: HubReader) => string;
    /**
     * The words the card holds and the words people use for it (its rows' titles, a `search` string of synonyms in
     * the reader's language), matched but never shown. Commas split a synonyms string into terms of its own.
     */
    readonly terms?: () => readonly string[];
    /** Whether the page draws this card for this reader; absent is always, as long as its page is offered. */
    readonly shown?: (reader: HubReader) => boolean;
}

/** One page of a hub, as offered to this reader. */
export interface HubPage {
    readonly slug: string;
    readonly label: string;
    readonly icon: IconName;
    /** The row it sits under in the index, where that row stands for several pages (Privacy & safety ▸ Retention). */
    readonly row?: string | undefined;
}

/**
 * Where an answer goes: the page's own address, its category and the card's mark. An address rather than the hub's
 * route name, since a page drawn as a part of another (Activity ▸ Audit) is reached through the router's redirect for
 * its old address, and a named route goes past every redirect.
 */
export interface HubTarget {
    readonly path: string;
    /** The page's category, under the key the page reads it from; empty for the page's default category. */
    readonly query: Readonly<Record<string, string>>;
    readonly hash: string;
}

export interface HubSearchResult {
    /** Unique across both hubs: the active row keys off it. */
    readonly key: string;
    readonly hub: HubName;
    /** The page it is on, or is. */
    readonly slug: string;
    readonly title: string;
    /** Where it sits, as the reader would walk there: page, then the page's category. Empty for a page itself. */
    readonly trail: string;
    readonly icon: IconName;
    readonly score: number;
    readonly to: HubTarget;
    /** The card to land on, once the page has drawn it; absent for a page, which is the landing itself. */
    readonly setting?: string;
}

const SETTING_HASH = `#setting-`;

/** The address fragment that lands on a card. */
export const settingHash = (id: string): string => `${SETTING_HASH}${id}`;

/** The card an address fragment names, if it names one. */
export const settingOfHash = (hash: string): string | undefined =>
    hash.startsWith(SETTING_HASH) && hash.length > SETTING_HASH.length ? hash.slice(SETTING_HASH.length) : undefined;

/** How a result's trail joins its steps. */
const TRAIL = ` › `;

/**
 * Where a hub's page lives. The default page is named outright, unlike a row in the hub's own index: on a phone the
 * param-less address is the index, and an answer must land on the page it names wherever it is followed from.
 */
const target = (hub: HubName, slug: string, entry: SettingEntry | undefined): HubTarget => ({
    path: `/${hub}/${slug}`,
    query: entry?.part === undefined ? {} : { [entry.partKey ?? `section`]: entry.part },
    hash: entry === undefined ? `` : settingHash(entry.id),
});

/** One hub's pages and cards, as this reader may open them. */
export interface HubSource {
    readonly hub: HubName;
    readonly pages: readonly HubPage[];
    readonly entries: readonly SettingEntry[];
    /** The words people use for a page that its name does not hold ("invoice" for Billing), by slug; a synonyms string. */
    readonly pageTerms?: Readonly<Record<string, string>>;
}

// A synonyms string is one catalog message, commas between its terms, so a translator writes a language's own words
// for a card as one line.
const wordsOf = (terms: readonly string[]): readonly string[] =>
    terms
        .join(` `)
        .toLowerCase()
        .split(/[\s,:.…—()/-]+/u)
        .filter((word) => word.length > 0);

// What a query's words find past the title, as low as a match on a command's id ranks (commandSearch.ts), so any title
// that holds them all ranks above it.
const TERMS_SCORE = 0.3;

/**
 * How well a page or a card answers the query: on its own name first, the way every list in the app ranks
 * (commandSearch.ts), else on the words it holds, where each word typed has to START one of them. A title is a name the
 * reader reads; the words behind it are not, and a match inside one ("voice" in "invoice") would offer Billing to
 * someone after the wake word with nothing on screen to say why.
 */
const scoreOf = (title: string, terms: readonly string[], query: string): number | undefined => {
    const named = nameScore(title, ``, query);
    if (named !== undefined) {
        return named;
    }
    const words = wordsOf([title, ...terms]);
    const wanted = wordsOf([query]);
    return wanted.every((term) => words.some((word) => word.startsWith(term))) ? TERMS_SCORE : undefined;
};

/**
 * Every page and card that answers `query`, best first. A card answers on its own title first, then on its page's name
 * and the words it holds, which is the same order the palette and the Keybindings page rank by (commandSearch.ts).
 * A card is offered only on a page this reader is offered and only where that page draws it, since an answer that
 * lands on nothing reads as a broken search.
 */
export const searchHubs = (sources: readonly HubSource[], reader: HubReader, query: string): readonly HubSearchResult[] =>
    // Nothing typed is no question, so no answer: every row matches it, and the hub's own index is the list to read.
    query.trim().length === 0
        ? []
        : sources
              .flatMap(({ hub, pages, entries, pageTerms = {} }) => {
                  const bySlug = new Map(pages.map((page) => [page.slug, page]));
                  const pageResults = pages.flatMap((page): readonly HubSearchResult[] => {
                      const score = scoreOf(page.label, [page.row ?? ``, pageTerms[page.slug] ?? ``], query);
                      return score === undefined
                          ? []
                          : [
                                {
                                    key: `${hub}:page:${page.slug}`,
                                    hub,
                                    slug: page.slug,
                                    title: page.label,
                                    trail: page.row ?? ``,
                                    icon: page.icon,
                                    score,
                                    to: target(hub, page.slug, undefined),
                                },
                            ];
                  });
                  const cardResults = entries.flatMap((entry): readonly HubSearchResult[] => {
                      const page = bySlug.get(entry.slug);
                      if (page === undefined || entry.shown?.(reader) === false) {
                          return [];
                      }
                      const steps = [page.row, page.label, entry.partLabel?.()].filter((step): step is string => step !== undefined);
                      const title = entry.title(reader);
                      const score = scoreOf(title, [...steps, ...(entry.terms?.() ?? [])], query);
                      return score === undefined
                          ? []
                          : [
                                {
                                    key: `${hub}:setting:${entry.id}`,
                                    hub,
                                    slug: entry.slug,
                                    title,
                                    trail: steps.join(TRAIL),
                                    icon: page.icon,
                                    score,
                                    to: target(hub, entry.slug, entry),
                                    setting: entry.id,
                                },
                            ];
                  });
                  return [...pageResults, ...cardResults];
              })
              // A page before a card of the same score: typing a page's name means the page.
              .toSorted(
                  (left, right) =>
                      right.score - left.score ||
                      Number(left.setting !== undefined) - Number(right.setting !== undefined) ||
                      left.title.localeCompare(right.title),
              );

export interface HubResultGroup {
    readonly hub: HubName;
    readonly results: readonly HubSearchResult[];
}

/** The answers split by hub, the hub the reader is in first: what they came here to change is most likely this hub's. */
export const groupByHub = (results: readonly HubSearchResult[], here: HubName | undefined): readonly HubResultGroup[] => {
    const order: readonly HubName[] = here === `settings` ? [`settings`, `sandbox`] : [`sandbox`, `settings`];
    return order.flatMap((hub) => {
        const mine = results.filter((result) => result.hub === hub);
        return mine.length === 0 ? [] : [{ hub, results: mine }];
    });
};
