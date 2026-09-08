import { describe, expect, test } from "vitest";
import { changedSourceIn } from "./agent-test-strength.js";

// Which changed files count as the mutant; a wrong filter fails quietly, unlike the subprocess half. `packageOf` and
// the end-to-end path live in the integration suite next door.

describe(`which changes count as the mutant`, () => {
    const repo = `/repo`;
    const pkg = `/repo/pkg`;

    test(`takes source in this package and nothing else`, () => {
        const diff = [`pkg/src/a.ts`, `pkg/src/b.vue`, `other/src/c.ts`, `pkg/README.md`, `pkg/src/d.json`].join(`\n`);
        expect(changedSourceIn(diff, repo, pkg)).toEqual([`/repo/pkg/src/a.ts`, `/repo/pkg/src/b.vue`]);
    });

    test(`never treats a test file as part of the change`, () => {
        const diff = [`pkg/src/a.ts`, `pkg/src/a.test.ts`, `pkg/src/b.spec.tsx`, `pkg/src/c.integration.test.ts`].join(`\n`);
        expect(changedSourceIn(diff, repo, pkg)).toEqual([`/repo/pkg/src/a.ts`]);
    });

    test(`a package whose name merely prefixes this one is a different package`, () => {
        // Without the separator, `/repo/pkg-tools` would match as a prefix of `/repo/pkg`.
        expect(changedSourceIn(`pkg-tools/src/a.ts`, repo, pkg)).toEqual([]);
    });

    test(`no source changed means there is nothing to compare against`, () => {
        expect(changedSourceIn([`pkg/src/a.test.ts`, ``, `  `].join(`\n`), repo, pkg)).toEqual([]);
        expect(changedSourceIn(``, repo, pkg)).toEqual([]);
    });
});
