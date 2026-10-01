import { bundleProblem, bundleSpecifiers, HOST_PUBLISHED_SPECIFIERS } from "./bundle.js";

// Every case is a whole bundle and the specifiers it names, in source order. The minified ones are how a bundler
// actually emits: no whitespace a line-anchored scan could lean on.
const CASES: readonly (readonly [string, string, readonly string[]])[] = [
    ["a minified bundle's every import, on one line", `import{ref as e}from"vue";import{x as y}from"lodash";e(y);`, ["vue", "lodash"]],
    ["a default import beside named ones", `import x,{y}from"z";`, ["z"]],
    ["a namespace import", `import*as n from"z";`, ["z"]],
    ["a default and a namespace import", `import d,*as n from"z";`, ["z"]],
    ["a multi-line import", `import {\n    a,\n    b as c,\n} from "@example/server";\n`, ["@example/server"]],
    ["a statement after a closing brace", `function f(){}import{a}from"b";`, ["b"]],
    ["export * from", `export * from "./chunk.js";`, ["./chunk.js"]],
    ["export * as from", `export*as ns from"ns-lib";`, ["ns-lib"]],
    ["export {a} from", `export {a} from "a-lib";export{b as c}from'b-lib'`, ["a-lib", "b-lib"]],
    ["export {} from", `export{}from"empty"`, ["empty"]],
    ["a local export names nothing", `const a=1;export{a};export default a;export const b=2;`, []],
    ["a local export, then an import after a line break", `export {a}\nimport "next"`, ["next"]],
    ["a side-effect import", `import "polyfill";import'other';`, ["polyfill", "other"]],
    ["a dynamic import", `const m=await import("./lazy.js");`, ["./lazy.js"]],
    ["a dynamic import of a hole-less template", "import(`lit`).then(f)", ["lit"]],
    ["a dynamic import with options", `import("data", { with: { type: "json" } })`, ["data"]],
    ["a dynamic import of an expression names no module", `import(name);import("pre"+fix);import(\`t\${x}\`)`, []],
    ["import attributes", `import cfg from "./cfg.json" with { type: "json" };`, ["./cfg.json"]],
    ["quoted binding names", `import {"a-b" as c} from "q";export {c as "d-e"} from "r";`, ["q", "r"]],
    ["a binding called from", `import from from "f";import {from} from "g";`, ["f", "g"]],
    ["a specifier named twice counts once", `import a from"vue";import{b}from"vue";export*from"vue"`, ["vue"]],
    ["the word inside a string", `const s = "import x from 'fake'";const t = 'export * from "fake"';`, []],
    ["the word inside a template", "const s = `import x from 'fake';\nimport('fake')`;", []],
    ["the word inside a template's hole's string", 'const s = `a${"import \'fake\'"}b`;import "real";', ["real"]],
    ["an import inside a template's hole", 'const s = `a${await import("inner")}b`;', ["inner"]],
    ["nested template holes", 'const s=`a${`b${c}d`}e${{f:1}.f}g`;import"after";', ["after"]],
    ["the word inside a line comment", `// import x from "fake"\nimport "real";`, ["real"]],
    ["the word inside a block comment", `/* import x from "fake";\n export * from "fake2" */import "real";`, ["real"]],
    ["a regex holding the word and a quote", `const r=/import x from "fake"/g;import "real";`, ["real"]],
    ["a regex holding a lone quote", `if(/["']/.test(s))x();import{a}from"real";`, ["real"]],
    ["a regex after a keyword", `function f(s){return/'/.test(s)}import"real";`, ["real"]],
    ["a regex with a slash in a class", `const r=/[/"]/;import"real";`, ["real"]],
    ["division is not a regex", `const a=b/2,c=d/3;import"real";`, ["real"]],
    ["division after a call and an index", `x=f(1)/g[0]/2;import"real";`, ["real"]],
    ["a method called import", `loader.import("fake");obj?.import("fake2");class A{import(p){}}`, []],
    ["import.meta", `const u=import.meta.url;import "real";`, ["real"]],
    ["an object key called import or export", `const o={import:"fake",export:"fake2"};`, []],
    ["a private field called import", `class A{#import=1;f(){return this.#import}}`, []],
    ["a hashbang line", `#!/usr/bin/env node\nimport "real";`, ["real"]],
    ["escaped quotes in a string", `const s="\\"import 'fake'\\"";import "real";`, ["real"]],
];

describe("bundleSpecifiers", () => {
    test.each(CASES)("%s", (_name, source, expected) => {
        expect(bundleSpecifiers(source)).toEqual([...expected]);
    });
});

describe("bundleProblem", () => {
    test("a bundle importing only what the host publishes loads", () => {
        const source = HOST_PUBLISHED_SPECIFIERS.map((specifier, index) => `import*as m${index} from"${specifier}";`).join("");
        expect(bundleProblem(source)).toBe(undefined);
    });

    test("a bundle importing nothing loads", () => {
        expect(bundleProblem(`export const activate=()=>{};`)).toBe(undefined);
    });

    test.each([
        ["a relative static import", `import{a}from"vue";import{b}from"./chunk.js";`, "./chunk.js"],
        ["a relative re-export", `export*from"../shared.js"`, "../shared.js"],
        ["an absolute dynamic import", `import("/assets/lazy.js")`, "/assets/lazy.js"],
    ])("%s is a second file", (_name, source, specifier) => {
        expect(bundleProblem(source)).toBe(
            `imports a second file (${specifier}): a bundle is imported from a blob URL, so nothing relative to it can resolve`,
        );
    });

    test("every relative specifier is named, ahead of any unpublished bare one", () => {
        expect(bundleProblem(`import"lodash";import"./a.js";export*from"./b.js"`)).toBe(
            "imports a second file (./a.js, ./b.js): a bundle is imported from a blob URL, so nothing relative to it can resolve",
        );
    });

    test("an unpublished bare specifier, found past the first import of a minified bundle, is named", () => {
        expect(bundleProblem(`import{ref as e}from"vue";import{x as y}from"lodash";import("dayjs")`)).toBe(
            "imports lodash, dayjs, which the host does not publish, bundle it in, or use one of: vue, @intentic/extension-api, @intentic/extension-ui, @tanstack/vue-query",
        );
    });

    test("a published package's subpath is not the package", () => {
        expect(bundleProblem(`import{h}from"vue/dist/vue.esm-bundler.js"`)).toBe(
            "imports vue/dist/vue.esm-bundler.js, which the host does not publish, bundle it in, or use one of: vue, @intentic/extension-api, @intentic/extension-ui, @tanstack/vue-query",
        );
    });
});
