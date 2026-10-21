import { errorMessage } from "@intentic/base/errors";
import * as extensionApi from "@intentic/extension-api";
import * as extensionManifest from "@intentic/extension-manifest";
import * as extensionUi from "@intentic/extension-ui";
import { extensionUiNames } from "@intentic/extension-ui/names";
import * as vueQuery from "@tanstack/vue-query";
import * as vue from "vue";
import { reportQueryFreshness } from "../client/sandbox/freshness/queryFreshness";
import { useSandbox } from "../client/sandbox/useSandbox";

// Publishes the app's own module instances (vue, extension-ui, vue-query, etc.) for extension bundles to import through
// the ext-shims in public/ext-shims/.
// Ensures a bundle's `import { ref } from "vue"` shares the shell's vue instance, extension-ui components, and
// QueryClient; two copies would fork reactivity/caching.
// Imported for its side effect from main.ts, before any extension loads.

declare global {
    // oxlint-disable-next-line no-underscore-dangle -- Ambient declarations require var.
    var __intenticHost: { readonly modules: Readonly<Record<string, unknown>> } | undefined;
}

// An extension's own vue-query read joins the wait of the view it is read in, as every read through the host does
// (`api.sandbox.query`, the shell's useSandboxQuery): the view's host keeps its remembered look until the read has
// answered, so a bundle never has to draw its own first wait, and one shipped before <Await> existed gets it too. A read
// held off (`enabled: false`) is a wait while the sandbox is not answering, the gate every pack writes, and otherwise
// one the view has not asked for.
// Each read also reports its answer's age to the pane it is read in (queryFreshness.ts), so the pane says when what an
// extension shows may be out of date without the extension drawing anything for it.
const { reachable } = useSandbox();
const errorWords = (error: Error | null): string | undefined => (error === null ? undefined : errorMessage(error));
const useQuery = (...args: Parameters<typeof vueQuery.useQuery>): ReturnType<typeof vueQuery.useQuery> => {
    const query = vueQuery.useQuery(...args);
    extensionApi.useLoaded(() => ({
        data: query.data.value,
        error: errorWords(query.error.value),
        fetching: query.isFetching.value,
        wanted: query.fetchStatus.value !== `idle` || reachable.value !== true,
    }));
    reportQueryFreshness(query, () => errorWords(query.error.value));
    return query;
};
const useInfiniteQuery = (...args: Parameters<typeof vueQuery.useInfiniteQuery>): ReturnType<typeof vueQuery.useInfiniteQuery> => {
    const query = vueQuery.useInfiniteQuery(...args);
    reportQueryFreshness(query, () => errorWords(query.error.value));
    return query;
};

// oxlint-disable-next-line no-underscore-dangle -- the host-bridge global the ext-shims re-export from
globalThis.__intenticHost = {
    modules: {
        vue,
        "@intentic/extension-api": extensionApi,
        "@intentic/extension-manifest": extensionManifest,
        "@intentic/extension-ui": extensionUi,
        "@tanstack/vue-query": { ...vueQuery, useQuery, useInfiniteQuery },
    },
};

// names.mjs hand-lists exports (can't import the .vue graph in node); this catches drift in dev.
if (import.meta.env.DEV) {
    const actual = new Set(Object.keys(extensionUi));
    const missing = extensionUiNames.filter((name) => !actual.has(name));
    const unlisted = [...actual].filter((name) => !extensionUiNames.includes(name));
    if (missing.length > 0 || unlisted.length > 0) {
        console.error(`extension-ui names.mjs drift, missing: [${missing.join(", ")}], unlisted: [${unlisted.join(", ")}]`);
    }
}
