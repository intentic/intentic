import type { BrowsingForgetInput, BrowsingHistory, SearchEngine, SearchSuggestions } from "@intentic/sandbox-contract/schemas/browsing";
import { inject, type InjectionKey } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";

// What the address bar and the history page ask the sandbox: a profile's history (whole, or what changed since a
// cursor), forgetting part of it, and the search engine's suggestions. A seam of its own, so their suites hand them a fake
// through `provide` rather than replacing the client by path.

export interface BrowsingSource {
    readonly history: (profile: string, since: string | undefined) => Promise<BrowsingHistory>;
    readonly forget: (input: BrowsingForgetInput) => Promise<number>;
    readonly suggest: (q: string, engine: SearchEngine) => Promise<SearchSuggestions>;
}

const sandboxBrowsingSource: BrowsingSource = {
    history: (profile, since) => sandboxRpc.system.browsingHistory(since === undefined ? { profile } : { profile, since }),
    forget: async (input) => (await sandboxRpc.system.forgetBrowsingHistory(input)).removed,
    suggest: (q, engine) => sandboxRpc.system.searchSuggestions({ q, engine }),
};

// `Symbol.for`: survives a hot reload of this module, so a view mounted after one still finds its provider.
export const BROWSING_SOURCE: InjectionKey<BrowsingSource> = Symbol.for(`intentic.browsing-source`);

export const useBrowsingSource = (): BrowsingSource => inject(BROWSING_SOURCE, sandboxBrowsingSource);
