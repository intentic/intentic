import { describe, expect, it } from "vitest";
import type { WorkspaceHotspot } from "@intentic-app/api-contract";
import { hotspotAsk, type HotspotContext, moduleAsk } from "./refactorAsk";

/* The selection is the part that can be wrong without anyone noticing: a prompt that reads well while asking
 * for the wrong KIND of change costs a whole turn. So every archetype is pinned to the figures that pick it,
 * and both boundaries of "out of proportion" are tested rather than the comfortable middle. */

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const hotspot = (over: Partial<WorkspaceHotspot> = {}): WorkspaceHotspot => ({
    path: `src/thing.ts`,
    commits: 50,
    adds: 4_120,
    dels: 1_877,
    complexity: 200,
    score: 10_000,
    latestMs: NOW - DAY_MS,
    ...over,
});

// The leader is the balanced case's own figures, so a row matching it exactly is "both signals at once".
const context = (over: Partial<HotspotContext> = {}): HotspotContext => ({
    rank: 1,
    window: `all`,
    leader: { commits: 50, complexity: 200 },
    keyModule: false,
    nowMs: NOW,
    ...over,
});

describe(`hotspotAsk`, () => {
    it(`asks for a decomposition when churn and branching are telling one story`, () => {
        const ask = hotspotAsk(hotspot(), context());
        expect(ask.kind).toBe(`decompose`);
        expect(ask.prompt).toContain(`change seams`);
    });

    it(`asks to flatten in place when the branching is out of proportion to the churn`, () => {
        // A tenth of the leader's commits, all of its branch points: tangled logic, rarely touched.
        const ask = hotspotAsk(hotspot({ commits: 5 }), context());
        expect(ask.kind).toBe(`simplify`);
        expect(ask.prompt).toContain(`early returns`);
    });

    it(`asks to split by responsibility when the churn is out of proportion to the branching`, () => {
        // Every commit the leader took, a tenth of its branching: crowded, not tangled.
        const ask = hotspotAsk(hotspot({ complexity: 20 }), context());
        expect(ask.kind).toBe(`split`);
        expect(ask.prompt).toContain(`one subject per file`);
    });

    it(`holds the balanced reading right up to the dominance boundary`, () => {
        // Shares of 1.0 and 0.7: half again is 1.05, so this is still one story, not two.
        expect(hotspotAsk(hotspot({ complexity: 140 }), context()).kind).toBe(`decompose`);
        expect(hotspotAsk(hotspot({ complexity: 132 }), context()).kind).toBe(`split`);
    });

    it(`reads a load-bearing hotspot as a stability problem, whatever its shape`, () => {
        // Both dominance readings are available here; being imported by the rest of the repo outranks them.
        expect(hotspotAsk(hotspot({ commits: 5 }), context({ keyModule: true })).kind).toBe(`stabilize`);
        expect(hotspotAsk(hotspot({ complexity: 20 }), context({ keyModule: true })).kind).toBe(`stabilize`);
    });

    it(`never reads a test file as product risk`, () => {
        for (const path of [`src/thing.test.ts`, `src/thing.spec.tsx`, `src/__tests__/thing.ts`]) {
            const ask = hotspotAsk(hotspot({ path }), context({ keyModule: true }));
            expect(ask.kind).toBe(`tests`);
            // The one thing a test refactor must not do is change what is asserted.
            expect(ask.prompt).toContain(`Do not change what is asserted`);
        }
    });

    it(`steps back from a file nobody has touched in a season, without refusing it`, () => {
        const ask = hotspotAsk(hotspot({ latestMs: NOW - 400 * DAY_MS }), context());
        expect(ask.dormant).toBe(true);
        expect(ask.hint).toContain(`13 months`);
        // Still offered, and the prompt is the same one: the git log is evidence, not a veto.
        expect(ask.prompt).toBe(hotspotAsk(hotspot(), context()).prompt);
    });

    it(`counts a file touched inside the horizon as live`, () => {
        expect(hotspotAsk(hotspot({ latestMs: NOW - 89 * DAY_MS }), context()).dormant).toBe(false);
        expect(hotspotAsk(hotspot({ latestMs: NOW - 91 * DAY_MS }), context()).dormant).toBe(true);
    });

    it(`quotes the row's own figures, and the window they were counted over`, () => {
        const ask = hotspotAsk(hotspot({ path: `_editor/web/src/App.vue`, commits: 12 }), context({ rank: 3, window: `30d` }));
        expect(ask.prompt).toContain(`Refactor _editor/web/src/App.vue.`);
        expect(ask.prompt).toContain(`#3 hotspot in this repository — 12 commits in the last 30 days, +4,120/-1,877 lines, 200 branch points.`);
        // The check it ends on names the file, so the agent can recount instead of declaring victory.
        expect(ask.prompt).toContain(`\`iq hotspots --in _editor/web/src/App.vue\``);
    });

    it(`survives a degenerate ranking rather than dividing by zero`, () => {
        const ask = hotspotAsk(hotspot({ commits: 0, complexity: 0 }), context({ leader: { commits: 0, complexity: 0 } }));
        expect(ask.kind).toBe(`decompose`);
    });
});

