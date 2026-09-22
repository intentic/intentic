import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "bun:test";

// `:global(…)` in a scoped block does NOT mean "this part is global". Vue's scoped compiler replaces the WHOLE
// selector with whatever `:global()` wraps and drops the rest, so `:global([data-frameless]) .door { … }` ships as
// `[data-frameless] { … }` — the declarations land on <html> and the element they were written for never gets them.
// Nothing warns: the build succeeds, the class is simply gone. The login screen carried exactly that for the desktop
// window's title strip, which is why it had a scrollbar it was already meant to have lost.
//
// The fix is never `:global`: an ancestor selector needs no help, since scoping only tags the LAST compound
// (`[data-frameless] .door` compiles to `[data-frameless] .door[data-v-x]`). Where the whole selector really is
// global, write it as one: `:global([data-frameless] .door)`.

const SRC = resolve(import.meta.dirname, `..`);

const vueFiles = (): string[] =>
    readdirSync(SRC, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(`.vue`))
        .map((entry) => resolve(entry.parentPath, entry.name));

/** Every selector a rule declares, one per comma, across this file's `<style>` blocks. */
const selectors = (source: string): string[] =>
    [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)]
        .flatMap((block) => [...(block[1] ?? ``).matchAll(/([^{}();]+)\{/gu)])
        .flatMap((rule) => (rule[1] ?? ``).split(`,`))
        .map((selector) => selector.trim())
        .filter((selector) => selector !== ``);

describe(`:global() in component styles`, () => {
    it(`is the whole selector wherever it appears, since the compiler throws the rest away`, () => {
        const offenders = vueFiles().flatMap((file) =>
            selectors(readFileSync(file, `utf8`))
                .filter((selector) => selector.includes(`:global(`) && !/^:global\([\s\S]*\)$/u.test(selector))
                .map((selector) => `${file.slice(SRC.length + 1)}: ${selector}`),
        );

        expect(offenders).toEqual([]);
    });
});
