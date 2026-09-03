#!/usr/bin/env node
/* EVERY .vue TEMPLATE IN THE REPOSITORY PARSES AND COMPILES, because NOTHING ELSE READS THEM. `vue-tsc --noEmit`
 * over a component whose template cannot be parsed at all exits 0 with no output: it type-checks the script and
 * gives up on the rest in silence. oxlint does not read a template either, and an extension is consumed as
 * SOURCE by the web app, so its own `build` never compiles one. That leaves exactly one reader in the whole
 * pipeline: the app bundle.
 *
 * Which is where it surfaced. A sweep rewrote one title binding as `:title="`No note for "${x}" yet`"`, where
 * the inner `"` is what HTML reads as the end of the attribute. Every typecheck passed it, in all three verify
 * groups, and all three then died on `@intentic-app/web#build` 5,145 modules in. One character, three red
 * groups, five hours, and the cheapest reader of that line was the last thing to look at it.
 *
 * THE REAL COMPILER, not a scanner for quotes in attributes: the guard is only worth having if it fails on
 * exactly what the bundler fails on. ~0.8s for ~400 templates.
 *
 * BEST-EFFORT BEFORE AN INSTALL. The compiler comes from node_modules. A push happens from a working clone,
 * where node_modules is present; the CI preflight job runs before its install, where it is not, and the three
 * verify groups compile every template minutes later regardless. So: attempt it, and when the compiler cannot
 * be resolved, SAY THAT and pass rather than fail a check for a tool that was never promised. Resolved through
 * the first workspace package that declares `vue` rather than a root devDependency: every package with a
 * template already depends on it. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { packages, root, VUE_FILE, walk } from "./lib/repo.mjs";

// From the root rather than per package: `_tools/extension-example/seed` is the tree `intentic extension
// create` copies onto someone else's machine, it belongs to no workspace package, and a template that cannot
// compile is no better there.
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
    // Unreachable while any package renders one: a template is compiled by the `vue` its package depends on.
    uncompilable.push(`${templates.length} templates, and no package declares vue: nothing here can compile them`);
}
if (compiler !== undefined) {
    const { parse: parseSfc, compileTemplate } = compiler;
    for (const file of templates) {
        const relative = file.slice(root.length + 1);
        // A CompilerError carries `loc`; a plain SyntaxError out of a script block does not, and both arrive here.
        const reported = (error, offset) =>
            `${relative}${error.loc === undefined ? "" : `:${error.loc.start.line + offset}:${error.loc.start.column}`}: ${error.message}`;
        const { descriptor, errors } = parseSfc(readFileSync(file, "utf8"), { filename: file });
        uncompilable.push(...errors.map((error) => reported(error, 0)));
        if (errors.length > 0 || descriptor.template === null) {
            continue;
        }
        // A template error is located within the block, so the block's own first line is what turns it into a
        // line of the file, the same offset @vitejs/plugin-vue applies when the bundler reports one.
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
