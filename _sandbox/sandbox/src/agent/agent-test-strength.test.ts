import { describe, expect, test } from "vitest";
import { changedSourceIn, testStrengthHooks } from "./agent-test-strength.js";

/* The decision logic that needs no disk: which changes count as the mutant, and whether anything is wired at
 * all. This is the half of the hook that can be wrong QUIETLY — the subprocess half fails loudly or not at all,
 * since every error path in it returns silence, but a filter that drops the wrong file produces a confident
 * notice about the wrong thing.
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

describe(`whether anything is wired at all`, () => {
    // Off has to mean genuinely nothing: no hook object, so no suite can ever be run by a workspace that did not
    // ask for this. The two arguments are separate because either one missing means the same thing.
    test(`off, or without a repo root, wires no hook`, () => {
        expect(testStrengthHooks(false, `/repo`)).toEqual({});
        expect(testStrengthHooks(undefined, `/repo`)).toEqual({});
        expect(testStrengthHooks(true, undefined)).toEqual({});
    });

    test(`on, it listens after the edit tools and nothing else`, () => {
        const hooks = testStrengthHooks(true, `/repo`);
        expect(Object.keys(hooks)).toEqual([`PostToolUse`]);
        expect(hooks.PostToolUse?.[0]?.matcher).toBe(`Edit|Write|NotebookEdit|mcp__hashline__edit|mcp__hashline__write`);
    });

    test(`says nothing about a file that is not a test`, async () => {
        // Reached before any subprocess: a source edit must not cost a suite run. `/repo` does not exist, so if
        // this ever did reach the git call it would answer undefined anyway — the point is that it returns first.
        const hook = testStrengthHooks(true, `/repo`).PostToolUse?.[0]?.hooks[0];
        const answer = await hook?.(
            { hook_event_name: `PostToolUse`, tool_name: `Write`, tool_input: { file_path: `/repo/pkg/src/a.ts` } } as never,
            undefined as never,
            { signal: new AbortController().signal },
        );
        expect(answer).toEqual({});
    });
});
