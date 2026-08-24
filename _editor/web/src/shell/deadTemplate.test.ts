/* A `<template>` THAT VUE DOES NOT COMPILE AWAY, anywhere in the app: the one defect class that every other
 * check in this repo passes straight through.
 *
 * WHAT HAPPENED. The mobile Workspace wrapped its file listing in a bare `<template>`:
 *
 *     <div class="pb-24">
 *         <template>                       <!-- no v-if / v-for / v-slot -->
 *             <button v-for="node in listing" …
 *
 * Vue removes a `<template>` only when it carries a structural directive (`v-if`, `v-else-if`, `v-else`,
 * `v-for`, `v-slot`). Without one it is passed through as a REAL HTML `<template>` element, which the browser
 * renders `display: none` and never paints. So every file row was in the DOM, with the right text, at 0×0. The
 * Files tab was a blank rectangle. So were its empty state, its loading line and its "N more entries" notice,
 * because all four lived inside the dead wrapper.
 *
 * WHY A COMPILE-LEVEL TEST RATHER THAN A MOUNTED ONE. Nothing about that code is type-incorrect, lint-worthy or
 * absent from the render tree: typecheck passed, oxlint passed, and a mounted test asserting "the row exists"
 * passes too: the row does exist. Only its GEOMETRY was wrong, and geometry needs a real layout engine, which
 * is what `_tools/e2e/mobile/audit.mts` brings (it gates the same route on a phone-shaped browser).
 *
 * This is the cheap half of that pair, and it is the one that scales: it reads the templates directly, so it
 * covers every view in the app at once, needs no browser, no fixture and no mocks, and it cannot go stale as
 * routes are added. The e2e gate proves the app draws; this proves nobody can reintroduce the cause.
 *
 * A directive-less `<template>` is ALWAYS a mistake in this codebase: there is no case where shipping a real
 * `<template>` element to the browser is the intent (nothing here uses one as a client-side cloning source), so
 * the rule needs no exceptions and no allowlist to drift out of date. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const SRC = join(import.meta.dirname, `..`);

// The directives that make Vue treat a `<template>` as a fragment rather than as an element. `v-slot` covers
// its `#name` shorthand, which the parser reports under the same directive name.
const STRUCTURAL = new Set([`if`, `else-if`, `else`, `for`, `slot`]);

const vueFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return vueFiles(path);
        }
        return entry.name.endsWith(`.vue`) ? [path] : [];
    });

interface DeadTemplate {
    readonly file: string;
    readonly line: number;
}

/* WHICH FILES ARE WORTH PARSING, because the whole tree is not, and this rule is cheap to write and was
 * expensive to run: ~13ms of compiler per file across 259 components, 3.4s of CPU, 9.6s of it inside vitest,
 * where it is half the hang-detector budget the suite allows a test and it went over on a loaded box. Every one
 * of those parses but three answered a question the raw text had already answered.
 *
 * An offender is a NESTED `<template>` whose opening tag carries no structural directive. So a file can hold
 * one only if, after the first `<template` in it (the SFC's root block, which `parse` does not put in the AST
 * anyway, see below), some opening tag does not so much as MENTION one. Text rather than syntax, and read in
 * the forgiving direction on purpose: a mention inside a comment or a string counts as a candidate and is
 * parsed, which costs one parse and can change no verdict. Three files pass it today and all three are comments
 * discussing this very rule. The AST is still the only thing that decides. */
const STRUCTURAL_ATTR = /(^|\s)(v-if|v-else-if|v-else|v-for|v-slot|#)/;

const mayHoldNested = (source: string): boolean =>
    [...source.matchAll(/<template\b([^>]*)>/g)].slice(1).some((tag) => !STRUCTURAL_ATTR.test(tag[1] ?? ``));

/* Walks the template AST looking for element nodes named `template`. The ROOT `<template>` of an SFC is not in
 * here: `parse` hands back its children, so every hit is a nested one, which is exactly the population the
 * rule is about. Node type 1 is ELEMENT; `props` type 7 is DIRECTIVE. Compared numerically rather than through
 * the compiler's enums so this test does not import Vue's internal AST types. */
const deadTemplates = (file: string): DeadTemplate[] => {
    const source = readFileSync(file, `utf8`);
    if (!mayHoldNested(source)) {
        return [];
    }
    const { descriptor, errors } = parse(source, { filename: file });
    // A file the compiler cannot read is a different failure, and the build reports it far more loudly.
    if (errors.length > 0 || descriptor.template === null) {
        return [];
    }
    const found: DeadTemplate[] = [];
    const walk = (nodes: readonly unknown[]): void => {
        for (const node of nodes) {
            const element = node as {
                type: number;
                tag?: string;
                props?: { type: number; name?: string }[];
                children?: unknown[];
                loc?: { start: { line: number } };
            };
            if (element.type !== 1) {
                continue;
            }
            if (element.tag === `template`) {
                const structural = (element.props ?? []).some((prop) => prop.type === 7 && STRUCTURAL.has(prop.name ?? ``));
                if (!structural) {
                    found.push({ file, line: element.loc?.start.line ?? 0 });
                }
            }
            walk(element.children ?? []);
        }
    };
    walk(descriptor.template.ast?.children ?? []);
    return found;
};

it(`compiles away every nested <template>: one without a structural directive reaches the browser as a hidden element`, () => {
    const offenders = vueFiles(SRC).flatMap(deadTemplates);
    // Reported as paths relative to src, with lines, so a failure names the edit to make rather than the rule.
    const readable = offenders.map(({ file, line }) => `${file.slice(SRC.length + 1)}:${line}`);
    expect(readable).toEqual([]);
});
