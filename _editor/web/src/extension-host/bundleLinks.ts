import * as extensionApi from "@intentic/extension-api";
import { extensionUiNames } from "@intentic/extension-ui/names";
import { type HostExports, missingImports } from "@intentic/extension-manifest";
import { t } from "@intentic/ui/i18n";

// A bundle's static imports link against the import map's shims (public/ext-shims), and a name a shim does not export
// fails the whole bundle with the browser's "does not provide an export named …", which names neither the extension nor
// what to do. The loader asks this first, so the Extensions tab says it in words.

// What each shim re-exports, read the way scripts/generate-ext-shims.mjs writes them: the kit's names off names.mjs,
// since its .vue graph cannot load in node, and the API's off its own module. extShims.test.ts holds the shims to the
// same two sources, and bundleLinks.test.ts this to the shims.
export const HOST_EXPORTS: HostExports = {
    "@intentic/extension-api": Object.keys(extensionApi),
    "@intentic/extension-ui": extensionUiNames,
};

// Why this bundle would fail to link here, or undefined when every name it imports from the host is one the host has.
// Reads only the imports at the bundle's head, where a bundler puts them all, so a load pays a fraction of a
// millisecond; an import it does not reach fails to link exactly as it did before.
export const bundleLinkProblem = (source: string, host: HostExports = HOST_EXPORTS): string | undefined => {
    const missing = missingImports(source, host, { leading: true });
    if (missing.length === 0) {
        return undefined;
    }
    const imports = missing.map((entry) => t(`extension-host.loader.namesFromModule`, { names: entry.names.join(`, `), module: entry.specifier }));
    return t(`extension-host.loader.missingHostExports`, { imports: imports.join(`; `) });
};
