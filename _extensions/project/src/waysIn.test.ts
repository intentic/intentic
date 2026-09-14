import { describe, expect, it } from "vitest";
import { newProjectBrief, newProjectConversationId, repoNameFromUrl, titleOf } from "./waysIn.js";

describe(`starting a project from a sentence`, () => {
    it(`briefs the assistant with the sentence and the two facts it cannot guess: where, and that it is a repository`, () => {
        const brief = newProjectBrief(`  a one page site for my bakery  `);
        expect(brief).toContain(`a one page site for my bakery`);
        expect(brief).toContain(`git init`);
        expect(brief).toContain(`README.md`);
    });

    it(`mints an id the daemon's rule accepts, distinct across presses`, () => {
        const a = newProjectConversationId(1_700_000_000_000, 0.1);
        const b = newProjectConversationId(1_700_000_000_000, 0.9);
        expect(a).toMatch(/^[a-z0-9-]+$/);
        expect(a).not.toBe(b);
    });

    it(`titles the conversation by the first line, cut to the registry's limit`, () => {
        expect(titleOf(`\nBakery site\nwith a menu`)).toBe(`Bakery site`);
        expect(titleOf(`x`.repeat(100))).toHaveLength(80);
        expect(titleOf(`   `)).toBe(`New project`);
    });
});

describe(`the folder a clone lands in`, () => {
    it(`is the address's last segment without .git, over https and ssh alike`, () => {
        expect(repoNameFromUrl(`https://github.com/owner/shop.git`)).toBe(`shop`);
        expect(repoNameFromUrl(`git@github.com:owner/shop.git`)).toBe(`shop`);
        expect(repoNameFromUrl(`https://github.com/owner/shop/`)).toBe(`shop`);
        expect(repoNameFromUrl(``)).toBe(``);
    });
});
