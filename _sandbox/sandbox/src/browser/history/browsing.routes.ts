import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { ANONYMOUS_BROWSER_SERVER } from "../tools/browser-servers.js";
import { acceptLanguage, browserFingerprint } from "../sessions/fingerprint.js";
import { OWN_BROWSER_SERVER } from "../sessions/own-browser.js";
import { sessionDir } from "../sessions/session-store.js";
import { startBrowsingFeed } from "./browsing-feed.js";
import { type BrowsingStore, browsingStore } from "./browsing-store.js";
import { readChromiumHistory } from "./chromium-history.js";
import { type Suggest, searchSuggester } from "./search-suggest.js";

/* The `system.*Browsing*` procedures and `system.searchSuggestions`, beside the history they serve; merged into the
   system router by router.ts, as the device procedures are. */
export const browsingRoutes = (deps: { readonly store: BrowsingStore; readonly suggest: Suggest }) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        browsingHistory: i.browsingHistory.handler(({ input }) => deps.store.read(input.profile, input.since)),
        forgetBrowsingHistory: i.forgetBrowsingHistory.handler(async ({ input }) => ({ removed: await deps.store.forget(input.profile, input.forget) })),
        searchSuggestions: i.searchSuggestions.handler(({ input }) => deps.suggest(input.q, input.engine)),
    };
};

/* The routes over the workspace's own store. Building them starts the browsing feed, so every window the daemon watches
   from then on is remembered under its own profile. */
export const createBrowsingSystemRoutes = (services: Pick<Services, "workspace" | "logger">) => {
    const root = services.workspace.root;
    const store = browsingStore({
        root,
        // Only a persistent profile has a record of its own: the agents' credential-free browser runs on none.
        chromiumHistory: (profile) => (profile === ANONYMOUS_BROWSER_SERVER ? Promise.resolve(undefined) : readChromiumHistory(sessionDir(root, profile))),
        warn: (problem, message) => services.logger.warn(problem, message),
    });
    startBrowsingFeed(store);
    // The languages the person's own window asks pages in, worked out once: the same for every suggestion.
    let languages: Promise<string | undefined> | undefined;
    const suggest = searchSuggester({
        fetch: (url, init) => fetch(url, init),
        acceptLanguage: () => {
            languages ??= browserFingerprint(root, OWN_BROWSER_SERVER).then(
                (fingerprint) => acceptLanguage(fingerprint.languages),
                () => undefined,
            );
            return languages;
        },
    });
    return browsingRoutes({ store, suggest });
};
