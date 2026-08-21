import { describe, expect, it } from "vitest";
import { openingRepo } from "./repoChoice.js";

/* Where the area opens when the URL names no repository: the answer the rail's tile always needs, since its link
 * carries no query at all. */
describe(`openingRepo`, () => {
    const repos = [``, `intentic`, `site`];
    const documented =
        (which: readonly string[]) =>
        (repo: string): boolean =>
            which.includes(repo);

    it(`opens on the remembered choice`, () => {
        expect(openingRepo(repos, `site`, documented([`intentic`]))).toBe(`site`);
    });

    it(`falls through when the remembered repository has gone away`, () => {
        // A clone that was removed, or a choice carried over from another sandbox: it must not strand the area.
        expect(openingRepo(repos, `deleted`, documented([`intentic`]))).toBe(`intentic`);
    });

    it(`prefers a documented repository over the first one`, () => {
        expect(openingRepo(repos, undefined, documented([`site`]))).toBe(`site`);
    });

    it(`falls back to the first repository when none is documented`, () => {
        expect(openingRepo(repos, undefined, documented([]))).toBe(``);
    });

    it(`answers the workspace root for a workspace with no repos`, () => {
        expect(openingRepo([], undefined, documented([]))).toBe(``);
    });
});
