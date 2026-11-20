import type { SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { engineOf } from "./engines";
import type { TabCandidate } from "./rank";

export type { TabCandidate } from "./rank";

// What the browsers view hands its address bars: where a search goes, and which open tabs to offer to switch to.

/** The sandbox's search engine (its `searchEngine` setting), Brave until the settings say otherwise. */
export const useSearchEngine = (): ComputedRef<SearchEngine> => {
    const { settings } = useSandboxSettings();
    return computed(() => engineOf(settings.value?.searchEngine));
};

/** Every web page open but the one in front, and none still blank: the tabs worth switching to rather than reopening. */
export const otherTabs = (
    pages: readonly { readonly session: BrowserSession; readonly page: BrowserPage }[],
    front: { readonly session: string | undefined; readonly page: string | undefined },
): TabCandidate[] =>
    pages.flatMap(({ session, page }) =>
        page.url === `` || page.url === `about:blank` || (session.name === front.session && page.id === front.page)
            ? []
            : [{ session: session.name, pageId: page.id, url: page.url, title: page.title, favicon: page.favicon }],
    );
