import * as extensionApi from "@intentic/extension-api";
import * as extensionManifest from "@intentic/extension-manifest";
import * as extensionUi from "@intentic/extension-ui";
import { extensionUiNames } from "@intentic/extension-ui/names";
import * as vueQuery from "@tanstack/vue-query";
import * as vue from "vue";

/* Publishes the app's OWN module instances for extension bundles. Bundles are built with these packages as
 * externals; the import map in index.html resolves the bare specifiers (blob-URL modules included) to the
 * static shims in public/ext-shims/, which re-export from this global, so a bundle's `import { ref } from
 * "vue"` lands on the same vue instance the shell runs on, extension-ui renders the shell's own themed
 * components, and vue-query joins the app's ONE QueryClient (shared cache + invalidation). Two copies of any
 * of these would silently fork reactivity/caching, which is why the shims never bundle their own. Imported for
 * its side effect from main.ts, ahead of any extension load. */

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

// names.mjs is the shim generator's source of export names (it cannot import the kit's .vue graph in node),
// catch drift between the list and the real module the moment the app boots in dev.
if (import.meta.env.DEV) {
    const actual = new Set(Object.keys(extensionUi));
    const missing = extensionUiNames.filter((name) => !actual.has(name));
    const unlisted = [...actual].filter((name) => !extensionUiNames.includes(name));
    if (missing.length > 0 || unlisted.length > 0) {
        console.error(`extension-ui names.mjs drift — missing: [${missing.join(", ")}], unlisted: [${unlisted.join(", ")}]`);
    }
}
