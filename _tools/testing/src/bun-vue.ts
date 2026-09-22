import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { type SFCDescriptor, type SFCScriptBlock, compileScript, compileTemplate, parse } from "vue/compiler-sfc";

// A `.vue` import under bun test: script (setup or classic) plus the template as a render function. Styles are
// dropped, since nothing under jsdom observes a stylesheet; a suite that asserts on CSS belongs in Playwright.

// A `<script setup>` inlines its template into the script; every other shape needs the render function compiled apart.
const renderFunction = (descriptor: SFCDescriptor, script: SFCScriptBlock | undefined, id: string, path: string): string | undefined => {
    if (descriptor.template === null || (script !== undefined && descriptor.scriptSetup !== null)) {
        return undefined;
    }
    return compileTemplate({
        source: descriptor.template.content,
        filename: path,
        id,
        compilerOptions: script?.bindings === undefined ? {} : { bindingMetadata: script.bindings },
    }).code;
};

const compileSfc = (path: string): string => {
    const { descriptor, errors } = parse(readFileSync(path, `utf8`), { filename: path });
    if (errors.length > 0) {
        throw new Error(`${path}: ${errors.map((error) => error.message).join(`; `)}`);
    }
    const id = Bun.hash(path).toString(16).slice(0, 8);
    const hasScript = descriptor.script !== null || descriptor.scriptSetup !== null;
    const script = hasScript ? compileScript(descriptor, { id, inlineTemplate: descriptor.scriptSetup !== null }) : undefined;
    const code = script?.content ?? `export default {};`;
    const render = renderFunction(descriptor, script, id, path);
    return render === undefined
        ? code
        : `${code.replace(/export\s+default/, `const __sfc__ =`)}\n${render}\n__sfc__.render = render;\nexport default __sfc__;`;
};

plugin({
    name: `vue-sfc`,
    setup(build) {
        build.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileSfc(path), loader: `ts` }));
    },
});
