// netd's fallback loader (fallback.rs): started with `node --import=<this file>`, the daemon runs the last build that
// booted instead of the compiled trees mounted from the checkout. Every URL stays the live one, so resolution, the
// node_modules beside the trees and `import.meta.url` are untouched; only the source of a module under a kept tree is
// read from the kept copy. A file the broken build deleted is still found, from the kept copy, when a kept module
// imports it relatively. netd writes this file out of its own binary, so it never depends on the build it replaces.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const root = process.env.INTENTIC_FALLBACK_ROOT;
if (root !== undefined && root !== "") {
    const { trees } = JSON.parse(readFileSync(`${root}/build.json`, "utf8"));
    const kept = (url) => {
        if (!url.startsWith("file:")) {
            return undefined;
        }
        const path = fileURLToPath(url);
        if (!trees.some((tree) => path.startsWith(`${tree}/`))) {
            return undefined;
        }
        const copy = `${root}/files${path}`;
        return existsSync(copy) ? copy : undefined;
    };
    // Every kept tree is an ES module package (the daemon and its workspace packages are `"type": "module"`).
    const formatOf = (path) => (path.endsWith(".json") ? "json" : path.endsWith(".cjs") ? "commonjs" : "module");
    registerHooks({
        resolve(specifier, context, next) {
            try {
                return next(specifier, context);
            } catch (error) {
                if (error?.code !== "ERR_MODULE_NOT_FOUND" || context.parentURL === undefined || !/^\.{1,2}\//.test(specifier)) {
                    throw error;
                }
                const url = new URL(specifier, context.parentURL).href;
                if (kept(url) === undefined) {
                    throw error;
                }
                return { url, shortCircuit: true };
            }
        },
        load(url, context, next) {
            const copy = kept(url);
            if (copy === undefined) {
                return next(url, context);
            }
            return { format: formatOf(copy), source: readFileSync(copy), shortCircuit: true };
        },
    });
}
