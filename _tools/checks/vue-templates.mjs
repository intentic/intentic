#!/usr/bin/env node
// Nothing else reads a .vue template for real: `vue-tsc --noEmit` gives up on an unparseable one silently, oxlint
// doesn't parse templates, and an extension is consumed as source. Uses the real compiler, not a quote-scanner.
// Best-effort before an install: passes with a note when the compiler can't be resolved.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { packages, root, VUE_FILE, walk } from "./lib/repo.mjs";

// From the root, not per package: the extension-example seed belongs to no workspace package.
const templates = walk(root, VUE_FILE);
const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const uncompilable = [];
const compiler = (() => {
    if (templates.length === 0 || vueHost === undefined) {
        return undefined;
    }
    try {
        return createRequire(join(vueHost.dir, "package.json"))("vue/compiler-sfc");
    } catch {
        return undefined;
    }
})();
if (templates.length > 0 && vueHost === undefined) {
    // Unreachable while any package renders a template: it's compiled via that package's own vue dependency.
    uncompilable.push(`${templates.length} templates, and no package declares vue: nothing here can compile them`);
}
if (compiler !== undefined) {
    const { parse: parseSfc, compileTemplate } = compiler;
    for (const file of templates) {
        const relative = file.slice(root.length + 1);
        // A CompilerError carries `loc`; a plain SyntaxError from a script block doesn't, and both arrive here.
        const reported = (error, offset) =>
            `${relative}${error.loc === undefined ? "" : `:${error.loc.start.line + offset}:${error.loc.start.column}`}: ${error.message}`;
        const { descriptor, errors } = parseSfc(readFileSync(file, "utf8"), { filename: file });
        uncompilable.push(...errors.map((error) => reported(error, 0)));
        if (errors.length > 0 || descriptor.template === null) {
            continue;
        }
        // Offsets a template error to a file line, using the block's start line, matching @vitejs/plugin-vue.
        const offset = descriptor.template.loc.start.line - 1;
        const compiled = compileTemplate({ source: descriptor.template.content, filename: file, id: relative });
        uncompilable.push(...compiled.errors.map((error) => (typeof error === "string" ? `${relative}: ${error}` : reported(error, offset))));
    }
}

finish(
    [["A .vue template does not compile, so the web build cannot bundle it (no type check reads templates, which is why this says so here)", uncompilable]],
    [
        compiler === undefined
            ? `vue templates: ${templates.length} not compiled (vue/compiler-sfc needs node_modules, and this ran before the install) — the verify jobs read them`
            : `vue templates: all ${templates.length} parse and compile, so the bundler has nothing left to discover`,
    ],
);
