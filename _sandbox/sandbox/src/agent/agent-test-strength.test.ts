import { describe, expect, test } from "vitest";
import { changedSourceIn } from "./agent-test-strength.js";

/* The decision logic that needs no disk: which changes count as the mutant. This is the half of the check that
 * can be wrong QUIETLY — the subprocess half fails loudly or not at all, since every error path in it returns
 * silence, but a filter that drops the wrong file produces a confident notice about the wrong thing.
 *
 * `packageOf` and the end-to-end path are in the integration suite next door, because both need a real
 * directory tree and the budget follows the kind of suite, not the kind of function. */

describe(`which changes count as the mutant`, () => {
    const repo = `/repo`;
    const pkg = `/repo/pkg`;

    test(`takes source in this package and nothing else`, () => {
        const diff = [`pkg/src/a.ts`, `pkg/src/b.vue`, `other/src/c.ts`, `pkg/README.md`, `pkg/src/d.json`].join(`\n`);
        expect(changedSourceIn(diff, repo, pkg)).toEqual([`/repo/pkg/src/a.ts`, `/repo/pkg/src/b.vue`]);
    });

    /* THE EXCLUSION THE WHOLE CHECK RESTS ON. Reverting the test files alongside the source would ask whether the
     * OLD tests pass against the OLD code — always yes — and every run would report a finding. */
    test(`never treats a test file as part of the change`, () => {
        const diff = [`pkg/src/a.ts`, `pkg/src/a.test.ts`, `pkg/src/b.spec.tsx`, `pkg/src/c.integration.test.ts`].join(`\n`);
        expect(changedSourceIn(diff, repo, pkg)).toEqual([`/repo/pkg/src/a.ts`]);
    });

    test(`a package whose name merely prefixes this one is a different package`, () => {
        // `/repo/pkg-tools/...` starts with `/repo/pkg` as a string. Comparing without the separator would pull a
        // sibling's files into this package's run.
        expect(changedSourceIn(`pkg-tools/src/a.ts`, repo, pkg)).toEqual([]);
    });

    test(`no source changed means there is nothing to compare against`, () => {
        expect(changedSourceIn([`pkg/src/a.test.ts`, ``, `  `].join(`\n`), repo, pkg)).toEqual([]);
        expect(changedSourceIn(``, repo, pkg)).toEqual([]);
    });
});