describe(`moduleAsk`, () => {
    it(`offers nothing for a healthy chokepoint`, () => {
        // The shape you want: everything imports it, and it exports four things.
        expect(moduleAsk({ path: `src/index.ts`, exports: 4 }, { rank: 1, medianExports: 1 })).toBeUndefined();
    });

    it(`offers nothing for a module merely as wide as its peers`, () => {
        expect(moduleAsk({ path: `src/api.ts`, exports: 60 }, { rank: 2, medianExports: 40 })).toBeUndefined();
    });

    it(`asks to narrow a surface that dwarfs the ranking it sits in`, () => {
        const ask = moduleAsk({ path: `_libs/contract/src/schemas.ts`, exports: 428 }, { rank: 2, medianExports: 21 });
        expect(ask?.kind).toBe(`narrow`);
        expect(ask?.prompt).toContain(`#2 key module by PageRank — 428 exports against a median of 21 across that ranking.`);
        expect(ask?.dormant).toBe(false);
    });

    it(`keeps the floor above a surface no reader would call wide`, () => {
        // Three times a median of 5 is 15 — legible in one screen, so the surface is not the finding.
        expect(moduleAsk({ path: `src/util.ts`, exports: 15 }, { rank: 1, medianExports: 5 })).toBeUndefined();
        expect(moduleAsk({ path: `src/util.ts`, exports: 21 }, { rank: 1, medianExports: 5 })?.kind).toBe(`narrow`);
    });
});

describe(`every prompt`, () => {
    const asks = [
        hotspotAsk(hotspot(), context()),
        hotspotAsk(hotspot({ commits: 5 }), context()),
        hotspotAsk(hotspot({ complexity: 20 }), context()),
        hotspotAsk(hotspot(), context({ keyModule: true })),
        hotspotAsk(hotspot({ path: `src/thing.test.ts` }), context()),
        moduleAsk({ path: `src/schemas.ts`, exports: 428 }, { rank: 1, medianExports: 21 })!,
    ];

    it(`names the file first, states the invariants, and stays short enough to be read`, () => {
        for (const ask of asks) {
            expect(ask.prompt.startsWith(`Refactor `)).toBe(true);
            expect(ask.prompt).toContain(`Behaviour stays identical`);
            expect(ask.prompt).toContain(`no re-export shims`);
            expect(ask.prompt).toContain(`Done when`);
            // A prompt the model skims is a prompt whose load-bearing sentences got diluted.
            expect(ask.prompt.split(/\s+/).length).toBeLessThan(120);
        }
    });

    it(`prescribes no design and pastes no code — the agent reads the file itself`, () => {
        for (const ask of asks) {
            expect(ask.prompt).toContain(`Read it first.`);
            expect(ask.prompt).not.toContain(`\n\`\`\``);
        }
    });

    it(`leaves no unfilled placeholder in the check it ends on`, () => {
        for (const ask of asks) {
            expect(ask.prompt).not.toContain(`<path>`);
        }
    });
});
