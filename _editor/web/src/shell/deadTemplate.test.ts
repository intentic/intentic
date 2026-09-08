// Pins that every nested `<template>` in the app carries a structural directive (v-if/else/for/slot); one that
// doesn't compiles to a real, hidden HTML element instead of being removed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const SRC = join(import.meta.dirname, `..`);

// Directives that make `<template>` a fragment; `v-slot`'s `#name` shorthand reports under the same name.
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

// Text scan, not syntax: over-matching a comment or string costs an extra parse, never a wrong verdict.
const STRUCTURAL_ATTR = /(^|\s)(v-if|v-else-if|v-else|v-for|v-slot|#)/;

const mayHoldNested = (source: string): boolean =>
    [...source.matchAll(/<template\b([^>]*)>/g)].slice(1).some((tag) => !STRUCTURAL_ATTR.test(tag[1] ?? ``));

// Walks the template AST for nested `<template>` elements; the SFC's root template isn't in the returned AST. Node
// type 1 is ELEMENT, prop type 7 is DIRECTIVE, compared numerically to avoid importing Vue's internal AST types.
const deadTemplates = (file: string): DeadTemplate[] => {
    const source = readFileSync(file, `utf8`);
    if (!mayHoldNested(source)) {
        return [];
    }
    const { descriptor, errors } = parse(source, { filename: file });
    // A file the compiler can't parse is a different failure; the build already reports it loudly.
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
