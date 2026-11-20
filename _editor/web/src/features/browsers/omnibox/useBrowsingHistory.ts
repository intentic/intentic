import { sandboxShallowRef } from "@intentic/extension-api";
import type { BrowsingEntry, BrowsingForget, BrowsingHistory, BrowsingTerm } from "@intentic/sandbox-contract/schemas/browsing";
import { computed, type ComputedRef, type Ref } from "vue";
import { type BrowsingSource, useBrowsingSource } from "./browsingSource";
import { type PreparedEntry, prepareHistory } from "./rank";

// One browser profile's history as the editor holds it, shared by every address bar and history page of this sandbox:
// fetched whole once, then kept current by asking only for what changed since the last answer's cursor (when the address
// bar takes focus, when the history page opens). Prepared for ranking once per change, not once per keystroke.

export interface HeldHistory {
    // Best first, as the sandbox ranked them.
    readonly entries: readonly BrowsingEntry[];
    readonly prepared: readonly PreparedEntry[];
    // Most recent first.
    readonly terms: readonly BrowsingTerm[];
    readonly profiles: readonly string[];
    readonly cursor: string | undefined;
    // Whether the sandbox has answered at all: before that, an empty history is not known to be empty.
    readonly loaded: boolean;
}

const EMPTY: HeldHistory = { entries: [], prepared: [], terms: [], profiles: [], cursor: undefined, loaded: false };

// By profile, for the open sandbox; a switch starts over.
const held = sandboxShallowRef(() => new Map<string, HeldHistory>());
const inFlight = new Map<string, Promise<void>>();

const byWorth = (left: BrowsingEntry, right: BrowsingEntry): number => right.frecency - left.frecency || right.last - left.last;

/** What an answer makes of what was held: the whole of it replaced, or only what changed merged in. */
export const mergeHistory = (before: HeldHistory, answer: BrowsingHistory): HeldHistory => {
    const entries = answer.full ? answer.entries : mergeEntries(before.entries, answer.entries, answer.removed);
    const terms = answer.full ? answer.terms : mergeTerms(before.terms, answer.terms);
    const changed = answer.full || answer.entries.length > 0 || answer.removed.length > 0;
    return {
        entries: changed ? entries.toSorted(byWorth) : before.entries,
        prepared: changed ? prepareHistory(entries.toSorted(byWorth)) : before.prepared,
        terms,
        profiles: answer.profiles,
        cursor: answer.cursor,
        loaded: true,
    };
};

const mergeEntries = (before: readonly BrowsingEntry[], changed: readonly BrowsingEntry[], removed: readonly string[]): BrowsingEntry[] => {
    const byUrl = new Map(before.map((entry) => [entry.url, entry]));
    for (const url of removed) {
        byUrl.delete(url);
    }
    for (const entry of changed) {
        byUrl.set(entry.url, entry);
    }
    return [...byUrl.values()];
};

const mergeTerms = (before: readonly BrowsingTerm[], changed: readonly BrowsingTerm[]): BrowsingTerm[] => {
    const byTerm = new Map(before.map((term) => [term.term.toLowerCase(), term]));
    for (const term of changed) {
        byTerm.set(term.term.toLowerCase(), term);
    }
    return [...byTerm.values()].toSorted((left, right) => right.last - left.last);
};

const store = (profile: string, history: HeldHistory): void => {
    held.value = new Map(held.value).set(profile, history);
};

const heldOf = (profile: string): HeldHistory => held.value.get(profile) ?? EMPTY;

// One request per profile at a time: a second refresh asked for meanwhile is answered by the first.
const refreshProfile = (source: BrowsingSource, profile: string): Promise<void> => {
    const running = inFlight.get(profile);
    if (running !== undefined) {
        return running;
    }
    const ask = async (): Promise<void> => {
        try {
            const answer = await source.history(profile, heldOf(profile).cursor);
            store(profile, mergeHistory(heldOf(profile), answer));
        } catch (error) {
            // What was held stays: suggestions from a copy a moment old beat none, and the next focus asks again.
            console.warn(`browsing history: could not read ${profile}`, error);
        } finally {
            inFlight.delete(profile);
        }
    };
    const asking = ask();
    inFlight.set(profile, asking);
    return asking;
};

export interface BrowsingHistoryHandle {
    readonly history: ComputedRef<HeldHistory>;
    // Brings the held copy up to date with the sandbox's.
    readonly refresh: () => Promise<void>;
    // Forgets in the sandbox; addresses leave the held copy at once, the rest once the sandbox has answered.
    readonly forget: (what: BrowsingForget) => Promise<void>;
}

export const useBrowsingHistory = (profile: Ref<string>): BrowsingHistoryHandle => {
    const source = useBrowsingSource();
    const history = computed(() => heldOf(profile.value));
    const refresh = (): Promise<void> => refreshProfile(source, profile.value);
    const forget = async (what: BrowsingForget): Promise<void> => {
        const name = profile.value;
        if (what.kind === `urls`) {
            const gone = new Set(what.urls);
            const before = heldOf(name);
            const entries = before.entries.filter((entry) => !gone.has(entry.url));
            store(name, { ...before, entries, prepared: before.prepared.filter((page) => !gone.has(page.entry.url)) });
        }
        await source.forget({ profile: name, forget: what });
        await refreshProfile(source, name);
    };
    return { history, refresh, forget };
};
