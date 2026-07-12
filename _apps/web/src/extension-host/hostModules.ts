import * as extensionApi from "@intentic/extension-api";
import * as vue from "vue";

/* Publishes the app's OWN module instances for extension bundles. Bundles are built with `vue` and
 * `@intentic/extension-api` as externals; the import map in index.html resolves those bare specifiers (blob-URL
 * modules included) to the static shims in public/ext-shims/, which re-export from this global — so a bundle's
 * `import { ref } from "vue"` lands on the same vue instance the shell runs on. Two vue copies would silently
 * break reactivity and provide/inject across the host/extension boundary, which is why the shims never bundle
 * their own. Imported for its side effect from main.ts, ahead of any extension load. */

declare global {
    // oxlint-disable-next-line no-var, no-underscore-dangle -- ambient global declarations require `var`; the generated ext-shims read exactly this dunder name
    var __intenticHost: { readonly modules: Readonly<Record<string, unknown>> } | undefined;
}

// oxlint-disable-next-line no-underscore-dangle -- the host-bridge global the ext-shims re-export from
globalThis.__intenticHost = { modules: { vue, "@intentic/extension-api": extensionApi } };
