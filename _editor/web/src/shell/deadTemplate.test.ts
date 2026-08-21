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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const SRC = join(import.meta.dirname, `..`);

// The directives that make Vue treat a `<template>` as a fragment rather than as an element. `v-slot` covers
// its `#name` shorthand, which the parser reports under the same directive name.
const STRUCTURAL = new Set([`if`, `else-if`, `else`, `for`, `slot`]);

const vueFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            return vueFiles(path);
        }
        return entry.endsWith(`.vue`) ? [path] : [];
    });

interface DeadTemplate {
    readonly file: string;
    readonly line: number;
}

/* Walks the template AST looking for element nodes named `template`. The ROOT `<template>` of an SFC is not in
 * here: `parse` hands back its children, so every hit is a nested one, which is exactly the population the
 * rule is about. Node type 1 is ELEMENT; `props` type 7 is DIRECTIVE. Compared numerically rather than through
 * the compiler's enums so this test does not import Vue's internal AST types. */
const deadTemplates = (file: string): DeadTemplate[] => {
    const { descriptor, errors } = parse(readFileSync(file, `utf8`), { filename: file });
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
