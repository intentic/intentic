import { PROVIDER_BRAND_PATHS, type ProviderBrand } from "@intentic/constants";
import {
    isEndpointProvider,
    isTrialProvider,
    PERSONAL_DATA_CLASSES,
    PRIVACY_ALLOW_MAX,
    type PersonalDataClass,
    type PrivacyLedgerAction,
    type PrivacyLedgerEntry,
    type PrivacyNameList,
    type PrivacyNameLookup,
    type PrivacyNameWord,
    type PrivacyProvider,
    type PrivacyReplacement,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract";

// The privacy shield panel's arithmetic, kept free of Vue so it can be tested on its own. The policy route replaces
// the policy whole, so every change here returns a new policy built from the one on screen rather than a patch.

// The longest value the contract takes on the allow list; a longer one would be refused by the daemon as a whole save.
export const ALLOW_VALUE_MAX = 200;

// A list with one value present or absent, keeping every other member where it was. A trusted id the provider list
// no longer names (an endpoint that was removed) stays put rather than being dropped by a toggle of its neighbour.
const withMember = <T extends string>(list: readonly T[], value: T, present: boolean): T[] => {
    const others = list.filter((member) => member !== value);
    return present ? [...others, value] : others;
};

export const withTrusted = (policy: PrivacyShieldPolicy, providerId: string, trusted: boolean): PrivacyShieldPolicy => ({
    ...policy,
    trusted: withMember(policy.trusted, providerId, trusted),
});

// Classes are written back in the contract's own order, so the stored list reads the same however it was clicked.
export const withClass = (policy: PrivacyShieldPolicy, kind: PersonalDataClass, on: boolean): PrivacyShieldPolicy => ({
    ...policy,
    classes: PERSONAL_DATA_CLASSES.filter((each) => (each === kind ? on : policy.classes.includes(each))),
});

// A local model never leaves this machine, so the gateway treats it as trusted whatever the list says.
export const providerTrusted = (provider: PrivacyProvider, policy: PrivacyShieldPolicy): boolean =>
    provider.local || policy.trusted.includes(provider.id);

// The allow list as the textarea holds it: one value per line, blanks and repeats dropped, so what is saved is exactly
// the set the owner sees once the draft is re-read from the daemon.
export const allowListFrom = (text: string): string[] => [
    ...new Set(
        text
            .split(`\n`)
            .map((line) => line.trim())
            .filter((line) => line !== ``),
    ),
];

export const allowListText = (allow: readonly string[]): string => allow.join(`\n`);

// Whether two lists are the same values in the same order; the draft is unsaved exactly when they differ.
export const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

// Why a draft cannot be saved, said before the daemon refuses the whole policy for it.
export type AllowListProblem = { readonly kind: `tooLong`; readonly value: string } | { readonly kind: `tooMany`; readonly count: number };

export const allowListProblem = (values: readonly string[]): AllowListProblem | undefined => {
    if (values.length > PRIVACY_ALLOW_MAX) {
        return { kind: `tooMany`, count: values.length };
    }
    const tooLong = values.find((value) => value.length > ALLOW_VALUE_MAX);
    return tooLong === undefined ? undefined : { kind: `tooLong`, value: tooLong };
};

export interface FoundPart {
    readonly kind: PersonalDataClass;
    readonly count: number;
}

// What one logged request held, as a total and its parts in the contract's order.
export interface Found {
    readonly total: number;
    readonly parts: readonly FoundPart[];
}

// Zero counts are left out, since a class the log names with nothing found says nothing a reader can use.
export const foundIn = (entry: Pick<PrivacyLedgerEntry, `counts`>): Found => {
    const parts = PERSONAL_DATA_CLASSES.flatMap((kind) => {
        const count = entry.counts[kind] ?? 0;
        return count > 0 ? [{ kind, count }] : [];
    });
    return { total: parts.reduce((sum, part) => sum + part.count, 0), parts };
};

// The timestamp a ledger entry carries, as the number the kit's date formatters take; undefined when it cannot be
// read, so the row shows no time rather than "Invalid Date".
export const ledgerTime = (at: string): number | undefined => {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? undefined : parsed;
};

// One provider's share of the log: how many requests went its way and what was found in them, as the newest of them
// stood (trusted or not, masked or watched).
export interface ProviderActivity {
    readonly provider: string;
    readonly requests: number;
    readonly values: number;
    readonly trusted: boolean;
    readonly action: PrivacyLedgerAction;
}

// What the requests the log still holds came to, all told: the one line that stands for the hundreds of rows that each
// said "nothing found".
export interface ActivitySummary {
    readonly requests: number;
    readonly values: number;
    readonly images: number;
    readonly documents: number;
    readonly refused: number;
    // The oldest request the log holds, which is where "all told" starts.
    readonly since: number | undefined;
    // The most recently used first.
    readonly providers: readonly ProviderActivity[];
}

// The log arrives newest first, so the first entry seen of a provider is its newest.
export const activitySummary = (entries: readonly PrivacyLedgerEntry[]): ActivitySummary => {
    const providers = new Map<string, { provider: string; requests: number; values: number; trusted: boolean; action: PrivacyLedgerAction }>();
    let values = 0;
    let images = 0;
    let documents = 0;
    let refused = 0;
    for (const entry of entries) {
        const found = foundIn(entry).total;
        values += found;
        images += entry.images;
        documents += entry.documents;
        refused += entry.action === `refused` ? 1 : 0;
        const known = providers.get(entry.provider);
        if (known === undefined) {
            providers.set(entry.provider, { provider: entry.provider, requests: 1, values: found, trusted: entry.trusted, action: entry.action });
        } else {
            known.requests += 1;
            known.values += found;
        }
    }
    const oldest = entries.at(-1);
    return {
        requests: entries.length,
        values,
        images,
        documents,
        refused,
        since: oldest === undefined ? undefined : ledgerTime(oldest.at),
        providers: [...providers.values()],
    };
};

interface FindingBase {
    readonly key: string;
    readonly at: number | undefined;
    readonly provider: string;
    readonly trusted: boolean;
    readonly action: PrivacyLedgerAction;
}

// Something the shield did worth a row of its own: a value it replaced (once per token, however many requests carried
// it), or a request that says more than its values: refused, or carrying images or documents, or written before tokens
// were kept and so known by its counts alone.
export type ActivityFinding =
    | (FindingBase & { readonly kind: `value`; readonly replacement: PrivacyReplacement; readonly requests: number })
    | (FindingBase & {
          readonly kind: `request`;
          readonly found: Found;
          readonly images: number;
          readonly documents: number;
          readonly detail?: string;
      });

// Newest first, as the log is: a value seen again in an older request adds to the newest row's count rather than a row.
export const activityFindings = (entries: readonly PrivacyLedgerEntry[]): ActivityFinding[] => {
    const findings: ActivityFinding[] = [];
    const seen = new Map<string, number>();
    entries.forEach((entry, index) => {
        const base = { at: ledgerTime(entry.at), provider: entry.provider, trusted: entry.trusted, action: entry.action };
        const replacements = entry.replacements ?? [];
        if (entry.action !== `refused`) {
            for (const replacement of replacements) {
                const at = seen.get(replacement.token);
                if (at !== undefined) {
                    const earlier = findings[at];
                    if (earlier?.kind === `value`) {
                        findings[at] = { ...earlier, requests: earlier.requests + 1 };
                    }
                    continue;
                }
                seen.set(replacement.token, findings.length);
                findings.push({ ...base, kind: `value`, key: `value-${replacement.token}`, replacement, requests: 1 });
            }
        }
        // Counts with no tokens beside them are the only account an older entry has of what it found; images and
        // documents get a row where no value row already speaks for them (an image held back, read as nothing).
        const found = replacements.length === 0 ? foundIn(entry) : { total: 0, parts: [] };
        const images = entry.images > 0 && !replacements.some((replacement) => replacement.image === true);
        const documents = entry.documents > 0 && replacements.length === 0;
        if (entry.action === `refused` || images || documents || found.total > 0) {
            findings.push({
                ...base,
                kind: `request`,
                // Two requests can land in one millisecond; the position keeps their keys apart.
                key: `request-${entry.at}-${index}`,
                found,
                images: entry.images,
                documents: entry.documents,
                ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
            });
        }
    });
    return findings;
};

// Every token the page is about to show, once, for the one read that puts their values beside them.
export const findingTokens = (findings: readonly ActivityFinding[]): string[] => [
    ...new Set(findings.flatMap((finding) => (finding.kind === `value` ? [finding.replacement.token] : []))),
];

export interface ExcerptPart {
    readonly text: string;
    // A token, which the page draws as one; `own` when it is the one the row is about.
    readonly token: boolean;
    readonly own: boolean;
}

// Either spelling, as the daemon reads them (src/privacy/tokens.ts).
const TOKEN = /⟦[A-Z][A-Z_]*?_\d{1,7}⟧|\[\[[A-Z][A-Z_]*?_\d{1,7}\]\]/gu;

// An excerpt cut at its tokens, so each can be drawn as what the provider read in place of a value.
export const excerptParts = (excerpt: string, own: string): ExcerptPart[] => {
    const parts: ExcerptPart[] = [];
    let last = 0;
    for (const match of excerpt.matchAll(TOKEN)) {
        if (match.index > last) {
            parts.push({ text: excerpt.slice(last, match.index), token: false, own: false });
        }
        parts.push({ text: match[0], token: true, own: match[0] === own });
        last = match.index + match[0].length;
    }
    if (last < excerpt.length) {
        parts.push({ text: excerpt.slice(last), token: false, own: false });
    }
    return parts;
};

// What stands for a provider: its vendor's mark where it has one, else what it is (a model running here, the free
// trial, a server the owner pointed at, an agent nothing here knows the vendor of).
export type ProviderMark = { readonly brand: ProviderBrand } | { readonly glyph: `cpu` | `gift` | `server` | `sparkles` };

const isBrand = (id: string): id is ProviderBrand => Object.hasOwn(PROVIDER_BRAND_PATHS, id);

export const providerMark = (id: string, local: boolean): ProviderMark => {
    if (isBrand(id)) {
        return { brand: id };
    }
    if (local) {
        return { glyph: `cpu` };
    }
    if (isTrialProvider(id)) {
        return { glyph: `gift` };
    }
    return { glyph: isEndpointProvider(id) ? `server` : `sparkles` };
};

// What a provider is sent under the policy in force, the one fact its row has to make plain: tokens; the values while
// the shield only watches; the values as they are (trusted, or a runtime the gateway can't cover while it only
// watches); nothing, since a runtime the gateway can't cover does not run untrusted while it masks; or nothing that
// leaves, for a model on this machine.
export type ProviderReceives = `tokens` | `watched` | `values` | `refused` | `local`;

export const providerReceives = (provider: PrivacyProvider, policy: PrivacyShieldPolicy): ProviderReceives => {
    if (provider.local) {
        return `local`;
    }
    if (providerTrusted(provider, policy) || policy.mode === `off`) {
        return `values`;
    }
    if (!provider.shieldable) {
        return policy.mode === `on` ? `refused` : `values`;
    }
    return policy.mode === `on` ? `tokens` : `watched`;
};

// What a looked-up word or name comes to: masked on its own, never part of a name, a name only beside other evidence
// (a title, a surname, a name field), or nothing the lists know.
export type NameVerdict = `found` | `never` | `needsContext` | `notFound`;

export const nameVerdict = (lookup: Pick<PrivacyNameLookup, `found` | `words`>): NameVerdict => {
    if (lookup.found) {
        return `found`;
    }
    const [only, ...rest] = lookup.words;
    if (only !== undefined && rest.length === 0 && only.never) {
        return `never`;
    }
    return lookup.words.some((word) => word.firstName || word.surname || word.surnameForm || word.ambiguous) ? `needsContext` : `notFound`;
};

// What the lists say of one word, in the order the page lists them.
export const NAME_TRAITS = [`firstName`, `surname`, `surnameForm`, `ambiguous`, `never`] as const;
export type NameTrait = (typeof NAME_TRAITS)[number];

export const traitsOf = (word: PrivacyNameWord): NameTrait[] => NAME_TRAITS.filter((trait) => word[trait]);

// The lists hold their words lowercase; one only name lists hold is shown as a name is written, a title or a function
// word as the lists keep it ("dr", "the").
const NAME_KINDS: ReadonlySet<PrivacyNameList[`kind`]> = new Set([`first-name`, `surname`, `ambiguous`]);

export const shownWord = (word: string, held: readonly string[], lists: readonly Pick<PrivacyNameList, `id` | `kind`>[]): string => {
    const kinds = held.map((id) => lists.find((list) => list.id === id)?.kind);
    const name = kinds.length > 0 && kinds.every((kind) => kind !== undefined && NAME_KINDS.has(kind));
    return name ? word.replaceAll(/(^|-)(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase(`pl`)}`) : word;
};

// A source's page named by its host, which is what a reader recognises ("dane.gov.pl"); undefined for no address.
export const sourceHost = (url: string | undefined): string | undefined => {
    if (url === undefined) {
        return undefined;
    }
    try {
        return new URL(url).hostname.replace(/^www\./u, ``);
    } catch {
        // allow(silent-catch): an address that does not parse is shown as no link rather than a broken one.
        return undefined;
    }
};
