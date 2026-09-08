import * as extensionApi from "@intentic/extension-api";
import * as extensionManifest from "@intentic/extension-manifest";
import * as extensionUi from "@intentic/extension-ui";
import { extensionUiNames } from "@intentic/extension-ui/names";
import * as vueQuery from "@tanstack/vue-query";
import * as vue from "vue";

// Publishes the app's own module instances (vue, extension-ui, vue-query, etc.) for extension bundles to import through
// the ext-shims in public/ext-shims/.
// Ensures a bundle's `import { ref } from "vue"` shares the shell's vue instance, extension-ui components, and
// QueryClient; two copies would fork reactivity/caching.
// Imported for its side effect from main.ts, before any extension loads.

declare global {
    // oxlint-disable-next-line no-var, no-underscore-dangle -- ambient global declarations require `var`; the generated ext-shims read exactly this dunder name
    var __intenticHost: { readonly modules: Readonly<Record<string, unknown>> } | undefined;
}

// oxlint-disable-next-line no-underscore-dangle -- the host-bridge global the ext-shims re-export from
globalThis.__intenticHost = {
    modules: {
        vue,
        "@intentic/extension-api": extensionApi,
        "@intentic/extension-manifest": extensionManifest,
        "@intentic/extension-ui": extensionUi,
        "@tanstack/vue-query": vueQuery,
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
